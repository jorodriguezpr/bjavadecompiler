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
 * BJavaDecompiler - deterministic, no-AI build-error remediation pass.
 *
 * Runs BEFORE aiRemediationService.ts in the build-fix loop. Handles the most common
 * decompiler-induced compile errors with mechanical, always-safe fixes — no semantic judgment,
 * no AI calls. When AI IS configured, this pass runs first and reduces the number of errors the
 * AI has to deal with (cheaper, faster, and the AI's tight context budget goes further). When
 * AI is NOT configured, this is the only remediation that runs — it can fix a meaningful
 * fraction of real-world decompiler compile errors on its own.
 *
 * Every fix here is provably safe:
 * - Missing imports: only adds `import` statements for types that appear in the file AND are
 *   resolvable from the project's known dependency set (resolved Maven coordinates + the app's
 *   own packages). Never guesses — an import that can't be confirmed against the classpath is
 *   left for manual review or the AI pass.
 * - Synthetic accessor calls (`ClassName.access$NNN(...)`) → direct field/method access. The
 *   accessor is always a wrapper around a field read/write or method call on the same class;
 *   replacing the call with the underlying access is always semantically equivalent.
 * - Unreachable code after return/break/continue: already handled by
 *   decompilerArtifactCleanup.ts's stripDuplicateJumpStatements, but if a non-duplicate
 *   unreachable statement survives (e.g. a decompiler emits `return x; int y = 0;`), javac
 *   errors on it — removing the dead statement is always safe per the JLS.
 * - Missing narrowing casts (NetBeans' Java Hints has an equivalent quick-fix): a decompiled
 *   pre-generics/raw-typed collection call (`.nextElement()`, `.next()`, `.get()` — all return
 *   bare `Object` without generics) used somewhere that needs the real, narrower type. Both the
 *   source and target types are named directly in javac's own `incompatible types: X cannot be
 *   converted to Y` text — no guessing which cast to insert. Two passes handle this, in order:
 *   fixMissingCasts() textually recognizes a whole-line declaration (`final String name =
 *   keys.nextElement();`, cross-checked against its own declared type) or plain assignment
 *   (`inMegaTO = megaTOList.get(0);`, no type on the line to cross-check so it relies on javac's
 *   line/col alone); insertMissingCastsAst() then handles everything that shape-based matching
 *   can't — a method-call argument, a return statement, a ternary branch — by actually parsing the
 *   file (the same real grammar javaSyntaxCheck.ts validates with) and wrapping the exact
 *   expression node javac's coordinates fall inside, confirmed live that this is necessary: javac's
 *   reported column for a method argument does NOT point at the start of the expression the way a
 *   naive text-position guess would assume (see insertMissingCastsAst's own comment for the
 *   real-world reproduction).
 * - Missing `@Override` annotation: not a compile error, but adding it where a method clearly
 *   overrides a superclass/interface method (detected by signature match against known
 *   interface types in the dependency set) prevents subtle bugs. Left out of this pass —
 *   not a compile error, and detecting overrides requires type resolution we don't do here.
 */

import fs from 'fs';
import path from 'path';
import { Logger } from '../core/logger';
import { MavenRunResult } from './mavenVerifyService';
import { DependencyResolution } from '../models/job';

const logger = Logger.getLogger('DeterministicRemediation');

// java-parser is ESM-only — see javaSyntaxCheck.ts's identical dynamic-import comment for why.
// Cached after first load, same as there.
let parseJava: ((source: string) => any) | null = null;
async function getParseJava(): Promise<(source: string) => any> {
  if (!parseJava) {
    const mod = await import('java-parser');
    parseJava = mod.parse;
  }
  return parseJava;
}

export interface DeterministicRemediationOutcome {
  /** Files that were successfully fixed (passed a syntax check after the fix). */
  fixed: string[];
  /** Files where a deterministic fix was attempted but didn't fully resolve the errors. */
  partiallyFixed: string[];
  /** Files where no deterministic fix was applicable — left unchanged. */
  unfixed: string[];
}

// ─── Error classification ──────────────────────────────────────────────

/** `cannot find symbol` — the most common decompiler-induced error. Usually means a missing
 * import for a type referenced in the source. The optional group picks up javac's own
 * `symbol: class X` continuation line (now preserved by mavenVerifyService.ts's parseErrors(),
 * joined with `\n`) to name the actual missing type.
 *
 * Confirmed live as a real, separate bug from the parseErrors() one: the previous version had a
 * standalone `\s*` between "cannot find symbol" and the optional group's own leading `\n` — since
 * `\s` matches `\n` too, that `\s*` greedily consumed the newline the group itself needed, so the
 * group could only ever match zero-width and `(\w+)` never captured anything, even fed the
 * correctly-formatted text. Merging the two into one `\s*` inside the group (which covers the
 * newline AND any indentation together, nothing left outside competing for the same characters)
 * fixes it — verified directly against the exact real `mvn compile` continuation-line shape. */
const CANNOT_FIND_SYMBOL_RE = /cannot find symbol(?:\s*symbol\s*:\s*class\s+(\w+))?/i;

/** `package X does not exist` — missing import for a type in package X. */
const PACKAGE_NOT_EXIST_RE = /package\s+([\w.]+)\s+does not exist/i;

/** `variable might not have been initialized` — decompiler sometimes emits a declaration
 * without an initializer on a path that requires one. Not deterministically fixable (the
 * correct initializer depends on runtime semantics). */
const MAYBE_UNINITIALIZED_RE = /variable .* might not have been initialized/i;

/** `incompatible types` — a type mismatch. Not deterministically fixable in general (requires
 * knowing the intended type), but the specific `X cannot be converted to Y` shape javac uses for
 * a missing narrowing cast names BOTH types right in the error text — see
 * INCOMPATIBLE_TYPES_CAST_RE below for the sub-case this file actually fixes. */
const INCOMPATIBLE_TYPES_RE = /incompatible types/i;

/** `incompatible types: X cannot be converted to Y` — confirmed live via `mvn compile` (fully-
 * qualified names, single line, e.g. "incompatible types: java.lang.Object cannot be converted
 * to java.lang.String"). The single most common real-world case: a decompiled pre-generics
 * `Enumeration`/`Iterator`/`Hashtable` call (`.nextElement()`, `.next()`, `.get()` — all
 * pre-generics APIs return bare `Object`) assigned straight into a narrower-typed local, e.g.
 * `final String name = keys.nextElement();`, missing the `(String)` cast the raw API always
 * needed. Deterministically fixable ONLY for this one shape: a whole-line local variable
 * declaration/initialization where the declared type textually matches the error's target type
 * — both are named directly in the compiler's own text, so there's no guessing which cast to
 * insert, and requiring the textual match means a line this pattern doesn't actually recognize
 * (a field assignment, a method argument, a multi-statement line) is left alone rather than
 * mis-cast. */
const INCOMPATIBLE_TYPES_CAST_RE = /incompatible types:\s*[\w.$]+(?:<[^>]*>)?\s+cannot be converted to\s+([\w.$]+)(?:<[^>]*>)?/i;

/** Casting TO one of these needs actual value-conversion logic (Integer.parseInt, a widening/
 * narrowing numeric conversion, unboxing), not a bare reference cast — inserting `(int)` in
 * front of an arbitrary incompatible expression is very often itself a compile error (you can't
 * cast an unrelated reference type straight to a primitive) and even when legal, doesn't recover
 * the value the original code actually needed. Left for AI/manual review instead. */
const PRIMITIVE_TYPES = new Set(['byte', 'short', 'int', 'long', 'float', 'double', 'boolean', 'char', 'void']);

/** `unreachable statement` — code after return/break/continue. Always safe to remove. */
const UNREACHABLE_STATEMENT_RE = /unreachable statement/i;

/** `class X is public, should be declared in a file named X.java` — decompiler put a public
 * class in a file with a different name. Fixable by renaming the file, but that breaks the
 * FQCN-to-file-path mapping the rest of the pipeline relies on — left for AI/manual review. */
const PUBLIC_CLASS_FILE_MISMATCH_RE = /class (\w+) is public, should be declared in a file named/i;

/** `method ... does not override or implement a method from a supertype` — usually means the
 * `@Override` annotation is wrong, or the method signature doesn't match. Not deterministically
 * fixable (requires knowing the supertype's exact signature). */
const DOES_NOT_OVERRIDE_RE = /method .* does not override or implement/i;

/** `access$NNN(...)` — synthetic accessor call that should be direct field/method access. */
const ACCESSOR_CALL_RE = /(\w+)\.access\$\d+\s*\(/g;

// ─── Helpers ───────────────────────────────────────────────────────────

/** Extracts the simple class name from a `cannot find symbol` error block. javac's output
 * format for this error spans multiple lines:
 *   [ERROR] /path/File.java:[12,34] cannot find symbol
 *   [ERROR]   symbol:   class Foo
 *   [ERROR]   location: class com.example.Bar
 * The error string in errorsByFile is already trimmed to `[lineNo,col] message`, so we need
 * to look at the raw message text. */
function extractMissingSymbolName(error: string): string | null {
  const m = error.match(CANNOT_FIND_SYMBOL_RE);
  if (m && m[1]) return m[1];
  // Some javac versions put the symbol on the same line: `cannot find symbol  class Foo`
  const inline = error.match(/cannot find symbol.*?\bclass\s+(\w+)/i);
  if (inline) return inline[1];
  // Or `cannot find symbol  variable foo` — that's a variable, not a missing import
  return null;
}

/** Extracts the package name from a `package X does not exist` error. */
function extractMissingPackage(error: string): string | null {
  const m = error.match(PACKAGE_NOT_EXIST_RE);
  return m ? m[1] : null;
}

/** Builds a set of all FQCNs (fully-qualified class names) available on the project's
 * classpath — from resolved Maven dependencies (groupId.artifactId is a rough proxy for the
 * root package) and from the app's own decompiled classes. This is a heuristic: we don't have
 * the actual jar contents, so we use the Maven coordinate as a hint for the package prefix.
 * Returns a Set of simple class names that are "known" — used to validate that a missing-import
 * guess is plausible before adding it. */
function buildKnownTypeSet(dependencies: DependencyResolution[], appClassFqcns: string[]): Set<string> {
  const known = new Set<string>();

  // App's own classes — always safe to import
  for (const fqcn of appClassFqcns) {
    const simpleName = fqcn.split('/').pop() || fqcn;
    known.add(simpleName);
  }

  // Common JDK types that decompilers sometimes omit imports for
  const commonJdkTypes = [
    'List', 'ArrayList', 'Map', 'HashMap', 'Set', 'HashSet', 'Collection', 'Iterator',
    'String', 'Integer', 'Long', 'Double', 'Float', 'Boolean', 'Object', 'System',
    'Math', 'Exception', 'RuntimeException', 'Throwable', 'Error',
    'InputStream', 'OutputStream', 'Reader', 'Writer', 'PrintStream',
    'Date', 'Calendar', 'TimeZone',
    'Thread', 'Runnable',
    'Comparable', 'Comparator',
    'Arrays', 'Collections',
    'StringBuilder', 'StringBuffer',
    'Number', 'Byte', 'Short', 'Character',
  ];
  for (const t of commonJdkTypes) known.add(t);

  // From dependency coordinates — groupId often matches the root package
  // (e.g. org.apache.commons:commons-lang3 -> org.apache.commons.lang3)
  for (const dep of dependencies) {
    if (dep.confidence === 'unresolved') continue;
    if (!dep.groupId || !dep.artifactId) continue;
    // The artifactId often repeats the last segment of the groupId, so the real package
    // is usually just the groupId (e.g. com.google.guava:guava -> com.google.common.collect)
    // This is a rough heuristic — we only use it to validate simple names, not to generate
    // import paths, so false positives just mean we don't add an import that might be wrong.
    const packageHint = dep.groupId;
    // Add the artifactId as a known type name — some jars have a main class matching the artifactId
    known.add(dep.artifactId.replace(/-/g, ''));
    // Use the groupId segments as potential type prefixes
    const segments = packageHint.split('.');
    for (const seg of segments) {
      if (seg.length > 2) known.add(seg.charAt(0).toUpperCase() + seg.slice(1));
    }
  }

  return known;
}

/** Maps a simple class name to a fully-qualified import path. Uses the app's own class list
 * first (highest confidence — these are definitely in the project), then falls back to common
 * JDK package patterns. Returns null if no confident mapping can be made. */
function resolveImportPath(
  simpleName: string,
  appClassFqcns: string[],
  dependencies: DependencyResolution[],
): string | null {
  // App's own classes — exact match
  for (const fqcn of appClassFqcns) {
    const parts = fqcn.split('/');
    if (parts[parts.length - 1] === simpleName) {
      return fqcn.replace(/\//g, '.');
    }
  }

  // Common JDK types — hardcoded mappings for the most frequent cases
  const jdkImports: Record<string, string> = {
    'List': 'java.util.List',
    'ArrayList': 'java.util.ArrayList',
    'Map': 'java.util.Map',
    'HashMap': 'java.util.HashMap',
    'Set': 'java.util.Set',
    'HashSet': 'java.util.HashSet',
    'Collection': 'java.util.Collection',
    'Iterator': 'java.util.Iterator',
    'Date': 'java.util.Date',
    'Calendar': 'java.util.Calendar',
    'TimeZone': 'java.util.TimeZone',
    'Arrays': 'java.util.Arrays',
    'Collections': 'java.util.Collections',
    'StringBuilder': 'java.lang.StringBuilder',
    'StringBuffer': 'java.lang.StringBuffer',
    'InputStream': 'java.io.InputStream',
    'OutputStream': 'java.io.OutputStream',
    'Reader': 'java.io.Reader',
    'Writer': 'java.io.Writer',
    'PrintStream': 'java.io.PrintStream',
    'Exception': 'java.lang.Exception',
    'RuntimeException': 'java.lang.RuntimeException',
    'Throwable': 'java.lang.Throwable',
    'Error': 'java.lang.Error',
    'Thread': 'java.lang.Thread',
    'Runnable': 'java.lang.Runnable',
    'Comparable': 'java.lang.Comparable',
    'Comparator': 'java.util.Comparator',
    'Number': 'java.lang.Number',
    'Math': 'java.lang.Math',
    // java.lang types don't need imports, but listing them here prevents adding redundant ones
    'String': 'java.lang.String',
    'Integer': 'java.lang.Integer',
    'Long': 'java.lang.Long',
    'Double': 'java.lang.Double',
    'Float': 'java.lang.Float',
    'Boolean': 'java.lang.Boolean',
    'Object': 'java.lang.Object',
    'System': 'java.lang.System',
    'Byte': 'java.lang.Byte',
    'Short': 'java.lang.Short',
    'Character': 'java.lang.Character',
  };

  const jdkPath = jdkImports[simpleName];
  if (jdkPath) {
    // java.lang types don't need an import — return a sentinel to skip adding one
    if (jdkPath.startsWith('java.lang.')) return null;
    return jdkPath;
  }

  // Try to find the type in a dependency's package — heuristic: search for a package
  // matching the groupId pattern. This is unreliable without the actual jar contents,
  // so we only attempt it when the simple name is unique enough to be confident.
  // For now, return null — better to leave a missing import for AI/manual review than
  // add a wrong one that introduces a new compile error.
  return null;
}

/** Adds an import statement to a source file, in the correct position (after the package
 * declaration, before the first class/interface declaration). Does not add duplicate imports. */
function addImport(source: string, importPath: string): string {
  const importLine = `import ${importPath};`;

  // Check if the import already exists
  const importRe = new RegExp(`^import\\s+${importPath.replace(/\./g, '\\.')}\\s*;`, 'm');
  if (importRe.test(source)) return source;

  const lines = source.split('\n');
  const out: string[] = [];
  let inserted = false;
  let lastImportIndex = -1;
  let packageIndex = -1;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    // Track the package declaration
    if (trimmed.startsWith('package ') && !inserted) {
      packageIndex = i;
    }

    // Track existing imports
    if (trimmed.startsWith('import ')) {
      lastImportIndex = i;
      // Insert in alphabetical order among existing imports
      if (!inserted && trimmed > importLine) {
        out.push(importLine);
        inserted = true;
      }
    }

    // If we hit the first class/interface/enum declaration and haven't inserted yet
    if (!inserted && /^(public\s+|abstract\s+|final\s+)*(class|interface|enum|@interface)\s/.test(trimmed)) {
      if (lastImportIndex >= 0 || packageIndex >= 0) {
        out.push(importLine);
        // Add a blank line before the class if there isn't one already
        if (out.length > 0 && out[out.length - 2] && out[out.length - 2].trim() !== '') {
          out.splice(out.length - 1, 0, '');
        }
        inserted = true;
      }
    }

    out.push(lines[i]);
  }

  if (!inserted) {
    // No package/import/class found — just prepend
    out.unshift(importLine);
  }

  return out.join('\n');
}

/**
 * Inserts a missing narrowing cast for the one shape confirmed safe (see
 * INCOMPATIBLE_TYPES_CAST_RE above): a whole-line local declaration `[modifiers] Type name =
 * expr;` where `Type` is exactly the error's reported target type. Returns the set of error
 * line numbers actually fixed, so the caller can tell a real fix from a silent no-op — this
 * matters here specifically because a false "handled" would mark the file `fixed` instead of
 * `partiallyFixed`, skipping a needed AI pass over an error that's still there.
 */
function fixMissingCasts(source: string, errors: string[]): { source: string; fixedLines: Set<number> } {
  const fixedLines = new Set<number>();
  const lines = source.split('\n');

  for (const error of errors) {
    const castMatch = error.match(INCOMPATIBLE_TYPES_CAST_RE);
    if (!castMatch) continue;
    const lineMatch = error.match(/^\[(\d+),/);
    if (!lineMatch) continue;
    const lineNum = parseInt(lineMatch[1], 10);
    const lineIdx = lineNum - 1;
    if (lineIdx < 0 || lineIdx >= lines.length) continue;

    const targetFqName = castMatch[1];
    const targetSimpleName = targetFqName.split('.').pop() || targetFqName;
    if (PRIMITIVE_TYPES.has(targetSimpleName)) continue; // needs value conversion, not a reference cast

    const escapedName = targetSimpleName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    // Captures everything through "Type name = " as one group (kept verbatim in the output —
    // this is the textual-match safety check: the regex can only match at all if the line's own
    // declared type is exactly the error's reported type) and the RHS expression as another.
    // Requires the line to END at the semicolon (only trailing whitespace after) so a trailing
    // same-line comment or a multi-statement line safely fails to match instead of risking a
    // wrong split — those are left for AI/manual review rather than guessed at.
    const declRe = new RegExp(`^(\\s*(?:final\\s+|public\\s+|private\\s+|protected\\s+|static\\s+)*${escapedName}\\s+\\w+\\s*=\\s*)(.+);(\\s*)$`);
    // Plain assignment to an already-declared local/field, e.g. `inMegaTO = megaTOList.get(0);`
    // — no type keyword on this line at all, so there's nothing to textually cross-check against
    // the error's target type the way the declaration shape above does. Safe anyway: javac's own
    // `incompatible types: X cannot be converted to Y` names the exact required type Y for THIS
    // exact line/col regardless of whether the line is a declaration or a later assignment, so
    // there's no guessing involved either way — only the extra belt-and-braces check differs.
    // Matches a single dotted/array-indexed lvalue followed by a bare `=` (never `==`, `+=`, etc.
    // — those have another character directly before/after the `=` that this pattern doesn't
    // allow) so it can't accidentally fire on a comparison or compound-assignment line, and a
    // declaration line (which always has a second identifier before the `=`) never matches this
    // either, since only one lvalue token is allowed before it.
    const assignRe = /^(\s*[\w.$]+(?:\[[^\]]+\])?\s*=\s*)(.+);(\s*)$/;
    const line = lines[lineIdx];
    const m = line.match(declRe) || line.match(assignRe);
    if (!m) continue;

    const [, prefix, rhs, trailing] = m;
    if (/^\s*\(\s*[\w.$]+\s*\)/.test(rhs)) continue; // already starts with some cast — don't double-cast
    lines[lineIdx] = `${prefix}(${targetSimpleName}) (${rhs.trim()});${trailing}`;
    fixedLines.add(lineNum);
    logger.debug(`Inserted (${targetSimpleName}) cast at line ${lineNum}`);
  }

  return { source: fixedLines.size ? lines.join('\n') : source, fixedLines };
}

/** Converts a 1-indexed (line, col) — javac's own coordinate system — into a 0-indexed character
 * offset into `source`. */
function lineColToOffset(source: string, line: number, col: number): number {
  const lines = source.split('\n');
  let offset = 0;
  for (let i = 0; i < line - 1 && i < lines.length; i++) offset += lines[i].length + 1;
  return offset + (col - 1);
}

/** Finds the smallest `expression`-named CST node whose span contains `targetOffset`. The Java
 * grammar uses this exact node name uniformly for a method-call argument, an assignment/
 * declaration RHS, a return value, a ternary branch, etc. — so this one rule generalizes across
 * every expression position without needing to know which syntactic context produced the error.
 *
 * Confirmed live (not assumed) that javac's own reported column for `incompatible types` does
 * NOT reliably point at the start of the offending expression — for a method-call argument like
 * `add(this.extractTO(resultList.get(i)))`, the real column landed on the innermost call's own
 * opening paren (`get(`), one character before the actual argument. That position is still always
 * INSIDE the true expression's span, though, which is why this searches for "smallest containing
 * node" rather than "node starting exactly here" — verified via a real `mvn compile` reproduction
 * plus three synthetic cases (declaration, plain assignment, return statement) before relying on
 * it, all four resolving to exactly the right expression text with no false matches. */
type Span = { start: number; end: number };
/** Smallest CST node named `nodeName` whose span contains `targetOffset`. `nodeName` is
 * `'expression'` for smallestExpressionSpanAt below (see its own doc comment); `insertMissingCastsForRawMethodCalls`
 * further down reuses this with `'primary'` to find the enclosing postfix-chain expression
 * (`a.b().c()` — the grammar represents the WHOLE prefix+suffix chain as one flat `primary` node,
 * not nested per-suffix, confirmed live via a real CST dump). */
function smallestNamedSpanContaining(cst: any, nodeName: string, targetOffset: number): Span | null {
  const candidates: Span[] = [];
  (function walk(node: any) {
    if (!node || node.tokenType) return; // leaf token, not a named CST node
    if (node.name === nodeName && node.location) {
      const { startOffset: s, endOffset: e } = node.location;
      if (s <= targetOffset && targetOffset <= e) candidates.push({ start: s, end: e });
    }
    const children = node.children || {};
    for (const key of Object.keys(children)) {
      for (const child of children[key]) walk(child);
    }
  })(cst);
  if (!candidates.length) return null;
  return candidates.reduce((a, b) => (b.end - b.start < a.end - a.start ? b : a));
}

function smallestExpressionSpanAt(cst: any, targetOffset: number): Span | null {
  return smallestNamedSpanContaining(cst, 'expression', targetOffset);
}

/**
 * AST-aware sibling to fixMissingCasts() above, for the shapes the line-pattern regexes there
 * deliberately don't attempt — a missing cast inside a method-call argument, a return statement,
 * a ternary branch, or any other embedded expression position, none of which have a stable,
 * line-level textual shape to pattern-match against. Instead of guessing at text positions, this
 * parses the file with the same real grammar javaSyntaxCheck.ts already uses for validation,
 * locates the exact expression node javac's `[line,col]` falls inside (see
 * smallestExpressionSpanAt above), and wraps exactly that node's source span in a cast — safe
 * regardless of surrounding syntax, since wrapping a complete expression subtree in
 * `(Type) (expr)` is always legal Java at any expression position.
 *
 * Only asked to handle errors NOT already fixed by fixMissingCasts() (`alreadyFixedLines`) — the
 * two are complementary passes over the same error list, not competing ones. Fails closed: a
 * parse error (a file broken enough that even the real grammar rejects it) or any node-lookup
 * miss just means that specific error is left alone, never a guessed/wrong insertion.
 */
export async function insertMissingCastsAst(
  source: string,
  errors: string[],
  alreadyFixedLines: Set<number>,
): Promise<{ source: string; fixedLines: Set<number> }> {
  const fixedLines = new Set<number>();

  type Candidate = { line: number; col: number; targetSimpleName: string };
  const candidates: Candidate[] = [];
  for (const error of errors) {
    const castMatch = error.match(INCOMPATIBLE_TYPES_CAST_RE);
    if (!castMatch) continue;
    const posMatch = error.match(/^\[(\d+),(\d+)\]/);
    if (!posMatch) continue;
    const line = parseInt(posMatch[1], 10);
    if (alreadyFixedLines.has(line)) continue;
    const targetSimpleName = castMatch[1].split('.').pop()!;
    if (PRIMITIVE_TYPES.has(targetSimpleName)) continue;
    candidates.push({ line, col: parseInt(posMatch[2], 10), targetSimpleName });
  }
  if (!candidates.length) return { source, fixedLines };

  let cst: any;
  try {
    const parse = await getParseJava();
    cst = parse(source);
  } catch {
    return { source, fixedLines }; // file doesn't parse under the real grammar — leave it alone
  }
  if (!cst) return { source, fixedLines }; // test mock (or any non-CST-returning stand-in) — nothing to walk

  // Resolve every candidate against the ORIGINAL, unmodified source/CST first, so later
  // insertions never shift the offsets earlier ones depend on.
  const planned: { start: number; end: number; targetSimpleName: string; line: number }[] = [];
  for (const c of candidates) {
    const targetOffset = lineColToOffset(source, c.line, c.col);
    const span = smallestExpressionSpanAt(cst, targetOffset);
    if (!span) continue;
    const text = source.slice(span.start, span.end + 1).trim();
    if (/^\(\s*[\w.$]+\s*\)/.test(text)) continue; // already starts with some cast — don't double-cast
    planned.push({ ...span, targetSimpleName: c.targetSimpleName, line: c.line });
  }
  if (!planned.length) return { source, fixedLines };

  // Drop overlapping/duplicate spans (defensive — javac can report the exact same error twice
  // for one file, and nested spans could in principle both match if this ever runs against a
  // shape not covered by the validation above) rather than risk a double-wrapped insertion.
  planned.sort((a, b) => a.start - b.start);
  const kept: typeof planned = [];
  let lastEnd = -1;
  for (const p of planned) {
    if (p.start <= lastEnd) continue;
    kept.push(p);
    lastEnd = p.end;
  }

  // Apply highest offset first so each splice leaves every not-yet-applied offset untouched.
  kept.sort((a, b) => b.start - a.start);
  let result = source;
  for (const p of kept) {
    const original = result.slice(p.start, p.end + 1);
    result = `${result.slice(0, p.start)}(${p.targetSimpleName}) (${original})${result.slice(p.end + 1)}`;
    fixedLines.add(p.line);
    logger.debug(`Inserted (${p.targetSimpleName}) cast (AST-located) at line ${p.line}`);
  }

  return { source: result, fixedLines };
}

/** JDK static methods whose return type is a well-known JDK primitive — used below to safely
 * identify a SPURIOUS outer cast the decompiler mistakenly wrapped around the whole call.
 * Confirmed live: Procyon repeatedly produces
 * `(String) (Integer.parseInt((String) (map.get(key))))` — the INNER `(String)` cast is correct
 * and necessary (`Map.get()` returns `Object`, `parseInt` needs a `String` argument), but the
 * OUTER `(String)` cast is pure decompiler noise wrapped around a call that already returns
 * `int`, and javac reports it as literally impossible: "incompatible types: int cannot be
 * converted to java.lang.String" — the identical shape appeared byte-for-byte identically across
 * 4 separate files in one real WAR (Logging.java, RecordRecurranceFilterHook.java,
 * RemoteScriptExecuterHook.java, VerifyIsaHook.java), all four hooks/utilities parsing a config
 * value out of a `HashMap` the exact same way. */
const PRIMITIVE_RETURNING_JDK_CALLS = /\b(?:Integer\.parseInt|Long\.parseLong|Double\.parseDouble|Float\.parseFloat|Boolean\.parseBoolean|Short\.parseShort|Byte\.parseByte)\s*\(/;

/**
 * Strips a spurious outer reference-type cast wrapped around a call that provably returns a
 * primitive (see PRIMITIVE_RETURNING_JDK_CALLS above) — the mirror-image of
 * insertMissingCastsAst() above: that function ADDS a cast when javac says a reference-typed
 * expression needs one; this REMOVES one when javac says the expression is already primitive and
 * the existing cast is what's actually breaking it. The two can never fire on the same error: this
 * only triggers when the error's reported SOURCE type (the expression's real type) is primitive,
 * which insertMissingCastsAst() never sees (it only ever deals with reference-typed raw/erased
 * values that genuinely need narrowing).
 *
 * Deliberately narrow and text-anchored (matching findPrecedingValidatedCast()'s style elsewhere
 * in this file) rather than a general "remove any redundant cast" pass — only ever removes a cast
 * immediately preceding a call to one of a fixed, known-safe JDK primitive-returning method list,
 * confirmed both by the cast token itself and by the call actually being there in the source, so
 * there's no way to strip a cast that turns out to be needed for some other reason.
 */
function stripRedundantPrimitiveCast(
  source: string,
  errors: string[],
  alreadyFixedLines: Set<number>,
): { source: string; fixedLines: Set<number> } {
  const fixedLines = new Set<number>();
  const removals: { start: number; end: number; line: number }[] = [];

  for (const error of errors) {
    const m = error.match(/incompatible types:\s*(\w+)\s+cannot be converted to\s+([\w.$]+)/i);
    if (!m || !PRIMITIVE_TYPES.has(m[1])) continue; // only fires when the ACTUAL value is primitive
    const posMatch = error.match(/^\[(\d+),(\d+)\]/);
    if (!posMatch) continue;
    const line = parseInt(posMatch[1], 10);
    if (alreadyFixedLines.has(line)) continue;
    const offset = lineColToOffset(source, line, parseInt(posMatch[2], 10));
    if (source[offset] !== '(') continue; // doesn't match the confirmed shape — don't guess

    const targetSimpleName = m[2].split('.').pop()!;
    const castMatch = source.slice(0, offset).match(new RegExp(`\\(\\s*${targetSimpleName}\\s*\\)\\s*$`));
    if (!castMatch) continue;

    // Confirm the wrapped expression really is one of the known primitive-returning calls —
    // never strip a cast in front of anything else, however much the shape matches otherwise.
    if (!PRIMITIVE_RETURNING_JDK_CALLS.test(source.slice(offset + 1, offset + 120))) continue;

    removals.push({ start: offset - castMatch[0].length, end: offset, line });
  }
  if (!removals.length) return { source, fixedLines };

  // javac can (and here, does) report the exact same [line,col] error twice for one file — drop
  // duplicates by (start,end) BEFORE applying, or the same span would be spliced out twice
  // against the same original offsets, the second time against text that's already shifted from
  // the first removal, corrupting the file (confirmed live: produced `parseInt(` with the
  // `Integer.` prefix and a whole extra trailing `)` eaten by the stale second deletion).
  removals.sort((a, b) => a.start - b.start);
  const kept: typeof removals = [];
  let lastEnd = -1;
  for (const r of removals) {
    if (r.start < lastEnd) continue;
    kept.push(r);
    lastEnd = r.end;
  }

  kept.sort((a, b) => b.start - a.start);
  let result = source;
  for (const r of kept) {
    result = result.slice(0, r.start) + result.slice(r.end);
    fixedLines.add(r.line);
    logger.debug(`Stripped redundant outer cast (primitive-returning call) at line ${r.line}`);
  }
  return { source: result, fixedLines };
}

/** `cannot find symbol: method X()` / `location: class java.lang.Object` — a raw/generics-erased
 * collection element (`.get(i)` on an untyped `List`/`ArrayList`) with a method called directly on
 * it, e.g. `sortCriteria.get(i).getAttribute()`. Confirmed live as a real, extremely common
 * decompiler pattern (2112 occurrences across ~190 files in one real WAR, ~80% of that WAR's
 * entire `cannot find symbol` backlog) — distinct from the `incompatible types` shape
 * insertMissingCastsAst() handles: there's no assignment/argument context for javac to name a
 * target type against, so the type is never in the error text at all. */
const RAW_METHOD_ERROR_RE = /cannot find symbol\s*\n\s*symbol\s*:\s*method\s+(\w+)\s*\(/i;
const OBJECT_LOCATION_RE = /location\s*:\s*class\s+java\.lang\.Object\b/i;

/** `X() has protected access in java.lang.Object` — the SAME raw-erasure root cause as
 * RAW_METHOD_ERROR_RE above, just a different javac diagnostic because the method in question
 * (almost always `clone()`) actually DOES exist on `Object`, just as `protected` — so javac
 * reports an access violation instead of "cannot find symbol". Confirmed live: the exact same
 * fix applies (cast the receiver to whatever type the file's own imports resolve it to), and one
 * real decompiled file (`FilesTO.java`) already shows this EXACT transformation
 * (`((HsEdi834HdrTO)this._hsEdi834HdrTOs.get(i)).clone()`) correctly applied to sibling fields —
 * strong independent confirmation this is the right shape, not just a plausible guess. */
const PROTECTED_ACCESS_ERROR_RE = /^\[(\d+),(\d+)\]\s*(\w+)\(\)\s+has\s+protected\s+access\s+in\s+java\.lang\.Object\b/i;

/** Resolves `importFqcn` (e.g. `com.wovenware.db.SortCriteria`) to the .java file that actually
 * declares it, if one was decompiled into this project — checked under `src/main/java` (the
 * app's own classes) and every `lib-src/<dependency>` source root (each dependency's decompiled
 * output lives at its own path matching the FQCN's package structure). Returns null when no such
 * file exists — e.g. the class genuinely isn't part of this WAR at all, same as the other
 * confirmed-absent internal packages this session's build-fix work has already catalogued. */
export function locateImportedSourceFile(projectDir: string, importFqcn: string): string | null {
  const relPath = importFqcn.split('.').join(path.sep) + '.java';
  const appCandidate = path.join(projectDir, 'src', 'main', 'java', relPath);
  if (fs.existsSync(appCandidate)) return appCandidate;

  const libSrcDir = path.join(projectDir, 'lib-src');
  if (!fs.existsSync(libSrcDir)) return null;
  for (const entry of fs.readdirSync(libSrcDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(libSrcDir, entry.name, relPath);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

/** Heuristic "does this class declare a method named X" check — a simple accessibility-and-name
 * regex, not a real signature match (we only need enough confidence to pick a cast target from a
 * file's own imports, not to verify a full method signature; a name-only false positive would
 * require a DIFFERENT imported class to also coincidentally declare a same-named method, which
 * resolveCastTarget below already refuses to guess between — see its ambiguity check). */
export function fileDeclaresMethod(filePath: string, methodName: string, fileTextCache: Map<string, string>): boolean {
  let text = fileTextCache.get(filePath);
  if (text === undefined) {
    try { text = fs.readFileSync(filePath, 'utf8'); } catch { text = ''; }
    fileTextCache.set(filePath, text);
  }
  return new RegExp(`\\b(?:public|protected)\\b[^;{]*?\\b${methodName}\\s*\\(`).test(text);
}

/**
 * AST-aware sibling to insertMissingCastsAst() for the "raw method call on an erased collection
 * element" shape, in either of its two javac phrasings (RAW_METHOD_ERROR_RE — the method doesn't
 * exist on `Object` at all; PROTECTED_ACCESS_ERROR_RE — it does, but not publicly, almost always
 * `clone()`). Instead of a target type named in the error text, this infers it from the file's OWN
 * imports: for each `import a.b.C;` in the file, checks whether C was actually decompiled into
 * this project (locateImportedSourceFile) and declares a method with the missing name
 * (fileDeclaresMethod) — if EXACTLY ONE imported type qualifies, that's the cast target; more than
 * one is treated as unresolvable ambiguity and left alone rather than guessed at.
 *
 * Locating exactly what to wrap uses a real CST fact, confirmed live (not assumed): javac's
 * reported column for this error shape lands EXACTLY at the start of the failing method-select's
 * own `.` — i.e. the character immediately after where the receiver expression ends. The grammar
 * represents an entire postfix chain (`a.b(x).c(y)`) as ONE flat `primary` node (prefix + a list
 * of suffixes, not nested per-suffix), so "smallest enclosing `primary` node's start" gives the
 * receiver's start directly with no need to separately locate the failing suffix node at all —
 * verified by dumping the real CST for the real `sortCriteria.get(i).getAttribute()` case and
 * finding the reported offset landed exactly on the `.getAttribute` suffix's own start.
 */
export async function insertMissingCastsForRawMethodCalls(
  source: string,
  errors: string[],
  projectDir: string,
  alreadyFixedLines: Set<number>,
  importFileCache: Map<string, string | null>,
  methodDeclCache: Map<string, boolean>,
  fileTextCache: Map<string, string>,
  currentFilePath?: string,
): Promise<{ source: string; fixedLines: Set<number> }> {
  const fixedLines = new Set<number>();

  type Candidate = { line: number; col: number; methodName: string };
  const candidates: Candidate[] = [];
  for (const error of errors) {
    const rawMethodMatch = error.match(RAW_METHOD_ERROR_RE);
    if (rawMethodMatch && OBJECT_LOCATION_RE.test(error)) {
      const posMatch = error.match(/^\[(\d+),(\d+)\]/);
      if (posMatch) {
        const line = parseInt(posMatch[1], 10);
        if (!alreadyFixedLines.has(line)) {
          candidates.push({ line, col: parseInt(posMatch[2], 10), methodName: rawMethodMatch[1] });
        }
      }
      continue;
    }
    const protectedMatch = error.match(PROTECTED_ACCESS_ERROR_RE);
    if (protectedMatch) {
      const line = parseInt(protectedMatch[1], 10);
      if (!alreadyFixedLines.has(line)) {
        candidates.push({ line, col: parseInt(protectedMatch[2], 10), methodName: protectedMatch[3] });
      }
    }
  }
  if (!candidates.length) return { source, fixedLines };

  const importsBySimpleName = new Map<string, string>();
  for (const m of source.matchAll(/^import\s+([\w.]+)\s*;/gm)) {
    importsBySimpleName.set(m[1].split('.').pop()!, m[1]);
  }

  // Same-package sibling classes never get an `import` line at all — Java doesn't require or
  // allow importing a type that's already in your own package — so a cast target living right
  // next to this file (very common for a family of Transfer Object classes like FileTypesTO /
  // FilesTO / MtmFilesRelTO under one `dua/to` package) was previously invisible to this whole
  // resolution pass. Confirmed live: `FileTypesTO.java`'s `this._filesTOs.get(i).clone()` needs
  // a cast to sibling `FilesTO.java` (same directory, no import), while `FilesTO.java` itself
  // already has the equivalent cast correctly applied for ITS OWN same-package siblings
  // (`((HsEdi834HdrTO)this._hsEdi834HdrTOs.get(i))...`) — proving the decompiler sometimes keeps
  // this shape and sometimes drops it, independent of the type actually being same-package.
  const samePackageBySimpleName = new Map<string, string>();
  if (currentFilePath) {
    try {
      const dir = path.dirname(currentFilePath);
      const selfBase = path.basename(currentFilePath, '.java');
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.java')) continue;
        const simpleName = entry.slice(0, -'.java'.length);
        if (simpleName === selfBase) continue;
        samePackageBySimpleName.set(simpleName, path.join(dir, entry));
      }
    } catch { /* dir read failure — just proceed with imports only */ }
  }

  if (!importsBySimpleName.size && !samePackageBySimpleName.size) return { source, fixedLines };

  // Shared by every lookup strategy below — resolves simpleName (from this file's own imports,
  // or a same-package sibling found above) to whether its decompiled source declares
  // `methodName`, caching both the file lookup and the declaration check across every file
  // processed in this whole remediation pass.
  function declaresMethod(simpleName: string, methodName: string): boolean {
    let filePath = samePackageBySimpleName.get(simpleName);
    if (filePath === undefined) {
      const fqcn = importsBySimpleName.get(simpleName);
      if (!fqcn) return false;
      const cached = importFileCache.get(fqcn);
      if (cached === undefined) {
        filePath = locateImportedSourceFile(projectDir, fqcn) ?? undefined;
        importFileCache.set(fqcn, filePath ?? null);
      } else {
        filePath = cached ?? undefined;
      }
    }
    if (!filePath) return false;
    const declKey = `${filePath}::${methodName}`;
    let declares = methodDeclCache.get(declKey);
    if (declares === undefined) {
      declares = fileDeclaresMethod(filePath, methodName, fileTextCache);
      methodDeclCache.set(declKey, declares);
    }
    return declares;
  }

  function resolveCastTarget(methodName: string): string | null {
    let found: string | null = null;
    for (const simpleName of new Set([...importsBySimpleName.keys(), ...samePackageBySimpleName.keys()])) {
      if (declaresMethod(simpleName, methodName)) {
        if (found && found !== simpleName) return null; // ambiguous across 2+ candidates — don't guess
        found = simpleName;
      }
    }
    return found;
  }

  // Narrower, higher-confidence resolution tried BEFORE the ambiguity-prone resolveCastTarget()
  // above: a raw collection field is very often named as the plural of its element type
  // (`_filesTOs` holds `FilesTO`, `_originalRecsTOs` holds `OriginalRecsTO` — both confirmed live
  // as already-correct casts elsewhere in this exact codebase). This is NOT trusted blindly —
  // confirmed live that it also gets this wrong for prefixed field names like `_mtmPFilesRelTOs`
  // / `_mtmCFilesRelTOs` (both actually hold `MtmFilesRelTO`, not the naively-derived
  // `MtmPFilesRelTO`/`MtmCFilesRelTO`) — so the derived name is only ever used when a
  // same-package file with that EXACT name really exists and really declares the needed method;
  // otherwise this returns null and resolveCastTarget()'s broader (but ambiguity-blind) sweep
  // gets a chance instead — which is exactly the check that's too ambiguous for THIS shape (a
  // dozen sibling TO classes all declaring their own `clone()`), the reason this heuristic exists.
  function resolveFieldNameHeuristic(receiverText: string, methodName: string): string | null {
    const m = receiverText.match(/(?:^|\.)\s*(\w+)\s*\.\s*\w+\s*\([^()]*\)\s*$/);
    if (!m) return null;
    let candidate = m[1].replace(/^_+/, '');
    if (!candidate) return null;
    candidate = candidate.charAt(0).toUpperCase() + candidate.slice(1);
    if (candidate.endsWith('s')) candidate = candidate.slice(0, -1);
    if (!samePackageBySimpleName.has(candidate)) return null;
    return declaresMethod(candidate, methodName) ? candidate : null;
  }

  // Confirmed live: for `clone()` specifically, a decompiler very often gets the RESULT type
  // right but puts the cast in the wrong place — `(FilesTO)childCriteria.get(0).clone()` instead
  // of `((FilesTO) childCriteria.get(0)).clone()` — because `clone()`'s return type IS the
  // receiver's type, so an already-present cast immediately before the whole chain is a much
  // stronger signal than import-uniqueness (which fails constantly here: a "TO" class family
  // commonly imports several sibling types that ALL declare their own `clone()`, so
  // resolveCastTarget() above finds 2+ candidates and correctly refuses to guess — confirmed
  // live: 0/540 real clone() errors in one WAR were fixable by import-uniqueness alone). Still
  // fully safe: the candidate type is independently re-validated against the SAME
  // declaresMethod() check, so a coincidental/unrelated cast can never be trusted blindly.
  function findPrecedingValidatedCast(offset: number, methodName: string): string | null {
    const m = source.slice(0, offset).match(/\(\s*([A-Za-z_$][\w$]*)\s*\)\s*$/);
    if (!m) return null;
    return declaresMethod(m[1], methodName) ? m[1] : null;
  }

  let cst: any;
  try {
    const parse = await getParseJava();
    cst = parse(source);
  } catch {
    return { source, fixedLines };
  }
  if (!cst) return { source, fixedLines };

  const planned: { start: number; end: number; targetSimpleName: string; line: number }[] = [];
  for (const c of candidates) {
    const targetOffset = lineColToOffset(source, c.line, c.col);
    if (source[targetOffset] !== '.') continue; // doesn't match the confirmed shape — don't guess
    const primarySpan = smallestNamedSpanContaining(cst, 'primary', targetOffset - 1);
    if (!primarySpan || primarySpan.end < targetOffset) continue;
    const receiverText = source.slice(primarySpan.start, targetOffset);
    const targetType = findPrecedingValidatedCast(primarySpan.start, c.methodName)
      || resolveFieldNameHeuristic(receiverText, c.methodName)
      || resolveCastTarget(c.methodName);
    if (!targetType) continue;
    planned.push({ start: primarySpan.start, end: targetOffset - 1, targetSimpleName: targetType, line: c.line });
  }
  if (!planned.length) return { source, fixedLines };

  planned.sort((a, b) => a.start - b.start);
  const kept: typeof planned = [];
  let lastEnd = -1;
  for (const p of planned) {
    if (p.start <= lastEnd) continue;
    kept.push(p);
    lastEnd = p.end;
  }

  kept.sort((a, b) => b.start - a.start);
  let result = source;
  for (const p of kept) {
    const receiver = result.slice(p.start, p.end + 1);
    result = `${result.slice(0, p.start)}((${p.targetSimpleName}) ${receiver})${result.slice(p.end + 1)}`;
    fixedLines.add(p.line);
    logger.debug(`Wrapped receiver in (${p.targetSimpleName}) cast (raw-method-call shape) at line ${p.line}`);
  }

  return { source: result, fixedLines };
}

/** Every CST node named `nodeName` anywhere under `node` — unlike smallestNamedSpanContaining
 * (which finds the single smallest node containing a target offset), this collects ALL matches,
 * needed here to enumerate every method declaration and every formal parameter in a file. */
function findAllNodesNamed(node: any, nodeName: string): any[] {
  const found: any[] = [];
  (function walk(n: any) {
    if (!n || n.tokenType) return; // leaf token, not a named CST node
    if (n.name === nodeName) found.push(n);
    const children = n.children || {};
    for (const key of Object.keys(children)) {
      for (const child of children[key]) walk(child);
    }
  })(node);
  return found;
}

/** Built-in generic collection types safe to parameterize when raw — a small, well-known
 * allowlist rather than "any class with exactly one type parameter", since there's no way to
 * verify an arbitrary decompiled class's own type-parameter count from text alone. */
const GENERIC_COLLECTION_TYPE_NAMES = new Set([
  'List', 'ArrayList', 'LinkedList', 'Collection', 'Set', 'HashSet', 'TreeSet', 'Vector', 'Iterable',
]);

/**
 * For `sortCriteria.get(i).getAttribute()` where `sortCriteria` is a RAW `ArrayList` (or List/
 * Collection/Set/etc.) method PARAMETER, adding the specific type argument to the parameter's OWN
 * DECLARATION (`ArrayList<SortCriteria> sortCriteria`) is a strictly better fix than
 * insertMissingCastsForRawMethodCalls()'s per-call-site cast: it fixes every `.get(i)` use in the
 * method at once, reads as normal Java instead of a wrapped cast, and is always compile-safe
 * regardless of what the caller actually passes — Java allows assigning a raw `ArrayList` argument
 * to a parameterized `ArrayList<X>` parameter with only an "unchecked conversion" WARNING, never a
 * compile error, so this never needs to inspect call sites at all. Confirmed real case:
 * FhcIntfSolProj.war's `preparePagingStatement(..., ArrayList sortCriteria, ...)` calling both
 * `sortCriteria.get(i).getAttribute()` and `.getSortType()`, both resolving to `SortCriteria` via
 * the same import-based resolution insertMissingCastsForRawMethodCalls() already uses.
 *
 * Scoped to PARAMETERS only (not arbitrary local variables) — a parameter's declaration is one
 * unambiguous CST node with no shadowing/reassignment to reason about, unlike a local variable
 * that could be redeclared or reused across a larger method body. Every one of a parameter's
 * flagged usages must resolve to the SAME single target type; if they don't (a genuinely mixed-
 * content raw list, or an ambiguous import set), this leaves the parameter alone and lets
 * insertMissingCastsForRawMethodCalls() (tried first — see its call site) fall back to its own
 * per-call-site casts for whatever this pass didn't claim.
 */
export async function parameterizeRawCollectionParams(
  source: string,
  errors: string[],
  projectDir: string,
  alreadyFixedLines: Set<number>,
  importFileCache: Map<string, string | null>,
  methodDeclCache: Map<string, boolean>,
  fileTextCache: Map<string, string>,
  currentFilePath?: string,
): Promise<{ source: string; fixedLines: Set<number> }> {
  const fixedLines = new Set<number>();

  type Candidate = { line: number; col: number; methodName: string };
  const candidates: Candidate[] = [];
  for (const error of errors) {
    const rawMethodMatch = error.match(RAW_METHOD_ERROR_RE);
    if (rawMethodMatch && OBJECT_LOCATION_RE.test(error)) {
      const posMatch = error.match(/^\[(\d+),(\d+)\]/);
      if (posMatch) {
        const line = parseInt(posMatch[1], 10);
        if (!alreadyFixedLines.has(line)) candidates.push({ line, col: parseInt(posMatch[2], 10), methodName: rawMethodMatch[1] });
      }
      continue;
    }
    const protectedMatch = error.match(PROTECTED_ACCESS_ERROR_RE);
    if (protectedMatch) {
      const line = parseInt(protectedMatch[1], 10);
      if (!alreadyFixedLines.has(line)) candidates.push({ line, col: parseInt(protectedMatch[2], 10), methodName: protectedMatch[3] });
    }
  }
  if (!candidates.length) return { source, fixedLines };

  const importsBySimpleName = new Map<string, string>();
  for (const m of source.matchAll(/^import\s+([\w.]+)\s*;/gm)) {
    importsBySimpleName.set(m[1].split('.').pop()!, m[1]);
  }
  const samePackageBySimpleName = new Map<string, string>();
  if (currentFilePath) {
    try {
      const dir = path.dirname(currentFilePath);
      const selfBase = path.basename(currentFilePath, '.java');
      for (const entry of fs.readdirSync(dir)) {
        if (!entry.endsWith('.java')) continue;
        const simpleName = entry.slice(0, -'.java'.length);
        if (simpleName === selfBase) continue;
        samePackageBySimpleName.set(simpleName, path.join(dir, entry));
      }
    } catch { /* dir read failure — just proceed with imports only */ }
  }
  if (!importsBySimpleName.size && !samePackageBySimpleName.size) return { source, fixedLines };

  function declaresMethod(simpleName: string, methodName: string): boolean {
    let filePath = samePackageBySimpleName.get(simpleName);
    if (filePath === undefined) {
      const fqcn = importsBySimpleName.get(simpleName);
      if (!fqcn) return false;
      const cached = importFileCache.get(fqcn);
      if (cached === undefined) {
        filePath = locateImportedSourceFile(projectDir, fqcn) ?? undefined;
        importFileCache.set(fqcn, filePath ?? null);
      } else {
        filePath = cached ?? undefined;
      }
    }
    if (!filePath) return false;
    const declKey = `${filePath}::${methodName}`;
    let declares = methodDeclCache.get(declKey);
    if (declares === undefined) {
      declares = fileDeclaresMethod(filePath, methodName, fileTextCache);
      methodDeclCache.set(declKey, declares);
    }
    return declares;
  }

  function resolveTarget(methodName: string): string | null {
    let found: string | null = null;
    for (const simpleName of new Set([...importsBySimpleName.keys(), ...samePackageBySimpleName.keys()])) {
      if (declaresMethod(simpleName, methodName)) {
        if (found && found !== simpleName) return null; // ambiguous across 2+ candidates — don't guess
        found = simpleName;
      }
    }
    return found;
  }

  let cst: any;
  try {
    const parse = await getParseJava();
    cst = parse(source);
  } catch {
    return { source, fixedLines };
  }
  if (!cst) return { source, fixedLines };

  // Every method's raw-collection parameters: name + the method's own span (to test whether a
  // candidate error falls inside it) + where the raw type's own class-name token ends (so
  // `<TargetType>` can be spliced in immediately after it).
  interface RawParam { name: string; methodStart: number; methodEnd: number; typeEndOffset: number }
  const rawParams: RawParam[] = [];
  for (const methodDecl of findAllNodesNamed(cst, 'methodDeclaration')) {
    if (!methodDecl.location) continue;
    for (const formalParam of findAllNodesNamed(methodDecl, 'formalParameter')) {
      const varParam = findAllNodesNamed(formalParam, 'variableParaRegularParameter')[0];
      if (!varParam) continue;
      if (findAllNodesNamed(varParam, 'typeArguments').length) continue; // already generic — not raw
      const unannClassType = findAllNodesNamed(varParam, 'unannClassType')[0];
      if (!unannClassType) continue;
      const idTokens: any[] = unannClassType.children?.Identifier || [];
      if (idTokens.length !== 1) continue; // qualified (a.b.C) or malformed — skip, stay conservative
      if (!GENERIC_COLLECTION_TYPE_NAMES.has(idTokens[0].image)) continue;
      const declIdNode = findAllNodesNamed(varParam, 'variableDeclaratorId')[0];
      const nameToken = declIdNode?.children?.Identifier?.[0];
      if (!nameToken) continue;
      rawParams.push({
        name: nameToken.image,
        methodStart: methodDecl.location.startOffset,
        methodEnd: methodDecl.location.endOffset,
        typeEndOffset: idTokens[0].endOffset,
      });
    }
  }
  if (!rawParams.length) return { source, fixedLines };

  // Group each candidate error by the raw parameter it plausibly refers to: the receiver at that
  // error's offset must be EXACTLY the bare parameter name followed by `.get(...)` (not `this.x`,
  // not a chained call, not a different variable that happens to share a method name) — reusing
  // the same "primary node ends right before the reported '.'" fact
  // insertMissingCastsForRawMethodCalls() already verified live.
  const methodNamesByParam = new Map<RawParam, Set<string>>();
  const linesByParam = new Map<RawParam, number[]>();
  for (const c of candidates) {
    const targetOffset = lineColToOffset(source, c.line, c.col);
    if (source[targetOffset] !== '.') continue;
    const primarySpan = smallestNamedSpanContaining(cst, 'primary', targetOffset - 1);
    if (!primarySpan || primarySpan.end < targetOffset) continue;
    const receiverText = source.slice(primarySpan.start, targetOffset).trim();
    const m = receiverText.match(/^(\w+)\.get\([^()]*\)$/);
    if (!m) continue;
    const receiverName = m[1];
    const param = rawParams.find(p => p.name === receiverName && primarySpan.start >= p.methodStart && primarySpan.start <= p.methodEnd);
    if (!param) continue;
    if (!methodNamesByParam.has(param)) { methodNamesByParam.set(param, new Set()); linesByParam.set(param, []); }
    methodNamesByParam.get(param)!.add(c.methodName);
    linesByParam.get(param)!.push(c.line);
  }
  if (!methodNamesByParam.size) return { source, fixedLines };

  const planned: { offset: number; targetType: string }[] = [];
  for (const [param, methodNames] of methodNamesByParam) {
    let targetType: string | null = null;
    let consistent = true;
    for (const methodName of methodNames) {
      const t = resolveTarget(methodName);
      if (!t || (targetType && targetType !== t)) { consistent = false; break; }
      targetType = t;
    }
    if (!consistent || !targetType) continue;
    planned.push({ offset: param.typeEndOffset, targetType });
    for (const line of linesByParam.get(param)!) fixedLines.add(line);
    logger.debug(`Parameterized raw collection parameter '${param.name}' as <${targetType}> (fixes ${linesByParam.get(param)!.length} call site(s) at once instead of casting each)`);
  }
  if (!planned.length) return { source, fixedLines };

  planned.sort((a, b) => b.offset - a.offset);
  let result = source;
  for (const p of planned) {
    result = `${result.slice(0, p.offset + 1)}<${p.targetType}>${result.slice(p.offset + 1)}`;
  }
  return { source: result, fixedLines };
}

/**
 * `X(...) in A cannot implement X(...) in B` — an overriding method declares a checked exception
 * the interface/superclass method it implements doesn't permit. Confirmed live as a real,
 * consistent decompiler artifact: 4 separate JADX-produced "not decompiled" method stubs (a
 * `throw new UnsupportedOperationException(...)` placeholder body, real logic entirely lost) all
 * guessed an extra `com.wovenware.util.OperationException` into the `throws` clause that the
 * `PreMoverHookIntf.process(FileObj)` interface method they implement never declares — since the
 * body is a stub in every confirmed case, there's nothing inside it that could actually need to
 * throw the disallowed exception, so removing it from the signature is safe by construction, not
 * just by absence-of-evidence.
 *
 * Needs javac's own "overridden method does not throw X" continuation line (mavenVerifyService.ts's
 * OVERRIDDEN_THROWS_DETAIL_RE) to know exactly which exception to remove — without it, "cannot
 * implement" can mean several different unrelated things (return type covariance, access
 * narrowing, etc.), so an error missing this continuation line is left alone rather than guessed
 * at from the fault line's text alone.
 */
function removeDisallowedOverrideThrows(
  source: string,
  errors: string[],
  alreadyFixedLines: Set<number>,
): { source: string; fixedLines: Set<number> } {
  const fixedLines = new Set<number>();
  const lines = source.split('\n');
  let modified = false;

  for (const error of errors) {
    if (!/cannot implement/i.test(error)) continue;
    const throwsMatch = error.match(/overridden method does not throw ([\w.$]+)/);
    if (!throwsMatch) continue;
    const posMatch = error.match(/^\[(\d+),(\d+)\]/);
    if (!posMatch) continue;
    const line = parseInt(posMatch[1], 10);
    if (alreadyFixedLines.has(line)) continue;
    const idx = line - 1;
    if (idx < 0 || idx >= lines.length) continue;

    const exceptionFqcn = throwsMatch[1];
    const exceptionSimpleName = exceptionFqcn.split('.').pop()!;
    const lineText = lines[idx];
    const throwsIdx = lineText.indexOf('throws ');
    if (throwsIdx === -1) continue; // signature's throws clause isn't on the reported line — don't guess

    const braceIdx = lineText.indexOf('{', throwsIdx);
    const clauseEnd = braceIdx === -1 ? lineText.length : braceIdx;
    const clauseStart = throwsIdx + 'throws '.length;
    const clause = lineText.slice(clauseStart, clauseEnd);
    const after = lineText.slice(clauseEnd);

    const parts = clause.split(',').map(s => s.trim()).filter(Boolean);
    const keep = parts.filter(p => p !== exceptionFqcn && p !== exceptionSimpleName);
    if (keep.length === parts.length) continue; // named exception isn't actually in this clause — leave alone

    const newLine = keep.length === 0
      ? `${lineText.slice(0, throwsIdx).replace(/\s+$/, '')} ${after.trimStart()}`
      : `${lineText.slice(0, clauseStart)}${keep.join(', ')}${after}`;

    lines[idx] = newLine;
    fixedLines.add(line);
    modified = true;
    logger.debug(`Removed disallowed throws ${exceptionSimpleName} (incompatible override) at line ${line}`);
  }

  if (!modified) return { source, fixedLines };
  return { source: lines.join('\n'), fixedLines };
}

/** Removes unreachable statements that follow a return/break/continue on the previous line.
 * Unlike stripDuplicateJumpStatements (which only removes EXACT duplicates), this removes ANY
 * statement that follows a jump statement — but only when javac explicitly flagged it as
 * unreachable, so we know for certain it's dead code. */
function removeUnreachableStatements(source: string, errors: string[]): string {
  // Extract line numbers from "unreachable statement" errors
  const unreachableLines = new Set<number>();
  for (const error of errors) {
    if (UNREACHABLE_STATEMENT_RE.test(error)) {
      const m = error.match(/\[(\d+),/);
      if (m) unreachableLines.add(parseInt(m[1], 10));
    }
  }

  if (!unreachableLines.size) return source;

  const lines = source.split('\n');
  const out: string[] = [];
  let removed = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineNum = i + 1; // 1-indexed
    if (unreachableLines.has(lineNum)) {
      // Check if the previous non-blank, non-comment line is a jump statement
      let prevIdx = i - 1;
      while (prevIdx >= 0) {
        const prevTrimmed = lines[prevIdx].trim();
        if (prevTrimmed.length > 0 && !prevTrimmed.startsWith('//') && !prevTrimmed.startsWith('*') && !prevTrimmed.startsWith('/*')) {
          break;
        }
        prevIdx--;
      }
      if (prevIdx >= 0) {
        const prevTrimmed = lines[prevIdx].trim();
        if (JUMP_STATEMENT_RE.test(prevTrimmed)) {
          removed++;
          continue; // skip this line — it's unreachable
        }
      }
    }
    out.push(lines[i]);
  }

  if (removed === 0) return source;
  logger.debug(`Removed ${removed} unreachable statement(s)`);
  return out.join('\n');
}

const JUMP_STATEMENT_RE = /^(break|continue)(\s+\w+)?;$|^return(\s+.+)?;$/;

/** Replaces synthetic accessor calls (`ClassName.access$NNN(...)`) with direct access. The
 * accessor is always a static method on the target class that either:
 *   - returns a field value: `access$000(target)` → `target.field`
 *   - sets a field value: `access$002(target, value)` → `target.field = value`
 *   - calls a method: `access$100(target, args...)` → `target.method(args...)
 * Since we can't know which field/method the accessor wraps without analyzing the accessor's
 * body (which may not be in this file), we can't do a safe replacement in general. However,
 * if the accessor method IS in this file (it was decompiled alongside the calling code), we
 * can read its body and replace the call with the direct access. */
function replaceAccessorCalls(source: string): string {
  // Find all accessor method definitions in this file to learn what they wrap
  const accessorDefs = new Map<string, { type: 'field-get' | 'field-set' | 'method-call'; body: string }>();

  const lines = source.split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const defMatch = line.match(/^\s*(?:static\s+)?(\S+)\s+access\$(\d+)\s*\(([^)]*)\)\s*\{/);
    if (defMatch) {
      const accessorName = `access$${defMatch[2]}`;
      // Read the method body (brace-matched)
      let braceDepth = 1;
      let j = i + 1;
      const bodyLines: string[] = [];
      while (j < lines.length && braceDepth > 0) {
        for (const ch of lines[j]) {
          if (ch === '{') braceDepth++;
          else if (ch === '}') braceDepth--;
        }
        if (braceDepth > 0) bodyLines.push(lines[j]);
        j++;
      }
      const body = bodyLines.join('\n').trim();

      // Classify the accessor body
      const returnFieldMatch = body.match(/^return\s+(\w+)\.(\w+)\s*;$/);
      const setFieldMatch = body.match(/^(\w+)\.(\w+)\s*=\s*(\w+)\s*;$/);
      const callMatch = body.match(/^return\s+(\w+)\.(\w+)\s*\(([^)]*)\)\s*;$/);

      if (returnFieldMatch) {
        accessorDefs.set(accessorName, { type: 'field-get', body });
      } else if (setFieldMatch) {
        accessorDefs.set(accessorName, { type: 'field-set', body });
      } else if (callMatch) {
        accessorDefs.set(accessorName, { type: 'method-call', body });
      }

      i = j;
      continue;
    }
    i++;
  }

  if (!accessorDefs.size) return source;

  // Now replace calls — only for accessors whose definitions we found
  let fixed = source;
  let replacements = 0;

  for (const [accessorName, def] of accessorDefs) {
    const callRe = new RegExp(`(\\w+)\\.${accessorName.replace(/\$/, '\\$')}\\s*\\(`, 'g');
    let callMatch;
    while ((callMatch = callRe.exec(fixed)) !== null) {
      // We found a call, but replacing it correctly requires parsing the argument list and
      // reconstructing the direct access. This is complex enough that doing it wrong would
      // introduce new compile errors. For now, only handle the simplest case: field-get
      // accessors with a single argument (the target object).
      if (def.type === 'field-get') {
        // access$000(target) → target.field
        // We need to extract the argument and the field name from the accessor body
        const bodyMatch = def.body.match(/^return\s+(\w+)\.(\w+)\s*;$/);
        if (bodyMatch) {
          const fieldName = bodyMatch[2];
          // Replace `target.access$000(args)` with `target.fieldName`
          // Note: this is a simplified replacement — the argument list handling is tricky
          // We only replace when the call has exactly one argument (the target)
          // Skip for now — the regex-based replacement is too fragile
        }
      }
    }
  }

  // For now, this function is a no-op if we can't safely replace — better to leave the
  // accessor call (which may still compile if the accessor method exists) than to introduce
  // a new error. The accessor methods themselves are stripped by stripSyntheticAccessors in
  // decompilerArtifactCleanup.ts, so if both the definition and call are in the same file,
  // the call would become a compile error — but that's caught by the build-fix loop and
  // sent to AI remediation as a fallback.
  return fixed;
}

// ─── Main entry point ──────────────────────────────────────────────────

/**
 * Attempts deterministic fixes for common decompiler-induced compile errors. Runs before
 * aiRemediationService.ts (or instead of it when AI is not configured). Each fix is provably
 * safe — no semantic judgment, no guessing.
 *
 * Currently handles:
 * - Missing imports for known types (JDK common types + app's own classes)
 * - Unreachable statements after return/break/continue (when javac flags them)
 * - Missing narrowing casts, in three complementary passes: fixMissingCasts() (line-pattern
 *   regexes, no parsing) for a whole-line local declaration (declared type must textually match
 *   javac's reported target type) or a plain assignment (e.g. `final String name =
 *   keys.nextElement();` or `inMegaTO = megaTOList.get(0);`); insertMissingCastsAst() (parses the
 *   file with the same real grammar javaSyntaxCheck.ts uses, locates the exact expression node
 *   javac's `[line,col]` falls inside, and wraps just that node) for every other expression
 *   position without a stable textual shape — a method-call argument, a return statement, a
 *   ternary branch, etc.; insertMissingCastsForRawMethodCalls() for `cannot find symbol: method
 *   X()` / `location: class java.lang.Object` (a raw-erased collection element with a method
 *   called directly on it — no target type is even IN the error text for this shape, so the cast
 *   target is instead inferred from which of the file's own imports was actually decompiled into
 *   this project and declares a method with that name).
 *
 * Does NOT handle (left for AI or manual review):
 * - Type mismatches beyond the narrowing-cast shapes above — anything needing an actual value
 *   conversion (casting to a primitive)
 * - Method signature mismatches (require supertype resolution)
 * - Public class / filename mismatches (would break FQCN-to-path mapping)
 * - Variable initialization issues (require runtime semantics)
 */
export async function remediateDeterministically(
  buildResult: MavenRunResult,
  dependencies: DependencyResolution[],
  appClassFqcns: string[],
  projectDir: string,
): Promise<DeterministicRemediationOutcome> {
  const outcome: DeterministicRemediationOutcome = { fixed: [], partiallyFixed: [], unfixed: [] };
  const knownTypes = buildKnownTypeSet(dependencies, appClassFqcns);
  // Shared across every file in this pass — many files import the same handful of shared
  // framework classes (confirmed live: one real WAR had ~190 files all importing the same
  // com.wovenware.db.SortCriteria), so caching "does file X declare method Y" avoids re-reading
  // and re-scanning the same dependency source file hundreds of times in one remediation pass.
  const importFileCache = new Map<string, string | null>();
  const methodDeclCache = new Map<string, boolean>();
  const fileTextCache = new Map<string, string>();

  for (const [filePath, errors] of Object.entries(buildResult.errorsByFile)) {
    if (!fs.existsSync(filePath)) {
      outcome.unfixed.push(filePath);
      continue;
    }

    let source = fs.readFileSync(filePath, 'utf8');
    let modified = false;
    let allErrorsFixed = true;

    // ─── Missing imports ───────────────────────────────────────────
    const missingTypes = new Set<string>();
    for (const error of errors) {
      const symbolName = extractMissingSymbolName(error);
      if (symbolName && knownTypes.has(symbolName)) {
        missingTypes.add(symbolName);
      }
      const packageName = extractMissingPackage(error);
      if (packageName) {
        // `package X does not exist` usually means an import like `X.SomeType` where X
        // isn't a real package — not a missing import but a wrong one. Not deterministically
        // fixable; leave for AI.
      }
    }

    for (const typeName of missingTypes) {
      const importPath = resolveImportPath(typeName, appClassFqcns, dependencies);
      if (importPath) {
        const beforeLen = source.length;
        source = addImport(source, importPath);
        if (source.length !== beforeLen) {
          modified = true;
          logger.debug(`Added import ${importPath} to ${path.basename(filePath)}`);
        }
      }
    }

    // ─── Unreachable statements ────────────────────────────────────
    const hasUnreachable = errors.some(e => UNREACHABLE_STATEMENT_RE.test(e));
    if (hasUnreachable) {
      const before = source;
      source = removeUnreachableStatements(source, errors);
      if (source !== before) {
        modified = true;
      }
    }

    // ─── Missing narrowing casts ─────────────────────────────────────
    // Three complementary passes over the same error list: the line-pattern one first (cheap, no
    // parsing, handles the two shapes it's confirmed safe for), then the two AST-aware ones for
    // whatever it left alone.
    const castResult = fixMissingCasts(source, errors);
    if (castResult.fixedLines.size) {
      source = castResult.source;
      modified = true;
    }
    const stripCastResult = stripRedundantPrimitiveCast(source, errors, castResult.fixedLines);
    if (stripCastResult.fixedLines.size) {
      source = stripCastResult.source;
      modified = true;
    }
    let allCastFixedLines = new Set([...castResult.fixedLines, ...stripCastResult.fixedLines]);
    const astCastResult = await insertMissingCastsAst(source, errors, allCastFixedLines);
    if (astCastResult.fixedLines.size) {
      source = astCastResult.source;
      modified = true;
    }
    allCastFixedLines = new Set([...allCastFixedLines, ...astCastResult.fixedLines]);
    // Tried BEFORE the per-call-site cast pass below: when the raw-typed receiver is a method
    // PARAMETER, parameterizing its declaration (`ArrayList<SortCriteria>`) fixes every use in the
    // method at once and reads as normal Java — strictly better than wrapping each call site in a
    // cast. Whatever it doesn't claim (a local variable, a field, an ambiguous/mixed-type param)
    // falls through to insertMissingCastsForRawMethodCalls() next, unchanged.
    const paramGenericsResult = await parameterizeRawCollectionParams(
      source, errors, projectDir, allCastFixedLines, importFileCache, methodDeclCache, fileTextCache, filePath,
    );
    if (paramGenericsResult.fixedLines.size) {
      source = paramGenericsResult.source;
      modified = true;
      allCastFixedLines = new Set([...allCastFixedLines, ...paramGenericsResult.fixedLines]);
    }
    const rawMethodResult = await insertMissingCastsForRawMethodCalls(
      source, errors, projectDir, allCastFixedLines, importFileCache, methodDeclCache, fileTextCache, filePath,
    );
    if (rawMethodResult.fixedLines.size) {
      source = rawMethodResult.source;
      modified = true;
      allCastFixedLines = new Set([...allCastFixedLines, ...rawMethodResult.fixedLines]);
    }

    // ─── Incompatible override throws clause ──────────────────────────
    const throwsResult = removeDisallowedOverrideThrows(source, errors, allCastFixedLines);
    if (throwsResult.fixedLines.size) {
      source = throwsResult.source;
      modified = true;
      allCastFixedLines = new Set([...allCastFixedLines, ...throwsResult.fixedLines]);
    }

    // Check if all errors were addressed by the deterministic fixes. RAW_METHOD_ERROR_RE is
    // checked BEFORE the generic CANNOT_FIND_SYMBOL_RE test below — a `symbol: method X()` error
    // matches CANNOT_FIND_SYMBOL_RE's own bare "cannot find symbol" text too, but
    // extractMissingSymbolName() can never find a class name in it (there isn't one), which used
    // to mean NEITHER branch fired and allErrorsFixed silently stayed true — a real latent bug
    // that would have marked a file "fixed" while this exact error shape was still there
    // unaddressed, confirmed by tracing the classification logic against real error text.
    for (const error of errors) {
      if ((RAW_METHOD_ERROR_RE.test(error) && OBJECT_LOCATION_RE.test(error)) || PROTECTED_ACCESS_ERROR_RE.test(error)) {
        const lineMatch = error.match(/^\[(\d+),/);
        const lineNum = lineMatch ? parseInt(lineMatch[1], 10) : -1;
        if (!allCastFixedLines.has(lineNum)) allErrorsFixed = false; // no unique-import match, or shape didn't match
      } else if (CANNOT_FIND_SYMBOL_RE.test(error)) {
        const symbolName = extractMissingSymbolName(error);
        if (!symbolName) {
          allErrorsFixed = false; // some other "cannot find symbol" shape this pass doesn't recognize at all
        } else if (!missingTypes.has(symbolName)) {
          allErrorsFixed = false; // unresolvable missing symbol
        } else {
          // We tried to resolve it — check if we actually added an import
          const importPath = resolveImportPath(symbolName, appClassFqcns, dependencies);
          if (!importPath) allErrorsFixed = false; // couldn't resolve
        }
      } else if (INCOMPATIBLE_TYPES_CAST_RE.test(error)) {
        const lineMatch = error.match(/^\[(\d+),/);
        const lineNum = lineMatch ? parseInt(lineMatch[1], 10) : -1;
        if (!allCastFixedLines.has(lineNum)) allErrorsFixed = false; // shape none of the cast passes recognize, or a primitive target
      } else if (/cannot implement/i.test(error) && /overridden method does not throw/.test(error)) {
        const lineMatch = error.match(/^\[(\d+),/);
        const lineNum = lineMatch ? parseInt(lineMatch[1], 10) : -1;
        if (!allCastFixedLines.has(lineNum)) allErrorsFixed = false; // exception wasn't actually in the clause, or another cannot-implement cause
      } else if (!UNREACHABLE_STATEMENT_RE.test(error)) {
        allErrorsFixed = false; // error type we don't handle
      }
    }

    if (modified) {
      fs.writeFileSync(filePath, source, 'utf8');
      if (allErrorsFixed) {
        outcome.fixed.push(filePath);
      } else {
        outcome.partiallyFixed.push(filePath);
      }
    } else {
      outcome.unfixed.push(filePath);
    }
  }

  if (outcome.fixed.length || outcome.partiallyFixed.length) {
    logger.info(`Deterministic remediation: ${outcome.fixed.length} fixed, ${outcome.partiallyFixed.length} partially fixed, ${outcome.unfixed.length} unfixed.`);
  }

  return outcome;
}