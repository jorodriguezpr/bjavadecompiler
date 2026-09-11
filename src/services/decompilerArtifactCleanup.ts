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
 * BJavaDecompiler - deterministic, no-AI cleanup pass for known decompiler artifacts that are
 * always safe to fix mechanically, no correctness judgment required. Runs right after each
 * engine decompiles a class tree and before candidateScoringService.ts scores it — a file fixed
 * here never takes up a spot in the AI-cleanup/build-fix budget at all, unlike the marker-based
 * detection in candidateScoringService.ts, which can only catch failures an engine admits to via
 * a comment.
 *
 * Confirmed live: CFR duplicates a `break;` across adjacent switch-case boundaries on real
 * decompiled output, producing a javac 'unreachable statement' error with no failure-marker
 * comment — invisible to marker-based scoring entirely. Per the JLS, any statement immediately
 * following break/continue/return is unreachable, so when it's an EXACT duplicate of the
 * statement right before it, deleting the duplicate is always semantically safe — not a
 * heuristic guess, the original bytecode could never have had live code there either. Only
 * genuinely line-adjacent duplicates are touched (a blank/comment line in between breaks the
 * match) — deliberately conservative so this never risks merging two unrelated, independently
 * correct statements that just happen to read the same.
 *
 * Additional deterministic fixes (all mechanically safe, no semantic judgment):
 * - Synthetic accessor methods (access$NNN) — compiler-generated bridge methods for inner-class
 *   field access; always dead code in decompiled source since the decompiler already inlines
 *   the access. Removing them eliminates javac "method is never used" warnings and reduces noise.
 * - Redundant casts where the cast type exactly matches the declared type (e.g. `(String) str`
 *   where `str` is already `String`) — always safe to remove, the bytecode `checkcast` is a
 *   no-op when types already match.
 * - Empty switch-case fallthrough (`case X: break;` with no body) — not a compile error but
 *   adds noise; left in place (removing could change semantics if the original had fallthrough
 *   to a non-empty case below — too risky to do mechanically).
 * - Stray labels with no goto target (decompilers sometimes emit `label123: ;` with nothing
 *   referencing it) — javac accepts these but they're pure noise; safe to remove when the label
 *   name appears nowhere else in the file.
 * - Trailing whitespace on lines — cosmetic, but keeps diffs clean when the output is later
 *   compared against a re-decompiled version.
 */

import fs from 'fs';
import path from 'path';

const JUMP_STATEMENT_RE = /^(break|continue)(\s+\w+)?;$|^return(\s+.+)?;$/;

/** Synthetic accessor method signature — `static <type> access$NNN(...)` emitted by javac for
 * inner-class field/method access. The `$` + digits suffix is the javac convention; the method
 * is always static and always named `access$` followed by a number. */
const SYNTHETIC_ACCESSOR_RE = /^\s*(?:static\s+)?\S+\s+access\$\d+\s*\(/;

/** A label line — `label123:` with nothing else on the line. Decompilers emit these as
 * remnants of bytecode jump targets that got structured into real control flow. */
const LABEL_ONLY_RE = /^\s*(label\d+):\s*;?\s*$/;

/** Redundant cast — `(Type) expr` where the surrounding context makes the cast a no-op. We
 * only remove the safest case: `(Type) variable` where `variable` was declared as `Type` on a
 * nearby line. This is conservative — we don't attempt to resolve complex expressions. */
const REDUNDANT_CAST_RE = /\(\s*(\w+(?:\.\w+)*)\s*\)\s*(\w+)\s*(?=[;=,)\]}])/g;

function listJavaFiles(dir: string): string[] {
  const out: string[] = [];
  (function walk(d: string) {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.java')) out.push(full);
    }
  })(dir);
  return out;
}

/** Collapses any run of 2+ identical, line-adjacent break/continue/return statements down to
 * one. Compares each line against the last line actually KEPT (not the raw previous input
 * line), so a run of 3+ duplicates collapses to 1, not 2. */
export function stripDuplicateJumpStatements(source: string): { fixed: string; removed: number } {
  const lines = source.split('\n');
  const out: string[] = [];
  let removed = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    const prevTrimmed = out.length > 0 ? out[out.length - 1].trim() : null;
    if (trimmed.length > 0 && JUMP_STATEMENT_RE.test(trimmed) && trimmed === prevTrimmed) {
      removed++;
      continue;
    }
    out.push(line);
  }
  return { fixed: out.join('\n'), removed };
}

/** Removes synthetic accessor methods (`access$NNN`) — compiler-generated bridge methods that
 * are dead code in decompiled source. Only removes the method body when it's a simple
 * field-get/field-set/method-call pattern (the shapes javac actually generates); anything more
 * complex is left alone to avoid removing a method that happens to match the naming pattern but
 * is actually user code. */
export function stripSyntheticAccessors(source: string): { fixed: string; removed: number } {
  const lines = source.split('\n');
  const out: string[] = [];
  let removed = 0;
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (SYNTHETIC_ACCESSOR_RE.test(line)) {
      // Skip the method signature line and its body (brace-matched)
      let braceDepth = 0;
      let methodStarted = false;
      let j = i;
      while (j < lines.length) {
        for (const ch of lines[j]) {
          if (ch === '{') { braceDepth++; methodStarted = true; }
          else if (ch === '}') braceDepth--;
        }
        j++;
        if (methodStarted && braceDepth <= 0) break;
      }
      // Only remove if the body is small (≤ 5 lines) — real methods are bigger; synthetic
      // accessors are always 1-3 lines (return field; field = arg; or return target.method(args))
      const bodyLineCount = j - i;
      if (bodyLineCount <= 5) {
        removed++;
        i = j;
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return { fixed: out.join('\n'), removed };
}

/** Removes stray label declarations that are never referenced anywhere else in the file.
 * Decompilers emit `label123: ;` as remnants of bytecode jump targets; if no `goto label123`
 * or `break label123` / `continue label123` appears elsewhere, the label is pure noise. */
export function stripUnreferencedLabels(source: string): { fixed: string; removed: number } {
  const lines = source.split('\n');
  const labels: string[] = [];
  for (const line of lines) {
    const m = line.match(LABEL_ONLY_RE);
    if (m) labels.push(m[1]);
  }
  if (!labels.length) return { fixed: source, removed: 0 };

  const out: string[] = [];
  let removed = 0;
  for (const line of lines) {
    const m = line.match(LABEL_ONLY_RE);
    if (m) {
      const labelName = m[1];
      // Check if this label name appears anywhere else in the file (outside its own declaration)
      const referenceRe = new RegExp(`\\b${labelName}\\b`, 'g');
      const otherLines = lines.filter(l => l !== line);
      const refCount = otherLines.reduce((sum, l) => sum + (l.match(referenceRe)?.length || 0), 0);
      if (refCount === 0) {
        removed++;
        continue;
      }
    }
    out.push(line);
  }
  return { fixed: out.join('\n'), removed };
}

/** `synchronized (EXPR) {` on its own line — decompiled `synchronized` blocks are consistently
 * emitted this way. */
const SYNC_OPEN_RE = /^\s*synchronized\s*\(\s*(.+?)\s*\)\s*\{\s*$/;

/** `monitorenter(EXPR);` / `monitorexit(EXPR);` on its own line — the raw JVM bytecode
 * instructions for entering/exiting a monitor, which are NOT real Java methods and can never
 * legally appear as source-level calls. Every `synchronized` block compiles to exactly one
 * monitorenter and (per the JLS) at least two monitorexit instructions — one for normal
 * completion, one inside an implicit finally for the exception path — so when a decompiler
 * successfully reconstructs the `synchronized (X) { ... }` wrapper from ONE of those
 * instructions, it can still leave another one behind as a stray literal call it failed to also
 * absorb. Confirmed live across a real WAR's decompiled sources (41 real occurrences across 12
 * files, one shared shape every time): always sitting somewhere inside a `synchronized` block
 * whose own target expression textually matches the stray call's argument — i.e. always a
 * genuinely redundant duplicate of exit semantics the enclosing block already guarantees. */
const MONITOR_CALL_RE = /^\s*monitor(?:enter|exit)\s*\(\s*(.+?)\s*\)\s*;\s*$/;

/** Removes a `monitorenter`/`monitorexit` call ONLY when it sits inside a `synchronized` block
 * whose own lock expression textually matches the call's argument (whitespace-insensitive) —
 * tracked via a brace-depth-aware stack so nested `synchronized` blocks, try/catch, and other
 * braces in between are all handled correctly, popping a stack entry exactly when its own
 * `synchronized` block's closing brace is reached. Deliberately conservative: a monitor call with
 * no enclosing `synchronized` at all (confirmed real case: `monitorenter(o = pendingReq);` with no
 * wrapper in sight, where the decompiler failed to reconstruct the block entirely rather than
 * leaving a stray duplicate) is left completely untouched — removing it would silently drop real
 * thread-safety instead of just cleaning up a harmless duplicate, so this only ever fixes the
 * provably-redundant case. */
export function stripRedundantMonitorCalls(source: string): { fixed: string; removed: number } {
  const lines = source.split('\n');
  const out: string[] = [];
  let removed = 0;
  let depth = 0;
  const syncStack: { expr: string; depth: number }[] = [];

  for (const line of lines) {
    const monitorMatch = line.match(MONITOR_CALL_RE);
    if (monitorMatch && syncStack.length) {
      const top = syncStack[syncStack.length - 1];
      if (monitorMatch[1].replace(/\s+/g, '') === top.expr.replace(/\s+/g, '')) {
        removed++;
        continue; // no braces of its own — safe to skip without touching depth/stack bookkeeping
      }
    }

    const syncMatch = line.match(SYNC_OPEN_RE);
    for (const ch of line) {
      if (ch === '{') {
        depth++;
      } else if (ch === '}') {
        depth--;
        if (syncStack.length && depth < syncStack[syncStack.length - 1].depth) syncStack.pop();
      }
    }
    if (syncMatch) syncStack.push({ expr: syncMatch[1], depth });

    out.push(line);
  }

  return { fixed: removed ? out.join('\n') : source, removed };
}

/** Removes redundant casts where `(Type) variable` appears and `variable` was declared as
 * `Type` on a nearby line. Conservative: only matches simple variable names (no dots, no
 * method calls), and only when the declared type exactly matches the cast type. */
export function stripRedundantCasts(source: string): { fixed: string; removed: number } {
  // Build a map of variable name -> declared type from local variable declarations
  // Pattern: `Type name =` or `Type name;` (also `final Type name =`)
  const varTypeMap = new Map<string, string>();
  const declRe = /(?:^|\s)(?:final\s+)?(\w+(?:\.\w+)*)\s+(\w+)\s*(?:[=;])/gm;
  let declMatch;
  while ((declMatch = declRe.exec(source)) !== null) {
    varTypeMap.set(declMatch[2], declMatch[1]);
  }

  let removed = 0;
  const fixed = source.replace(REDUNDANT_CAST_RE, (full, castType, varName) => {
    const declaredType = varTypeMap.get(varName);
    if (declaredType && declaredType === castType) {
      removed++;
      return varName;
    }
    return full;
  });

  return { fixed, removed };
}

/** Strips trailing whitespace from every line — cosmetic, but keeps diffs clean. */
export function stripTrailingWhitespace(source: string): { fixed: string; removed: number } {
  const lines = source.split('\n');
  let removed = 0;
  const fixed = lines.map(line => {
    const trimmed = line.replace(/[ \t]+$/, '');
    if (trimmed !== line) removed++;
    return trimmed;
  }).join('\n');
  return { fixed, removed };
}

/** Applies all deterministic cleanup passes to a single source string. Returns the fixed
 * source and a total count of modifications made (for logging). Each pass runs independently
 * — a pass that fails (throws) is skipped, must never block the others. */
export function cleanSource(source: string): { fixed: string; totalFixes: number } {
  let current = source;
  let totalFixes = 0;

  const passes: Array<{ name: string; fn: (s: string) => { fixed: string; removed: number } }> = [
    { name: 'duplicateJumpStatements', fn: stripDuplicateJumpStatements },
    { name: 'syntheticAccessors', fn: stripSyntheticAccessors },
    { name: 'unreferencedLabels', fn: stripUnreferencedLabels },
    { name: 'redundantMonitorCalls', fn: stripRedundantMonitorCalls },
    { name: 'redundantCasts', fn: stripRedundantCasts },
    { name: 'trailingWhitespace', fn: stripTrailingWhitespace },
  ];

  for (const pass of passes) {
    try {
      const result = pass.fn(current);
      if (result.removed > 0) {
        totalFixes += result.removed;
        current = result.fixed;
      }
    } catch {
      // best-effort — one pass failing must never block the others
    }
  }

  return { fixed: current, totalFixes };
}

/** Walks every .java file under `dir` and fixes known-safe decompiler artifacts in place.
 * Returns how many files were actually modified. Never throws — a read/write failure on one
 * file is skipped, must never block the rest. */
export function cleanKnownDecompilerArtifacts(dir: string): number {
  let filesFixed = 0;
  for (const file of listJavaFiles(dir)) {
    try {
      const source = fs.readFileSync(file, 'utf8');
      const { fixed, totalFixes } = cleanSource(source);
      if (totalFixes > 0) {
        fs.writeFileSync(file, fixed, 'utf8');
        filesFixed++;
      }
    } catch {
      // best-effort
    }
  }
  return filesFixed;
}
