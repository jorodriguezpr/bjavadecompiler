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
 * BJavaDecompiler - Stage 7 (part 2): AI-assisted build-error remediation.
 *
 * One remediation pass given a failed `mvn compile` result: classifies each failing file's
 * errors as either a likely dependency-resolution problem (missing-symbol errors — cheaper to
 * re-attempt resolution for than to spend an AI call on source that isn't the real issue) or a
 * genuine decompiler-artifact syntax problem (sent to the AI with that file's current source +
 * its specific error lines only — tight context, not the batch context from Stage 5). The
 * whole-loop attempt cap (MAX_BUILD_FIX_ATTEMPTS) lives in decompileJobService.ts, which calls
 * this once per verify-fix cycle, not per file.
 */

import fs from 'fs';
import path from 'path';
import { Logger } from '../core/logger';
import { AIProvider } from '../core/aiProvider';
import { MavenRunResult } from './mavenVerifyService';
import { stripDuplicateJumpStatements } from './decompilerArtifactCleanup';
import { checkJavaSyntax } from '../core/javaSyntaxCheck';
import { detectVariableConflicts, formatConflictDiagnostics } from './variableConflictDetector';
import { ProjectSymbolTable, classHasFullDebugInfo } from './bytecodeMetadataService';

const logger = Logger.getLogger('AiRemediationService');

const MISSING_SYMBOL_RE = /cannot find symbol|package .* does not exist|cannot access/i;

export interface RemediationOutcome {
  /** File paths that look like a dependency problem, not a source problem — caller should
   * re-attempt dependency resolution for these before spending another AI call. */
  likelyDependencyIssue: string[];
  /** Files the AI attempted to fix (successfully parsed a replacement — not a guarantee it
   * actually compiles, that's re-verified on the next loop iteration). */
  fixed: string[];
  /** Files where the AI call failed or returned nothing usable — left unchanged. */
  unfixed: string[];
}

/** javac's "cannot find symbol" always names a symbol *kind* on its own continuation line —
 * `symbol:   class X`, `symbol:   method X()`, `symbol:   variable X`, etc. Only a missing
 * CLASS/INTERFACE symbol can genuinely mean an external type isn't on the classpath at all
 * (a real dependency gap, or a "package ... does not exist" error, which MISSING_SYMBOL_RE also
 * catches). A missing METHOD/VARIABLE/FIELD symbol means javac fully resolved the receiver/scope
 * — the "location:" line names it — and just found no such member there; that's always a decompiler
 * mistyping the receiver's real type (raw-generic erasure to Object, a corrupted local variable
 * slot reused across roles, etc.), fixable in-file, never a missing dependency. Originally this
 * only excluded the single `location: class java.lang.Object` shape; broadened after confirming
 * live that the SAME root cause also surfaces as e.g. `symbol: method getMessage() / location:
 * variable cls of type java.lang.Class<?>` (a known, previously-flagged decompiler artifact from
 * an earlier session) — narrowing to "location is Object" alone still left ~49 of a real WAR's
 * unique errors permanently stuck in `likelyDependencyIssue` (no re-resolution attempt exists for
 * that bucket at all) purely because MISSING_SYMBOL_RE matches "cannot find symbol" on its own. */
const NON_CLASS_SYMBOL_RE = /symbol:\s+(?:method|variable)\b/i;

export function classify(errors: string[]): 'dependency' | 'syntax' {
  return errors.some(e => MISSING_SYMBOL_RE.test(e) && !(/cannot find symbol/i.test(e) && NON_CLASS_SYMBOL_RE.test(e))) ? 'dependency' : 'syntax';
}

/** Maps a `mvn compile` error's file path back to the binary fqcn bytecodeMetadataService.ts's
 * symbol table is keyed on (`src/main/java/com/example/Foo.java` -> `com/example/Foo`). Null for
 * any path outside the project's own java source root. */
function fqcnFromProjectFilePath(filePath: string, projectDir: string): string | null {
  const javaRoot = path.join(projectDir, 'src', 'main', 'java');
  const rel = path.relative(javaRoot, filePath);
  if (rel.startsWith('..')) return null;
  return rel.replace(/\\/g, '/').replace(/\.java$/, '');
}

/** Cheap, error-text-only pattern hints for the specific decompiler-artifact shapes confirmed
 * live to dominate this project's remaining error pool (see the `classify()` fix above for the
 * Object-erasure discovery). No new detection code — just recognizing the same substrings the
 * classifier and existing detectors already key off of, phrased as concrete fix guidance instead
 * of a generic "fix compile errors" instruction, since a generic instruction on a raw-erasure
 * error tends to produce a wrong-type cast or a renamed method call rather than the real fix. */
function buildErrorPatternHints(errors: string[]): string[] {
  const hints: string[] = [];
  if (errors.some(e => /cannot find symbol/i.test(e) && NON_CLASS_SYMBOL_RE.test(e) && /location:\s*class java\.lang\.Object\b/i.test(e))) {
    hints.push(
      '- One or more errors report "location: class java.lang.Object" for a missing method/field.',
      '  This means the decompiler lost a generic type parameter (a raw List/Map/Iterator/etc.),',
      '  so javac sees a plain Object even though the real runtime value has the member being',
      '  called. Fix by casting the expression to its real type at the call site (or introducing a',
      '  correctly-typed local variable first). Infer the real type from how the same value is used',
      '  elsewhere in this file — other calls on it, the field/variable it gets assigned into, the',
      '  collection\'s declared element type if visible anywhere. Do NOT change the method name being',
      '  called, invent a different API, or fall back to a String/Object-only fix that just silences',
      '  the error without it actually being correct.',
    );
  }
  if (errors.some(e => /cannot find symbol/i.test(e) && NON_CLASS_SYMBOL_RE.test(e) && /location:\s*variable \w+ of type java\.lang\.Class<\?>/i.test(e))) {
    hints.push(
      '- One or more errors show a call on a variable the decompiler typed as java.lang.Class<?>',
      '  (e.g. `symbol: method getMessage() / location: variable cls of type java.lang.Class<?>`).',
      '  This is a confirmed decompiler artifact: the JVM reused one local-variable slot for two',
      '  unrelated values (often a caught exception and an unrelated Class reference), and the',
      '  decompiler picked the wrong one\'s declared type. Look at how the variable is actually used',
      '  around that line — if it is really a caught exception (feeds a log/message call, appears in',
      '  a catch block), retype/rename it to the real exception type instead of casting to Class<?>.',
    );
  }
  if (errors.some(e => /incompatible types/i.test(e))) {
    hints.push(
      '- One or more "incompatible types" errors likely share the same raw-generic-erasure root',
      '  cause as above: insert the correct cast at the assignment/argument/return site rather than',
      '  changing the target variable\'s declared type or the surrounding control flow.',
    );
  }
  if (errors.some(e => /has protected access/i.test(e))) {
    hints.push(
      '- A "has protected access" error (commonly Object.clone()) means the code calls an inherited',
      "  member that isn't public from outside its declaring class/package. If this file's own class",
      '  (or another class you can see the full source of in this project) already overrides that',
      '  member as public, cast to that real type before calling it. Only if no public path exists',
      '  anywhere visible to you, remove the call and leave a one-line comment explaining why —',
      '  never widen access on a class whose source you cannot see or are not editing.',
    );
  }
  return hints;
}

function buildPrompt(filePath: string, source: string, errors: string[], provenanceNote: string, conflictDiagnostics: string): string {
  const patternHints = buildErrorPatternHints(errors);
  return [
    'The Java file below fails to compile with the following javac errors:',
    '',
    ...errors.map(e => `- ${e}`),
    '',
    provenanceNote,
    '',
    ...(patternHints.length ? ['Known decompiler-artifact patterns detected in these errors:', ...patternHints, ''] : []),
    ...(conflictDiagnostics
      ? [
          'Additionally, a pre-scan found signs that a single decompiled identifier is standing in',
          'for multiple real variables (the decompiler reused one JVM local-variable slot for',
          'several unrelated variables with different types/roles, since debug info was stripped).',
          'This is a very likely root cause of the errors above — the fix is usually to split the',
          'identifier back into separate, correctly-typed, clearly-named variables, NOT to force one',
          'type onto all of them with casts:',
          conflictDiagnostics,
          '',
        ]
      : []),
    'Fix ONLY what is necessary to make this file compile, preserving its existing behavior and',
    'structure as closely as possible. Do not rename the top-level class or its package. Never add',
    'an import for a type that isn\'t already used elsewhere in this project — if a fix seems to',
    'need one, it is very likely one of the known patterns above instead (a missing cast, not a',
    'missing type). If a method body is already a stub (e.g. throws UnsupportedOperationException',
    'because the original logic could not be decompiled) and none of the reported errors are inside',
    'that specific method, leave it exactly as-is — do not invent business logic. Respond with the',
    'complete corrected file in a single ```java code block and nothing else.',
    '',
    `File: ${filePath}`,
    '```java',
    source,
    '```',
  ].join('\n');
}

function extractCode(content: string): string | null {
  const m = content.match(/```(?:java)?\s*\n([\s\S]*?)```/);
  return m ? m[1] : null;
}

export async function remediate(
  buildResult: MavenRunResult,
  /** fqcn/file-path (as it appears in mvn's error output) -> was this file touched by the AI in Stage 5? */
  aiTouchedFiles: Set<string>,
  symbolTable?: ProjectSymbolTable,
  /** Generated project root — needed to map an error file path back to a binary fqcn for the
   * symbolTable lookup above. Omitted (or a path outside src/main/java) just means the debug-info
   * skip below never applies, not a hard requirement. */
  projectDir?: string,
): Promise<RemediationOutcome> {
  const outcome: RemediationOutcome = { likelyDependencyIssue: [], fixed: [], unfixed: [] };

  if (!AIProvider.isConfigured()) {
    logger.warn('No AI provider configured (set OLLAMA_CLOUD_API_KEY, or AI_PROVIDER=ollama-local/lm-studio for a local install) — cannot run AI remediation, all failing files left as-is.');
    outcome.unfixed = Object.keys(buildResult.errorsByFile);
    return outcome;
  }

  for (const [filePath, errors] of Object.entries(buildResult.errorsByFile)) {
    if (classify(errors) === 'dependency') {
      outcome.likelyDependencyIssue.push(filePath);
      continue;
    }

    if (!fs.existsSync(filePath)) {
      logger.warn(`Remediation target ${filePath} does not exist on disk — skipping.`);
      outcome.unfixed.push(filePath);
      continue;
    }

    const source = fs.readFileSync(filePath, 'utf8');
    const provenanceNote = aiTouchedFiles.has(filePath)
      ? 'Note: this file was already edited by an earlier AI reconstruction pass, which likely caused this error — review that edit carefully.'
      : 'Note: this file has not been AI-edited before; the error most likely comes from the original decompiler output.';
    const fqcn = projectDir ? fqcnFromProjectFilePath(filePath, projectDir) : null;
    const skipConflicts = fqcn ? classHasFullDebugInfo(symbolTable, fqcn) : false;
    const conflictDiagnostics = skipConflicts ? '' : formatConflictDiagnostics(detectVariableConflicts(source));

    try {
      const response = await AIProvider.chatCompletion([
        { role: 'system', content: 'You are an expert Java engineer fixing compile errors in decompiler-generated source.' },
        { role: 'user', content: buildPrompt(filePath, source, errors, provenanceNote, conflictDiagnostics) },
      ]);
      const fixedCode = extractCode(response.content);
      if (fixedCode && fixedCode.trim().length > 0) {
        // Same free, no-AI fixup as decompilerArtifactCleanup.ts applies to raw decompiler
        // output — an LLM fix can duplicate a line the same way a decompiler can.
        const { fixed } = stripDuplicateJumpStatements(fixedCode);
        // Never write a "fix" that doesn't even parse — that's strictly worse than leaving the
        // known-broken original in place (same error, harder to diagnose) and burns an attempt
        // for nothing. Leave the file untouched so the next remediation attempt gets a fresh try.
        const { valid, error } = await checkJavaSyntax(fixed);
        if (valid) {
          fs.writeFileSync(filePath, fixed, 'utf8');
          outcome.fixed.push(filePath);
        } else {
          outcome.unfixed.push(filePath);
          logger.warn(`AI fix for ${filePath} doesn't parse as valid Java (${error}) — leaving the file unchanged.`);
        }
      } else {
        outcome.unfixed.push(filePath);
      }
    } catch (err: any) {
      logger.error(`Remediation call failed for ${filePath}: ${err.message}`);
      outcome.unfixed.push(filePath);
    }
  }

  return outcome;
}
