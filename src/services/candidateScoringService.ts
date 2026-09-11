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
 * BJavaDecompiler - Stage 4: per-class candidate scoring.
 *
 * Deterministic, no AI — fast and free. For each top-level class (inner/anonymous classes are
 * compared as part of their outer compilation unit, since decompilers differ on whether they
 * inline nested classes), gather up to 5 candidate .java files across the five engines and
 * score them: penalize known decompiler failure markers, penalize brace/paren imbalance as a
 * cheap sanity check, tie-break on non-comment line count as a completeness proxy.
 */

import fs from 'fs';
import path from 'path';
import { DecompilerEngine, ClassCandidate } from '../models/job';
import { DecompileRunResult } from './decompilerRunner';
import { checkJavaSyntax } from '../core/javaSyntaxCheck';
import { detectVariableConflicts, VariableConflictFinding } from './variableConflictDetector';
import { ProjectSymbolTable, classHasFullDebugInfo } from './bytecodeMetadataService';

/** Known per-engine "I couldn't decompile this cleanly" comment markers. */
const FAILURE_MARKERS: Record<DecompilerEngine, RegExp[]> = {
  cfr: [
    /\/\*\s*WARNING\s*:\s*unable to/i,
    /\/\/\s*Couldn't be decompiled/i,
    /\/\*\s*monitorenter/i, // leaked synchronization bytecode CFR couldn't structure
  ],
  vineflower: [
    /\/\/\s*\$VF:/,
    /unable to fully structure code/i,
    /\/\/\s*This method has failed to decompile/i,
  ],
  jdcli: [
    /\/\/\s*Byte code:/i, // JD-Core falls back to raw bytecode dump when it can't decompile a method
    /\/\*\s*error\s*:/i,
  ],
  jadx: [
    // Confirmed live: real JADX output says "JADX WARN:" (short form, no "ING"), e.g.
    // "/* JADX WARN: Type inference failed for: r0v58, types: [...] */" — the previous
    // `JADX WARNING` pattern never matched this, so JADX's own self-reported type-inference
    // failures (exactly the shape that produces a `?? var = ...;` unresolvable-type placeholder,
    // see variableConflictDetector.ts) were silently invisible to scoring. Match the "WARN"
    // prefix so both the real short form and a hypothetical long form are covered.
    /\/\*\s*JADX WARN/i,
    /\/\*\s*JADX ERROR/i,
    /UnsupportedOperationException\("Method not decompiled/i, // JADX's stand-in for a method body it couldn't reconstruct
    /\/\/\s*\$FF:\s*synthetic method/i,
  ],
  procyon: [
    /\/\*\s*Could not decompile/i,
    /\/\/\s*Unable to decompile/i,
    /\/\*\s*Decompilation failed/i,
  ],
};

function findJavaFile(dir: string, fqcnPath: string): string | null {
  const candidate = path.join(dir, `${fqcnPath}.java`);
  return fs.existsSync(candidate) ? candidate : null;
}

function countBraceImbalance(source: string): number {
  let depth = 0;
  let minDepth = 0;
  for (const ch of source) {
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth < minDepth) minDepth = depth; }
  }
  return Math.abs(depth) + Math.abs(minDepth);
}

function countNonCommentLines(source: string): number {
  return source.split('\n').filter(l => {
    const t = l.trim();
    return t.length > 0 && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  }).length;
}

/** Exported for unresolvedLibDecompiler.ts, which needs the same "did this engine leave a
 * failure marker in this file" check for CFR-decompiled dependency sources. */
export function findFailureMarkers(engine: DecompilerEngine, source: string): string[] {
  const found: string[] = [];
  for (const re of FAILURE_MARKERS[engine]) {
    const m = source.match(re);
    if (m) found.push(m[0].trim());
  }
  return found;
}

/** Dwarfs every other penalty in scoreCandidate — a candidate that doesn't even parse must
 * never beat one that does, no matter how many markers/how much brace-imbalance the parsing one
 * has. Confirmed live this matters: a decompiler can mangle a try/catch/finally into something
 * with perfectly balanced braces and no failure-marker comment at all (CFR 0.152's 'catch'
 * without 'try' output does exactly this) — brace-balance and markers alone can't tell that
 * apart from genuinely clean output, only an actual parse attempt can. */
const INVALID_SYNTAX_PENALTY = 1_000_000;

/** Penalty for each type reference that can't be resolved against the known type set. Much
 * smaller than INVALID_SYNTAX_PENALTY (a parsing candidate with unresolved types is still
 * better than a non-parsing one) but larger than a single failure marker — a candidate that
 * references types we can't find is more likely to fail at compile time than one with a
 * decompiler marker comment (markers are sometimes false positives; an unresolved type is
 * always a real compile error unless an import is missing, which the deterministic remediation
 * pass can often fix). */
const UNRESOLVED_TYPE_PENALTY = 50;

/** Penalty per variable flagged by variableConflictDetector.ts (a single identifier reassigned
 * incompatible-looking values — the classic slot-reuse corruption). Heavier than a single
 * unresolved-type reference: this pattern is frequently still syntactically valid AND fully
 * resolved (every identifier it touches is a real local variable), so it needs its own signal
 * strong enough to let a clean candidate from another engine win even when this one has fewer
 * unresolved types overall. */
const VARIABLE_CONFLICT_PENALTY = 75;

/** Common java.lang and java.util types that are always available without imports. Used to
 * avoid penalizing references to types that are implicitly on the classpath. */
const IMPLICIT_TYPES = new Set([
  'String', 'Object', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Byte', 'Short', 'Character',
  'Number', 'Math', 'System', 'Exception', 'RuntimeException', 'Throwable', 'Error',
  'Thread', 'Runnable', 'Comparable', 'StringBuilder', 'StringBuffer',
  'List', 'ArrayList', 'Map', 'HashMap', 'Set', 'HashSet', 'Collection', 'Iterator',
  'Date', 'Calendar', 'TimeZone', 'Arrays', 'Collections', 'Comparator',
  'InputStream', 'OutputStream', 'Reader', 'Writer', 'PrintStream',
  'Void', 'Class', 'Override', 'Deprecated', 'SuppressWarnings',
]);

/** Extracts all type-like identifiers from a source file — capitalized words that appear in
 * type positions (after `new`, after `extends`/`implements`, in casts, in `instanceof`
 * checks, in generic bounds, as annotation names). This is a heuristic: it will miss some
 * references and catch some false positives, but it's consistent across all candidates for the
 * same class, so it's useful as a relative scoring signal even if the absolute count is noisy. */
function extractTypeReferences(source: string): string[] {
  const types = new Set<string>();

  // After `new` keyword: `new Foo(...)`, `new Foo.Builder()`
  for (const m of source.matchAll(/\bnew\s+([A-Z]\w+)/g)) types.add(m[1]);

  // After `extends` / `implements`: `extends Foo`, `implements Bar, Baz`
  for (const m of source.matchAll(/\b(?:extends|implements)\s+([A-Z]\w+)/g)) types.add(m[1]);

  // In casts: `(Foo) expr`
  for (const m of source.matchAll(/\(\s*([A-Z]\w+)/g)) types.add(m[1]);

  // In instanceof: `expr instanceof Foo`
  for (const m of source.matchAll(/\binstanceof\s+([A-Z]\w+)/g)) types.add(m[1]);

  // Type declarations: `Foo<...> var` or `Foo[] var` — capitalized word followed by `<` or `[`
  for (const m of source.matchAll(/\b([A-Z]\w+)\s*[<\[]/g)) types.add(m[1]);

  // Method return types and parameter types: `Foo bar(` or `(Foo bar)`
  for (const m of source.matchAll(/\b([A-Z]\w+)\s+\w+\s*[,(]/g)) types.add(m[1]);

  // Annotation types: `@Foo` or `@Foo(...)`
  for (const m of source.matchAll(/@([A-Z]\w+)/g)) types.add(m[1]);

  // Static method calls: `Foo.method()` — capitalized word followed by `.`
  for (const m of source.matchAll(/\b([A-Z]\w+)\s*\./g)) types.add(m[1]);

  return Array.from(types);
}

/** Counts type references that can't be resolved against the known type set (app's own classes
 * + implicit JDK types + resolved dependency artifact names). Returns a penalty count, not a
 * boolean — more unresolved types means a higher penalty. */
function countUnresolvedTypeReferences(source: string, knownTypes: Set<string>): number {
  const refs = extractTypeReferences(source);
  let unresolved = 0;
  for (const ref of refs) {
    if (IMPLICIT_TYPES.has(ref)) continue;
    if (knownTypes.has(ref)) continue;
    unresolved++;
  }
  return unresolved;
}

/** Lower is better. */
async function scoreCandidate(
  engine: DecompilerEngine,
  source: string,
  knownTypes?: Set<string>,
  /** True when bytecodeMetadataService.ts confirmed this class's original .class files kept a
   * LocalVariableTable for every method — decompiler variable names are real in that case, not
   * guesses, so variableConflictDetector.ts's slot-reuse heuristics (built specifically to
   * compensate for STRIPPED debug info) would be pure false-positive noise here. */
  skipConflictDetection?: boolean,
): Promise<{ score: number; markers: string[]; valid: boolean; variableConflicts: VariableConflictFinding[] }> {
  const markers = findFailureMarkers(engine, source);
  const braceImbalance = countBraceImbalance(source);
  const lines = countNonCommentLines(source);
  const { valid } = await checkJavaSyntax(source);
  const variableConflicts = skipConflictDetection ? [] : detectVariableConflicts(source);

  // Type-reference validation: only applies when knownTypes is provided (the caller may not
  // have the dependency set available). The penalty is small relative to syntax validity but
  // meaningful among candidates that both parse — a candidate with fewer unresolved type
  // references is more likely to compile successfully.
  const unresolvedTypeCount = knownTypes ? countUnresolvedTypeReferences(source, knownTypes) : 0;

  // Failure markers are a secondary signal, brace imbalance a cheap sanity check, line count a
  // weak completeness tie-breaker (fewer real lines = more likely something got dropped) — all
  // three only matter among candidates that already parse; INVALID_SYNTAX_PENALTY dominates
  // everything else so a parsing candidate always wins over a non-parsing one regardless.
  // Unresolved type references are a compile-readiness signal — more unresolved types means
  // more likely to fail at `mvn compile`, so penalize proportionally.
  const score = (valid ? 0 : INVALID_SYNTAX_PENALTY)
    + markers.length * 100
    + braceImbalance * 50
    + unresolvedTypeCount * UNRESOLVED_TYPE_PENALTY
    + variableConflicts.length * VARIABLE_CONFLICT_PENALTY
    - Math.min(lines, 500) * 0.1;
  return { score, markers, valid, variableConflicts };
}

/** List every top-level class's binary path (dir1/dir2/Foo, no .class/.java suffix) found
 * across all five decompiler output trees, deduped. Inner/anonymous classes ($ in the name)
 * are intentionally excluded — they're part of their outer class's .java file. */
function listTopLevelClasses(dirs: string[]): string[] {
  const found = new Set<string>();
  function walk(dir: string, base: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.join(base, entry.name);
      if (entry.isDirectory()) { walk(full, rel); continue; }
      if (!entry.name.endsWith('.java')) continue;
      const withoutExt = rel.slice(0, -'.java'.length);
      if (withoutExt.includes('$')) continue; // inner/anonymous — belongs to its outer class
      found.add(withoutExt.split(path.sep).join('/'));
    }
  }
  for (const d of dirs) walk(d, '');
  return Array.from(found);
}

export async function scoreAllCandidates(
  results: DecompileRunResult[],
  knownTypes?: Set<string>,
  symbolTable?: ProjectSymbolTable,
): Promise<ClassCandidate[]> {
  const byEngine = new Map<DecompilerEngine, string>();
  for (const r of results) if (r.ran) byEngine.set(r.engine, r.outputDir);

  const allDirs = Array.from(byEngine.values());
  const fqcns = listTopLevelClasses(allDirs);

  // Build a known-types set from the decompiled class FQCNs themselves — every top-level class
  // is a type the other classes can reference. This is always available (no dependency info
  // needed) and catches cross-class references within the same decompilation batch.
  const allKnownTypes = new Set<string>(knownTypes || []);
  for (const fqcn of fqcns) {
    const simpleName = fqcn.split('/').pop() || fqcn;
    allKnownTypes.add(simpleName);
  }

  const candidates: ClassCandidate[] = [];
  for (const fqcn of fqcns) {
    const scores: Partial<Record<DecompilerEngine, number>> = {};
    const failureMarkers: Partial<Record<DecompilerEngine, string[]>> = {};
    const validity: Partial<Record<DecompilerEngine, boolean>> = {};
    const conflictsByEngine = new Map<DecompilerEngine, VariableConflictFinding[]>();
    let winningEngine: DecompilerEngine | null = null;
    let bestScore = Infinity;
    const skipConflictDetection = classHasFullDebugInfo(symbolTable, fqcn);

    for (const [engine, dir] of byEngine.entries()) {
      const file = findJavaFile(dir, fqcn);
      if (!file) continue;
      const source = fs.readFileSync(file, 'utf8');
      const { score, markers, valid, variableConflicts } = await scoreCandidate(engine, source, allKnownTypes, skipConflictDetection);
      scores[engine] = score;
      validity[engine] = valid;
      conflictsByEngine.set(engine, variableConflicts);
      if (markers.length) failureMarkers[engine] = markers;
      if (score < bestScore) {
        bestScore = score;
        winningEngine = engine;
      }
    }

    const winnerSyntaxValid = winningEngine ? validity[winningEngine]! : null;
    const variableConflicts = winningEngine ? (conflictsByEngine.get(winningEngine) || []).map(f => f.note) : [];
    candidates.push({ fqcn, winningEngine, scores, failureMarkers, winnerSyntaxValid, aiStatus: 'skipped_clean', variableConflicts });
  }

  return candidates;
}
