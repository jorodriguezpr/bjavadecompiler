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
 * BJavaDecompiler - cross-engine method-level patching.
 *
 * When the winning engine's output for a class has a method that doesn't parse or carries a
 * failure marker, but another engine decompiled that SAME method cleanly, we can patch the
 * winner's broken method with the alternative engine's output for just that method — instead
 * of sending the entire class to AI reconstruction or giving up.
 *
 * This is a deterministic, no-AI operation: we're not generating new code, just transplanting
 * a method body from one decompiler's output to another's. The method signature (name +
 * parameter types) is the join key — if two engines agree on a method's signature, the method
 * body is interchangeable at the source level (both are attempting to decompile the same
 * bytecode method, so the semantics are the same even if the surface syntax differs).
 *
 * Safety: the transplanted method body is syntax-checked before being accepted. If the
 * replacement doesn't parse, the original is kept. The method's signature (modifiers, return
 * type, name, parameters, throws clause) is always taken from the WINNER, not the donor — only
 * the body (statements between `{` and `}`) is transplanted. This ensures the class's API
 * surface stays consistent with what the winning engine produced.
 */

import fs from 'fs';
import path from 'path';
import { Logger } from '../core/logger';
import { DecompilerEngine, ClassCandidate } from '../models/job';
import { findFailureMarkers } from './candidateScoringService';
import { checkJavaSyntax } from '../core/javaSyntaxCheck';

const logger = Logger.getLogger('MethodPatcher');

// ─── Method extraction ─────────────────────────────────────────────────

export interface MethodInfo {
  /** The method signature: modifiers + return type + name + params + throws clause. */
  signature: string;
  /** The method body: everything between the outermost `{` and `}`. */
  body: string;
  /** The full method text as it appears in the source (signature + body). */
  fullText: string;
  /** Start line index (0-based) in the source. */
  startLine: number;
  /** End line index (0-based, inclusive) in the source. */
  endLine: number;
  /** A normalized key for matching methods across engines: `name(paramType1,paramType2)`. */
  key: string;
}

/** Normalizes a type string for method key matching: removes generics, wildcards, and
 * array notation to get a simple comparable form. */
function normalizeType(type: string): string {
  return type
    .replace(/<[^>]*>/g, '') // strip generics
    .replace(/\[\s*\]/g, '[]') // normalize array notation
    .replace(/\?\s+extends\s+/g, '') // strip wildcards
    .replace(/\?\s+super\s+/g, '')
    .trim();
}

/** Extracts a method key from a signature: `name(paramType1,paramType2)`.
 * Used to match the same method across different engines' output. */
function extractMethodKey(signature: string): string | null {
  // Match the method name and parameter list from the signature
  // The method name is the last identifier before the `(`
  const match = signature.match(/\b(\w+)\s*\(([^)]*)\)/);
  if (!match) return null;

  const name = match[1];
  const paramsStr = match[2].trim();

  if (!paramsStr) return `${name}()`;

  // Split parameters by comma (top-level only — don't split inside generics)
  const params: string[] = [];
  let depth = 0;
  let current = '';
  for (const ch of paramsStr) {
    if (ch === '<' || ch === '(') depth++;
    else if (ch === '>' || ch === ')') depth--;
    if (ch === ',' && depth === 0) {
      params.push(current.trim());
      current = '';
    } else {
      current += ch;
    }
  }
  if (current.trim()) params.push(current.trim());

  // Extract just the type from each parameter (last identifier is the param name)
  const paramTypes = params.map(p => {
    const parts = p.trim().split(/\s+/);
    // The last part is the parameter name; everything before is the type
    // Handle `final` modifier and annotations
    const typeParts = parts.slice(0, -1).filter(p => p !== 'final' && !p.startsWith('@'));
    return normalizeType(typeParts.join(' '));
  });

  return `${name}(${paramTypes.join(',')})`;
}

/** Extracts all methods from a Java source file. Returns them in source order.
 * Handles class/interface/enum declarations, nested classes, and methods with annotations. */
export function extractMethods(source: string): MethodInfo[] {
  const lines = source.split('\n');
  const methods: MethodInfo[] = [];

  let i = 0;
  while (i < lines.length) {
    // Look for a line that looks like a method signature followed by `{`
    // Skip imports, package declarations, field declarations, and class/interface headers
    const line = lines[i];
    const trimmed = line.trim();

    // Skip comments, blank lines, annotations, package/import
    if (!trimmed || trimmed.startsWith('//') || trimmed.startsWith('*') || trimmed.startsWith('/*') ||
        trimmed.startsWith('@') || trimmed.startsWith('package ') || trimmed.startsWith('import ')) {
      i++;
      continue;
    }

    // Check if this line (possibly with the next) looks like a method declaration
    // A method signature has: [modifiers] returnType name(params) [throws ...] {
    // We look for the pattern: ... name(...) ... {
    // where name is an identifier followed by ( and the line eventually leads to {
    const methodMatch = matchMethodSignature(lines, i);

    if (methodMatch) {
      const { signatureEndLine, signature } = methodMatch;

      // Find the method body (brace-matched, starting from the line with `{`)
      let braceStart = signatureEndLine;
      // The `{` might be on the same line as the signature or a later line
      let braceDepth = 0;
      let bodyStart = -1;
      let bodyEnd = -1;
      let j = braceStart;

      while (j < lines.length) {
        for (let c = 0; c < lines[j].length; c++) {
          const ch = lines[j][c];
          if (ch === '{') {
            if (bodyStart === -1) bodyStart = j;
            braceDepth++;
          } else if (ch === '}') {
            braceDepth--;
            if (braceDepth === 0) {
              bodyEnd = j;
              break;
            }
          }
        }
        if (bodyEnd !== -1) break;
        j++;
      }

      if (bodyStart !== -1 && bodyEnd !== -1) {
        const fullText = lines.slice(i, bodyEnd + 1).join('\n');
        const body = lines.slice(bodyStart, bodyEnd + 1).join('\n');
        const key = extractMethodKey(signature);

        if (key) {
          methods.push({
            signature,
            body,
            fullText,
            startLine: i,
            endLine: bodyEnd,
            key,
          });
        }

        i = bodyEnd + 1;
        continue;
      }
    }

    i++;
  }

  return methods;
}

/** Attempts to match a method signature starting at line `startLineIndex`. Returns the
 * signature text and the line index where the signature ends (the line containing `{`), or
 * null if this doesn't look like a method. */
function matchMethodSignature(lines: string[], startLineIndex: number): { signature: string; signatureEndLine: number } | null {
  // Collect lines until we find `{` or reach a reasonable limit (5 lines for annotations + signature)
  const collected: string[] = [];
  let endLine = startLineIndex;

  for (let i = startLineIndex; i < Math.min(lines.length, startLineIndex + 10); i++) {
    collected.push(lines[i]);
    endLine = i;
    if (lines[i].includes('{')) break;
    // If we hit a `;` before a `{`, it's not a method (it's a field or abstract method)
    if (lines[i].includes(';') && !lines[i].includes('{')) return null;
  }

  const signatureText = collected.join('\n').trim();

  // Must have `identifier(...)` pattern — a method name followed by parameters
  // And must end with `{` (possibly with throws clause or annotations in between)
  if (!/\w+\s*\([^)]*\)/.test(signatureText)) return null;
  if (!signatureText.includes('{')) return null;

  // Exclude class/interface/enum declarations — they also have `{` but aren't methods
  // A class declaration: `class Foo {` or `interface Foo {` or `enum Foo {`
  // A method has a return type (or is a constructor) and parameters in `()`
  if (/\b(class|interface|enum)\s+\w+/.test(signatureText)) return null;

  // Extract just the signature (everything before the first `{`)
  const braceIdx = signatureText.indexOf('{');
  const signature = signatureText.slice(0, braceIdx).trim();

  return { signature, signatureEndLine: endLine };
}

// ─── Method patching ───────────────────────────────────────────────────

/** Finds methods in the winner's output that have failure markers or don't parse, and
 * attempts to patch them with the corresponding method from a donor engine's output.
 * Returns the patched source and a count of methods patched. */
export async function patchBrokenMethods(
  winnerSource: string,
  winnerEngine: DecompilerEngine,
  donorSources: Map<DecompilerEngine, string>,
): Promise<{ fixed: string; patchedCount: number }> {
  const winnerMethods = extractMethods(winnerSource);
  if (!winnerMethods.length) return { fixed: winnerSource, patchedCount: 0 };

  // Collect all donor methods, indexed by method key
  const donorMethodsByKey = new Map<string, { engine: DecompilerEngine; method: MethodInfo }>();
  for (const [engine, source] of donorSources.entries()) {
    if (engine === winnerEngine) continue;
    const methods = extractMethods(source);
    for (const method of methods) {
      // Only keep the first donor for each key — if multiple engines have the method,
      // prefer the one from the engine that's earliest in our priority order
      if (!donorMethodsByKey.has(method.key)) {
        donorMethodsByKey.set(method.key, { engine, method });
      }
    }
  }

  if (!donorMethodsByKey.size) return { fixed: winnerSource, patchedCount: 0 };

  // Identify broken methods in the winner
  const brokenMethods: MethodInfo[] = [];
  for (const method of winnerMethods) {
    const markers = findFailureMarkers(winnerEngine, method.body);
    if (markers.length > 0) {
      brokenMethods.push(method);
      continue;
    }
    // Also check if the method body parses on its own
    // Wrap in a minimal class to make it valid for the parser
    const testSource = `class __Test__ { ${method.body} }`;
    const { valid } = await checkJavaSyntax(testSource);
    if (!valid) {
      brokenMethods.push(method);
    }
  }

  if (!brokenMethods.length) return { fixed: winnerSource, patchedCount: 0 };

  // Patch broken methods with donor bodies
  let patchedCount = 0;
  const lines = winnerSource.split('\n');

  // Process from bottom to top so line indices don't shift
  const sortedBroken = [...brokenMethods].sort((a, b) => b.startLine - a.startLine);

  for (const broken of sortedBroken) {
    const donor = donorMethodsByKey.get(broken.key);
    if (!donor) continue;

    // Verify the donor method body parses before transplanting
    const donorTestSource = `class __Test__ { ${donor.method.body} }`;
    const { valid: donorValid } = await checkJavaSyntax(donorTestSource);
    if (!donorValid) continue;

    // Replace the broken method's body with the donor's body
    // Keep the winner's signature, just swap the body
    const winnerBodyStart = lines.slice(broken.startLine, broken.endLine + 1).join('\n').indexOf('{');
    if (winnerBodyStart === -1) continue;

    // Reconstruct: winner's signature + donor's body
    const winnerFullText = lines.slice(broken.startLine, broken.endLine + 1).join('\n');
    const braceIdx = winnerFullText.indexOf('{');
    const winnerSignature = winnerFullText.slice(0, braceIdx);

    // The donor body includes the outer braces — extract just the content
    const donorBodyContent = donor.method.body;
    // donor.method.body starts with `{` and ends with `}` — keep them

    const patchedMethod = winnerSignature + donorBodyContent;

    // Verify the full patched method parses
    const patchedTestSource = `class __Test__ { ${patchedMethod} }`;
    const { valid: patchedValid } = await checkJavaSyntax(patchedTestSource);
    if (!patchedValid) {
      logger.debug(`Patched method ${broken.key} doesn't parse — keeping original from ${winnerEngine}`);
      continue;
    }

    // Replace the lines in the source
    const patchedLines = patchedMethod.split('\n');
    lines.splice(broken.startLine, broken.endLine - broken.startLine + 1, ...patchedLines);
    patchedCount++;
    logger.debug(`Patched method ${broken.key} in ${winnerEngine} output with ${donor.engine} body`);
  }

  if (patchedCount === 0) return { fixed: winnerSource, patchedCount: 0 };

  const fixed = lines.join('\n');

  // Final sanity check — the whole file should still parse
  const { valid: fileValid } = await checkJavaSyntax(fixed);
  if (!fileValid) {
    logger.warn(`Method patching produced invalid source — keeping original from ${winnerEngine}`);
    return { fixed: winnerSource, patchedCount: 0 };
  }

  return { fixed, patchedCount };
}

/** Runs method-level patching across all candidates. For each class where the winning engine
 * has broken methods, attempts to patch them from other engines' output. Writes the patched
 * source to the output directory. Returns a summary count. */
export async function patchAllBrokenMethods(
  candidates: ClassCandidate[],
  engineDirs: Partial<Record<DecompilerEngine, string>>,
  outputDir: string,
): Promise<{ patchedFiles: number; patchedMethods: number }> {
  let patchedFiles = 0;
  let patchedMethods = 0;

  for (const candidate of candidates) {
    if (!candidate.winningEngine) continue;

    // Only patch classes that need AI reconstruction (have markers or don't parse)
    // — clean classes don't need patching
    const winnerDir = engineDirs[candidate.winningEngine];
    if (!winnerDir) continue;

    const winnerPath = path.join(winnerDir, `${candidate.fqcn}.java`);
    if (!fs.existsSync(winnerPath)) continue;

    const winnerSource = fs.readFileSync(winnerPath, 'utf8');

    // Collect donor sources from other engines
    const donorSources = new Map<DecompilerEngine, string>();
    for (const [engine, dir] of Object.entries(engineDirs)) {
      if (engine === candidate.winningEngine) continue;
      const donorPath = path.join(dir!, `${candidate.fqcn}.java`);
      if (fs.existsSync(donorPath)) {
        donorSources.set(engine as DecompilerEngine, fs.readFileSync(donorPath, 'utf8'));
      }
    }

    if (!donorSources.size) continue;

    const { fixed, patchedCount } = await patchBrokenMethods(winnerSource, candidate.winningEngine, donorSources);
    if (patchedCount > 0) {
      patchedFiles++;
      patchedMethods += patchedCount;

      // Write the patched source to the output directory
      const dest = path.join(outputDir, `${candidate.fqcn}.java`);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, fixed, 'utf8');

      // Update the candidate's status — if all broken methods were patched, it may no longer
      // need AI reconstruction. The caller (aiReconstructionService.ts) will re-check.
      logger.info(`Patched ${patchedCount} method(s) in ${candidate.fqcn} from donor engines`);
    }
  }

  return { patchedFiles, patchedMethods };
}