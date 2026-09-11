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
 * BJavaDecompiler - real Java syntax validation via java-parser (a pure grammar-based Java
 * parser, no classpath/imports needed). Confirmed live against a real broken CFR-decompiled file:
 * rejects it at the exact same line the actual javac compile error reported.
 *
 * This exists because candidateScoringService.ts's failure-marker/brace-imbalance heuristics can
 * both pass a file that is genuinely broken (a decompiler restructuring a try/catch/finally
 * incorrectly usually still balances its braces, and leaves no marker comment at all) — a real
 * parse attempt is the only way to know for certain a candidate will compile syntactically.
 *
 * `checkJavaSyntax()` is now a thin backward-compatible façade over javaAnalyzer.ts's
 * `analyzeJavaFile()` — kept because six call sites across the codebase depend on exactly this
 * `(source: string) => Promise<SyntaxCheckResult>` signature and the `{valid, error}` shape. Since
 * it's called with no AnalyzeContext (no file path), only the checks that don't need one ever
 * fire: JP1000 (parse failure), JST2001/JST2006 (no real top-level type / empty file — this is
 * exactly the old hasRealTopLevelType() check, unchanged in substance), and JST2004 (multiple
 * public top-level types, which needs no file path to detect as *a* problem, only to know which
 * type should have stayed public). JST2002/JST2003 (filename/package-vs-directory) never fire
 * through this façade — they're only reachable via `analyzeJavaFile()` directly, from a caller
 * that has a real file path to check against.
 *
 * New code that wants the richer diagnostics/structure model, or the deterministic fixer, should
 * import analyzeJavaFile()/fixJavaFile() from javaAnalyzer.ts/javaFixer.ts directly instead of
 * this module.
 */

import { analyzeJavaFile } from './javaAnalyzer';

export interface SyntaxCheckResult {
  valid: boolean;
  /** First error-severity diagnostic, formatted as `[line,col] message` and truncated — only
   * present when valid is false. */
  error?: string;
}

/** Cheap relative to an AI call or a real `mvn compile` (typically single-digit milliseconds
 * even for a large class) — safe to run on every candidate, every AI output, unconditionally. */
export async function checkJavaSyntax(source: string): Promise<SyntaxCheckResult> {
  const analysis = await analyzeJavaFile(source);
  if (analysis.valid) return { valid: true };
  const first = analysis.diagnostics.find(d => d.severity === 'error') ?? analysis.diagnostics[0];
  return { valid: false, error: `[${first.line},${first.column}] ${first.message}`.slice(0, 400) };
}
