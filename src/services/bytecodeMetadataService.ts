/**
 * BJavaDecompiler
 * Copyright 2026 Jose Rodriguez <jrpcone@gmail.com>
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *     http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * Developer: Jose Rodriguez <jrpcone@gmail.com>
 */

/**
 * BJavaDecompiler - bytecode metadata extraction (javap-based), Stage 3b.
 *
 * Mines facts directly from the ORIGINAL .class files — never from decompiled source, which is
 * the whole point: this is ground truth no decompiler's heuristics can get wrong. JDK 17+ is
 * already a hard requirement for this project (see README), so shelling out to `javap` (bundled
 * with every JDK) needs no new external dependency or bundled jar, unlike the five decompiler
 * engines themselves.
 *
 * Three things this enables that were previously impossible from decompiled source alone:
 * 1. Member visibility (public/protected/package/private) — lets aiReconstructionService.ts
 *    restrict renaming to members NOTHING outside the current file/batch could possibly
 *    reference, instead of trusting the AI's own judgment call on every rename it makes.
 * 2. Debug-info completeness (does every method still have a LocalVariableTable?) — when true,
 *    decompiler-recovered variable names are real, not guesses, so variableConflictDetector.ts's
 *    slot-reuse heuristics (which exist specifically to compensate for STRIPPED debug info) would
 *    be pure noise for that class.
 * 3. Declared nested classes (InnerClasses attribute) — the original bytecode's own authoritative
 *    list, independent of whether any given engine chose to inline a nested class into its outer
 *    file or emit it as a separate physical file.
 *
 * Best-effort throughout: a missing `javap`, a malformed .class file, or unparseable output never
 * fails the job — every consumer of this data has a pre-existing, less-precise fallback behavior
 * for when a class simply isn't in the table.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Logger } from '../core/logger';

const logger = Logger.getLogger('BytecodeMetadata');

export type MemberVisibility = 'public' | 'protected' | 'private' | 'package';

export interface MemberInfo {
  name: string;
  descriptor: string;
  kind: 'field' | 'method';
  visibility: MemberVisibility;
}

export interface ClassMetadata {
  /** Binary name, `/`-separated — e.g. com/example/Foo or com/example/Foo$Bar for a nested class. */
  fqcn: string;
  members: MemberInfo[];
  /** True only when every method with a Code attribute retained a LocalVariableTable. False
   * when no method has a Code attribute at all (interfaces/abstract-only) — harmless, since
   * there's no method body for slot-reuse corruption to occur in either way. */
  hasFullDebugInfo: boolean;
}

export interface ProjectSymbolTable {
  /** Keyed by binary fqcn — top-level AND nested classes both present. */
  classes: Record<string, ClassMetadata>;
  /** Top-level fqcn -> nested class fqcns, from each class's own InnerClasses attribute. */
  nestedClassesOf: Record<string, string[]>;
}

const JAVAP_CONCURRENCY = 4;

function runJavap(classFilePath: string): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn('javap', ['-p', '-v', '-s', classFilePath], { windowsHide: true });
    let stdout = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    // Missing/crashed javap -> empty output, treated by callers as "no metadata for this class",
    // never as a pipeline failure — this data is advisory, never load-bearing.
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(stdout));
  });
}

function parseVisibility(flagsLine: string): MemberVisibility {
  if (/\bACC_PUBLIC\b/.test(flagsLine)) return 'public';
  if (/\bACC_PROTECTED\b/.test(flagsLine)) return 'protected';
  if (/\bACC_PRIVATE\b/.test(flagsLine)) return 'private';
  return 'package';
}

/** The method/field name is always the identifier immediately before `(` (methods) or the last
 * whitespace-separated token before the trailing `;` (fields) — true regardless of generics,
 * annotations, or array-typed return/field types, since all of those sit before that point. */
function extractMemberName(declLine: string, isMethod: boolean): string {
  const trimmed = declLine.trim().replace(/;\s*$/, '');
  if (isMethod) {
    const idx = trimmed.indexOf('(');
    if (idx === -1) return trimmed;
    const before = trimmed.slice(0, idx).trim();
    const parts = before.split(/\s+/);
    return parts[parts.length - 1] || before;
  }
  const parts = trimmed.split(/\s+/);
  return parts[parts.length - 1] || trimmed;
}

function findClassBodyRange(lines: string[]): [number, number] {
  const start = lines.findIndex(l => /^\{\s*$/.test(l));
  if (start === -1) return [-1, -1];
  let end = -1;
  for (let i = lines.length - 1; i > start; i--) {
    if (/^\}\s*$/.test(lines[i])) { end = i; break; }
  }
  return [start, end];
}

/** A member declaration line: exactly 2-space indented (javap's fixed convention for direct
 * class members), non-blank, whose very next line is that member's own `descriptor:` line —
 * this is what actually distinguishes a real decl line from any other 2-space-indented text
 * (there isn't any, in practice, but the descriptor check makes the assumption explicit rather
 * than implicit). */
function isMemberDeclLine(lines: string[], i: number): boolean {
  if (!/^ {2}\S/.test(lines[i])) return false;
  const next = lines[i + 1];
  return !!next && /^\s*descriptor:/.test(next);
}

/**
 * Parses a single `javap -p -v -s` invocation's full stdout into a class's member table, debug-
 * info completeness, and declared nested classes. Never throws — unparseable input (empty
 * output, unexpected javap version format) just yields an empty member list, same as a class
 * this function was never able to introspect at all.
 */
export function parseJavapOutput(output: string, fqcnHint: string): { metadata: ClassMetadata; nestedFqcns: string[] } {
  const empty = { metadata: { fqcn: fqcnHint, members: [], hasFullDebugInfo: false }, nestedFqcns: [] };
  if (!output) return empty;

  const lines = output.split('\n');
  const [bodyStart, bodyEnd] = findClassBodyRange(lines);
  if (bodyStart === -1 || bodyEnd === -1) return empty;

  const declIndices: number[] = [];
  for (let i = bodyStart + 1; i < bodyEnd; i++) {
    if (isMemberDeclLine(lines, i)) declIndices.push(i);
  }

  const members: MemberInfo[] = [];
  let methodsWithCode = 0;
  let methodsWithLvt = 0;

  for (let k = 0; k < declIndices.length; k++) {
    const declIdx = declIndices[k];
    const blockEnd = k + 1 < declIndices.length ? declIndices[k + 1] : bodyEnd;
    const block = lines.slice(declIdx, blockEnd);
    const declLine = block[0].trim();
    const descLine = block[1]?.trim() || '';
    if (!descLine.startsWith('descriptor:')) continue;
    const descriptor = descLine.slice('descriptor:'.length).trim();
    const isMethod = descriptor.startsWith('(');
    const flagsLine = block[2]?.trim() || '';
    const visibility = parseVisibility(flagsLine);
    const name = extractMemberName(declLine, isMethod);
    members.push({ name, descriptor, kind: isMethod ? 'method' : 'field', visibility });

    if (isMethod) {
      const hasCode = block.some(l => /^\s*Code:\s*$/.test(l));
      if (hasCode) {
        methodsWithCode++;
        if (block.some(l => /^\s*LocalVariableTable:\s*$/.test(l))) methodsWithLvt++;
      }
    }
  }

  // InnerClasses attribute lives after the class body's own closing brace, e.g.:
  //   InnerClasses:
  //     public static #7= #3 of #2; // Bar=class com/example/Foo$Bar of class com/example/Foo
  // `.match` (not matchAll) deliberately stops at the FIRST "class X" in the trailing comment —
  // that's always the nested class itself; a second one ("of class OUTER"), when present, is
  // never reached.
  const nestedFqcns: string[] = [];
  const innerStart = lines.findIndex((l, i) => i > bodyEnd && /^InnerClasses:\s*$/.test(l));
  if (innerStart !== -1) {
    for (let i = innerStart + 1; i < lines.length; i++) {
      if (!/^\s/.test(lines[i]) || !lines[i].trim()) break; // InnerClasses section ends at the next unindented/blank line
      const m = lines[i].match(/\/\/\s*(?:[\w$]+=)?class\s+([\w./$]+)/);
      if (m) nestedFqcns.push(m[1]);
    }
  }

  return {
    metadata: { fqcn: fqcnHint, members, hasFullDebugInfo: methodsWithCode > 0 && methodsWithLvt === methodsWithCode },
    nestedFqcns,
  };
}

function listClassFiles(classesDir: string): string[] {
  const out: string[] = [];
  (function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.class')) out.push(full);
    }
  })(classesDir);
  return out;
}

function fqcnFromClassFile(classesDir: string, classFile: string): string {
  return path.relative(classesDir, classFile).replace(/\\/g, '/').replace(/\.class$/, '');
}

/**
 * Builds a project-wide symbol table from every .class file under `classesDir` via `javap`, run
 * with bounded concurrency (each invocation is a short-lived subprocess against a single file).
 * Best-effort per class — one unintrospectable file never aborts the rest.
 */
export async function buildProjectSymbolTable(classesDir: string): Promise<ProjectSymbolTable> {
  const files = listClassFiles(classesDir);
  const classes: Record<string, ClassMetadata> = {};
  const nestedClassesOf: Record<string, string[]> = {};

  let idx = 0;
  async function worker() {
    while (idx < files.length) {
      const file = files[idx++];
      const fqcn = fqcnFromClassFile(classesDir, file);
      try {
        const output = await runJavap(file);
        const { metadata, nestedFqcns } = parseJavapOutput(output, fqcn);
        classes[fqcn] = metadata;
        if (nestedFqcns.length && !fqcn.includes('$')) nestedClassesOf[fqcn] = nestedFqcns;
      } catch (err: any) {
        logger.warn(`javap introspection failed for ${fqcn}: ${err.message}`);
      }
    }
  }
  const poolSize = Math.min(JAVAP_CONCURRENCY, files.length) || 1;
  await Promise.all(Array.from({ length: poolSize }, worker));

  return { classes, nestedClassesOf };
}

export function classHasFullDebugInfo(table: ProjectSymbolTable | undefined | null, fqcn: string): boolean {
  return table?.classes[fqcn]?.hasFullDebugInfo === true;
}

export function privateMemberNames(table: ProjectSymbolTable | undefined | null, fqcn: string): string[] {
  const meta = table?.classes[fqcn];
  if (!meta) return [];
  return Array.from(new Set(meta.members.filter(m => m.visibility === 'private').map(m => m.name)));
}

export function nonPrivateMemberNames(table: ProjectSymbolTable | undefined | null, fqcn: string): string[] {
  const meta = table?.classes[fqcn];
  if (!meta) return [];
  return Array.from(new Set(meta.members.filter(m => m.visibility !== 'private').map(m => m.name)));
}
