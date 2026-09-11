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
 * BJavaDecompiler - heuristic detector for the "single decompiled identifier standing in for
 * multiple real JVM local-variable slots" corruption pattern (classic CFR/Vineflower damage on
 * bytecode compiled without a LocalVariableTable — javac is free to reuse a slot index for two
 * variables with disjoint live ranges and different types, which is completely legal at the
 * bytecode level; a decompiler reconstructing source without debug info has to guess a single
 * Java variable per slot for the method's entire text, and sometimes picks one loose type — often
 * Object, or just an unresolved placeholder — and cheerfully assigns it a String here, a boolean
 * there, `this` somewhere else).
 *
 * This is a real, live example (a corrupted CFR-decompiled `init()` method):
 *   ?? Trim = this;
 *   synchronized (Trim) { ... Trim = getInitParameter(...).trim(); ... Trim = isDebug; ...
 *     Trim = 0; ... Trim = this._elogAppId; ... throw Trim; } }
 * `Trim` here is simultaneously `this`, a boolean, an int literal, a field reference, and (at the
 * `throw`) is expected to be a Throwable — none of which is legal Java, and much of it (the
 * literal/this/int reassignments) is still SYNTACTICALLY valid, so javaSyntaxCheck.ts's real
 * parser cannot catch it — only `mvn compile`'s type checker can, and only for the subset that
 * actually produces a javac error rather than merely wrong behavior.
 *
 * This module is advisory only — it never rewrites source. It feeds candidateScoringService.ts
 * (an extra penalty, so a corrupted candidate loses to a cleaner one from another engine when one
 * exists) and the AI reconstruction/remediation prompts (explicit diagnostics telling the model
 * exactly which identifier is corrupted and why, instead of a generic "fix decompiler artifacts"
 * instruction). Because it's advisory, imprecision is acceptable — false positives cost nothing
 * more than an extra line in a prompt; false negatives just mean the AI is on its own for that
 * case, same as before this module existed.
 */

export interface VariableConflictFinding {
  /** The corrupted identifier, or a synthetic label like "throw target" for patterns that aren't
   * keyed on the reassignment scan. */
  variable: string;
  note: string;
  lines: number[];
}

function lineOf(source: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index; i++) if (source.charCodeAt(i) === 10) line++;
  return line;
}

/** Classifies the RHS of an assignment into a coarse "shape" bucket. Returns null for anything
 * too ambiguous to classify confidently (a bare identifier, a non-trivial method call, `null`) —
 * deliberately conservative, since an over-eager classifier would flag ordinary polymorphic
 * reassignment (e.g. a Connection variable reassigned across loop iterations) as corruption. Only
 * the handful of shapes below are informative enough to compare across assignments. */
function classifyRhs(rhs: string): string | null {
  const t = rhs.trim();
  if (t === 'this') return 'this';
  if (/^(true|false)$/.test(t)) return 'boolean-literal';
  if (/^-?\d+(\.\d+)?[lLfFdD]?$/.test(t)) return 'numeric-literal';
  if (/^"([^"\\]|\\.)*"$/.test(t)) return 'string-literal';
  const newMatch = t.match(/^new\s+([\w.]+)\s*[(<]/);
  if (newMatch) return `new:${newMatch[1]}`;
  const castMatch = t.match(/^\(\s*([\w.]+)\s*\)\s*\S/);
  if (castMatch) return `cast:${castMatch[1]}`;
  return null;
}

/** `Type var = rhs;` or `var = rhs;` — the optional type-prefix alternative only matches when
 * followed by real whitespace, so a field-qualified assignment (`this.field = ...`, no internal
 * whitespace to split on) never matches either branch and is correctly left alone; this scan only
 * ever picks up plain local-variable assignment/declaration, which is exactly the shape a
 * decompiler's slot-reuse corruption manifests as. */
const ASSIGNMENT_RE = /(?:^|[;{}]\s*)(?:[\w.<>\[\], ]+\s+)?(\w+)\s*=\s*([^;]+);/gm;

/** `?? ident = rhs;` — an unresolvable-type declaration never matches ASSIGNMENT_RE's prefix
 * class (`?` isn't a word/dot/bracket character, so the alternation's required `^`/`[;{}]\s*`
 * anchor never lines up), which would otherwise hide this assignment's RHS kind from every other
 * check in this file (in particular, a `Trim = this` here should still make a later
 * `synchronized (Trim)` count as "really just this" — see checkSynchronizedOnThis). */
const PLACEHOLDER_DECL_RE = /\?\?+\s*(\w+)\s*=\s*([^;]+);/g;

function collectAssignments(source: string): Map<string, { kind: string; line: number }[]> {
  const byVar = new Map<string, { kind: string; line: number }[]>();
  function record(name: string, rhs: string, index: number) {
    const kind = classifyRhs(rhs);
    if (!kind) return;
    if (!byVar.has(name)) byVar.set(name, []);
    byVar.get(name)!.push({ kind, line: lineOf(source, index) });
  }
  for (const m of source.matchAll(ASSIGNMENT_RE)) record(m[1], m[2], m.index!);
  for (const m of source.matchAll(PLACEHOLDER_DECL_RE)) record(m[1], m[2], m.index!);
  return byVar;
}

const CATCH_BINDING_RE = /\bcatch\s*\(\s*(?:final\s+)?[\w.$]+(?:\s*\|\s*[\w.$]+)*\s+(\w+)\s*\)/g;

/** Scans a single decompiled source file for the incompatible-reassignment pattern plus the
 * specific corruption shapes called out in the class doc comment (self-assignment, a
 * `synchronized` monitor that's really just `this` in disguise, and a `throw` target that's
 * really a hallucinated variable rather than a caught exception). Findings are per-file, not
 * per-method — the reassignment scan doesn't attempt to track method boundaries, since a false
 * positive here only costs an extra prompt line, not an incorrect mechanical edit. */
export function detectVariableConflicts(source: string): VariableConflictFinding[] {
  const findings: VariableConflictFinding[] = [];

  // Unresolvable type placeholder — a decompiler that gives up on a slot's type entirely.
  for (const m of source.matchAll(PLACEHOLDER_DECL_RE)) {
    findings.push({
      variable: m[1],
      lines: [lineOf(source, m.index!)],
      note: `Declaration "?? ${m[1]} = ..." — the decompiler could not infer a type for this identifier at all. It is almost certainly standing in for multiple real variables reused from the same JVM local-variable slot; split it into separate, correctly-typed variables.`,
    });
  }

  // Incompatible reassignment: the same identifier assigned two or more mutually-incompatible
  // shapes (e.g. `this` and a numeric literal, or two different `new X(...)` types).
  const byVar = collectAssignments(source);
  for (const [name, assignments] of byVar) {
    const kinds = new Set(assignments.map(a => a.kind));
    if (kinds.size < 2) continue;
    findings.push({
      variable: name,
      lines: assignments.map(a => a.line),
      note: `Variable "${name}" is assigned incompatible-looking values in this file (${Array.from(kinds).join(', ')}) at line(s) ${assignments.map(a => a.line).join(', ')} — likely decompiler variable-slot-reuse corruption (see class doc comment). Split it into separate, correctly-typed, clearly-named variables — one per real role — rather than trying to give this one identifier a single type.`,
    });
  }

  // Self-assignment: `X = X;` — a no-op that only makes sense as a slot-reuse artifact where the
  // decompiler ran out of information about what the final value should actually be.
  for (const m of source.matchAll(/\b(\w+)\s*=\s*\1\s*;/g)) {
    findings.push({
      variable: m[1],
      lines: [lineOf(source, m.index!)],
      note: `"${m[1]} = ${m[1]};" is a no-op self-assignment — classic decompiler slot-reuse artifact. Remove it, or replace it with whatever the correct final value for this variable's role actually is at this point.`,
    });
  }

  // synchronized (X) where X was assigned `= this` — should almost always just be `synchronized (this)`.
  const assignedThis = new Set(Array.from(byVar.entries()).filter(([, a]) => a.some(x => x.kind === 'this')).map(([n]) => n));
  for (const m of source.matchAll(/\bsynchronized\s*\(\s*(\w+)\s*\)/g)) {
    if (m[1] === 'this' || !assignedThis.has(m[1])) continue;
    findings.push({
      variable: m[1],
      lines: [lineOf(source, m.index!)],
      note: `"synchronized (${m[1]})" — "${m[1]}" was assigned "this" earlier in the file. This is very likely a decompiler artifact from variable slot reuse; the monitor is almost certainly meant to be "synchronized (this)" directly.`,
    });
  }

  // throw X where X isn't a caught exception binding and also holds a non-exception-looking
  // value elsewhere in the file (this/literal) — a hallucinated throw target.
  const catchBindings = new Set(Array.from(source.matchAll(CATCH_BINDING_RE)).map(m => m[1]));
  const nonExceptionKinds = new Set(['this', 'boolean-literal', 'numeric-literal', 'string-literal']);
  for (const m of source.matchAll(/\bthrow\s+(\w+)\s*;/g)) {
    const name = m[1];
    if (catchBindings.has(name)) continue;
    const kinds = (byVar.get(name) || []).map(a => a.kind);
    if (!kinds.some(k => nonExceptionKinds.has(k))) continue;
    findings.push({
      variable: name,
      lines: [lineOf(source, m.index!)],
      note: `"throw ${name};" — "${name}" is not a caught exception variable here and holds non-exception values elsewhere in this file (${Array.from(new Set(kinds)).join(', ')}). This throw target is almost certainly corrupted; it should most likely throw whatever exception variable the enclosing catch block actually bound (commonly named e/ex/t/th).`,
    });
  }

  return findings;
}

/** Renders findings as a prompt-ready bullet list. Returns '' when there's nothing to report so
 * callers can cheaply skip appending an empty section. */
export function formatConflictDiagnostics(findings: VariableConflictFinding[]): string {
  if (!findings.length) return '';
  return findings.map(f => `- ${f.note}`).join('\n');
}
