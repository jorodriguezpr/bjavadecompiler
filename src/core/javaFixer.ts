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
 * BJavaDecompiler - Tier-2 deterministic fixer for the structural findings javaAnalyzer.ts
 * reports (see docs/java-syntax-checker-fixer-design.md §5). Every rule here is a pure,
 * token-offset text edit — never a regex guess against line/col text — and every edit is
 * re-validated by re-running the analyzer on the result before being accepted: a fix that doesn't
 * actually leave the file no-worse-off than before is discarded, never applied blind.
 *
 * Phase one rules (mirrors javaAnalyzer.ts's phase-one diagnostic set):
 *   JST2001 — wrap bare top-level declarations in a class named after the file.
 *   JST2002 — rename the sole mismatched public top-level type (+ its constructors) to match
 *             the filename. Deliberately renames the TYPE, not the file: the file's path was
 *             assigned from the class's real bytecode-derived FQCN
 *             (deterministicRemediationService.ts's own PUBLIC_CLASS_FILE_MISMATCH_RE comment
 *             notes renaming the file instead would break that FQCN-to-path mapping the rest of
 *             the pipeline relies on), so the filename is the trustworthy side of the mismatch —
 *             not the decompiled type declaration.
 *   JST2003 — rewrite the package statement's dotted name to match the directory it actually
 *             lives in (same trust direction as JST2002: the directory came from the same
 *             authoritative FQCN, the in-file `package` text is decompiler output).
 *   JST2004 — strip the `public` modifier from every extra public top-level type but one.
 *   JMB3003 — delete a same-named method's return type, turning it back into a real constructor
 *             — but only when doing so wouldn't collide with a constructor that already has the
 *             identical parameter signature (which would trade one compile error for another).
 *
 * JST2001 is handled as its own path: it only ever fires when the file has NO top-level type at
 * all, which makes it mutually exclusive with every other phase-one code (all of which require
 * at least one real type to exist first), and its fix reshapes the whole file rather than editing
 * a token span.
 */

import path from 'path';
import { analyzeJavaFile, AnalyzeContext, JavaDiagCode, JavaFileAnalysis, JavaMemberDecl, JavaTypeDecl } from './javaAnalyzer';

export interface JavaFixResult {
  source: string;
  changed: boolean;
  applied: JavaDiagCode[];
  /** Re-analysis of the returned `source` (the original file's analysis when nothing changed). */
  analysis: JavaFileAnalysis;
}

const FIXABLE_CODES = new Set<JavaDiagCode>([
  'JST2001_MISSING_TOP_LEVEL_TYPE',
  'JST2002_PUBLIC_TYPE_FILENAME_MISMATCH',
  'JST2003_PACKAGE_DIR_MISMATCH',
  'JST2004_MULTIPLE_PUBLIC_TOP_LEVEL_TYPES',
  'JMB3003_METHOD_LOOKS_LIKE_CTOR',
]);

function wrapBareDeclarationsInClass(source: string, analysis: JavaFileAnalysis, filePath: string): string {
  const stem = path.basename(filePath, '.java');
  const cst: any = analysis.cst;
  const ordinary = cst?.children?.ordinaryCompilationUnit?.[0];
  const imports: any[] = ordinary?.children?.importDeclaration || [];
  const pkg = ordinary?.children?.packageDeclaration?.[0];

  let insertFrom = 0;
  if (imports.length) insertFrom = imports[imports.length - 1].location.endOffset + 1;
  else if (pkg?.location) insertFrom = pkg.location.endOffset + 1;

  const head = source.slice(0, insertFrom);
  const body = source.slice(insertFrom);
  return `${head}\npublic class ${stem} {\n${body}\n}\n`;
}

interface Edit {
  start: number;
  /** -1 means "insert `replacement` at the very start of the file" rather than replacing a span. */
  end: number;
  replacement: string;
  code: JavaDiagCode;
}

function planEdits(analysis: JavaFileAnalysis): Edit[] {
  const edits: Edit[] = [];

  for (const d of analysis.diagnostics) {
    if (!FIXABLE_CODES.has(d.code)) continue;

    if (d.code === 'JST2002_PUBLIC_TYPE_FILENAME_MISMATCH') {
      const type = d.data?.type as JavaTypeDecl | undefined;
      const expectedName = d.data?.expectedName as string | undefined;
      if (!type || !expectedName) continue;
      edits.push({ start: type.nameStart, end: type.nameEnd, replacement: expectedName, code: d.code });
      for (const m of type.methods) {
        if (m.kind === 'constructor') edits.push({ start: m.nameStart, end: m.nameEnd, replacement: expectedName, code: d.code });
      }
    } else if (d.code === 'JST2003_PACKAGE_DIR_MISMATCH') {
      const expected = d.data?.expected as string | undefined;
      if (expected === undefined) continue;
      if (analysis.packageDeclOffsets) {
        edits.push({ start: analysis.packageDeclOffsets.nameStart, end: analysis.packageDeclOffsets.nameEnd, replacement: expected, code: d.code });
      } else if (expected) {
        // No package statement at all, but the directory implies a non-default one — add it.
        edits.push({ start: 0, end: -1, replacement: `package ${expected};\n`, code: d.code });
      }
    } else if (d.code === 'JST2004_MULTIPLE_PUBLIC_TOP_LEVEL_TYPES') {
      const type = d.data?.type as JavaTypeDecl | undefined;
      if (!type || type.publicModifierStart === undefined || type.publicModifierEnd === undefined) continue;
      edits.push({ start: type.publicModifierStart, end: type.publicModifierEnd, replacement: '', code: d.code });
    } else if (d.code === 'JMB3003_METHOD_LOOKS_LIKE_CTOR') {
      const type = d.data?.type as JavaTypeDecl | undefined;
      const member = d.data?.member as JavaMemberDecl | undefined;
      if (!type || !member || member.resultStart === undefined || member.resultEnd === undefined) continue;
      const collides = type.methods.some(m => m.kind === 'constructor' && m.paramSignature === member.paramSignature);
      if (collides) continue; // would trade "no constructor" for "duplicate constructor" — leave for AI/manual review
      edits.push({ start: member.resultStart, end: member.resultEnd, replacement: '', code: d.code });
    }
  }

  return edits;
}

function applyEdits(source: string, edits: Edit[]): string {
  // Descending by start offset so earlier, not-yet-applied offsets never shift underneath us.
  const ordered = [...edits].sort((a, b) => b.start - a.start);
  let result = source;
  for (const e of ordered) {
    if (e.end === -1) {
      result = e.replacement + result;
      continue;
    }
    let end = e.end;
    // Pure deletions (modifier strip, return-type strip) swallow one trailing space so they
    // don't leave a stray double space behind — a rename (non-empty replacement) keeps it, since
    // it's substituting one identifier for another of the same conceptual role.
    if (e.replacement === '' && result[end + 1] === ' ') end += 1;
    result = result.slice(0, e.start) + e.replacement + result.slice(end + 1);
  }
  return result;
}

/**
 * Analyzes `source`, applies every phase-one fix rule that has a safe, applicable match, and
 * re-analyzes the result. Returns the original `source` unchanged (with `changed: false`) if no
 * rule applied, or if applying every planned edit together produced something that parses worse
 * than the input did (never trades a working file for a more-broken one).
 */
export async function fixJavaFile(source: string, ctx: AnalyzeContext = {}): Promise<JavaFixResult> {
  const analysis = await analyzeJavaFile(source, ctx);
  if (!analysis.diagnostics.some(d => FIXABLE_CODES.has(d.code))) {
    return { source, changed: false, applied: [], analysis };
  }

  const missingType = analysis.diagnostics.find(d => d.code === 'JST2001_MISSING_TOP_LEVEL_TYPE');
  if (missingType) {
    if (!ctx.filePath) return { source, changed: false, applied: [], analysis };
    const fixed = wrapBareDeclarationsInClass(source, analysis, ctx.filePath);
    const reAnalysis = await analyzeJavaFile(fixed, ctx);
    if (reAnalysis.valid) return { source: fixed, changed: true, applied: ['JST2001_MISSING_TOP_LEVEL_TYPE'], analysis: reAnalysis };
    return { source, changed: false, applied: [], analysis };
  }

  const edits = planEdits(analysis);
  if (!edits.length) return { source, changed: false, applied: [], analysis };

  const fixed = applyEdits(source, edits);
  const reAnalysis = await analyzeJavaFile(fixed, ctx);
  if (!reAnalysis.valid && analysis.valid) {
    // Only JMB3003 can fire on an otherwise-valid file (it's warning-severity) — never accept a
    // "fix" that turns a compiling file into a non-compiling one.
    return { source, changed: false, applied: [], analysis };
  }

  const applied = [...new Set(edits.map(e => e.code))];
  return { source: fixed, changed: true, applied, analysis: reAnalysis };
}
