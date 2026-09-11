# Java Syntax Checker & Fixer — Detailed Analysis & Design

Status: **Design proposal** (analysis complete, implementation pending)
Author: GitHub Copilot (analysis of the BJavaDecompiler codebase)
Date: 2026-09-06

---

## 1. Current State — What `javaSyntaxCheck.ts` Actually Does

[src/core/javaSyntaxCheck.ts](../src/core/javaSyntaxCheck.ts) today is a **Tier-0 gate**: a single
boolean "does this text parse as Java" check backed by `java-parser` (Chevrotain-based, grammar
≈ JLS 22 superset, ESM-only hence the cached dynamic import).

What it returns:

```ts
interface SyntaxCheckResult { valid: boolean; error?: string }
```

What it catches:
- Malformed grammar (javac-rejects-at-parse-level errors — confirmed live against CFR output).
- Missing top-level type wrapper via `hasRealTopLevelType()` (the JEP-445 implicit-class loophole).

What it **cannot** do (the gaps this design closes):

| # | Gap | Consequence in the pipeline |
|---|-----|------------------------------|
| G1 | **No diagnostics** — first error only, no line/col, no error code, no severity | `aiRemediationService.ts` can only tell the AI "it doesn't parse", not *where/why*; `decompileJobService.ts:416` treats all failures identically |
| G2 | **No JDK-version awareness** — the grammar is a fixed JLS-22 superset | A candidate targeting Java 8 can "pass" with `var`, switch arrows, records, text blocks — and then fail the real `mvn compile` one stage later, wasting an AI remediation round-trip |
| G3 | **No file↔class↔package structure verification** — nothing checks the public type name vs filename, or `package` vs directory | The generated Maven project gets files that javac rejects with `class X is public, should be declared in a file named X.java` / `class file contains wrong class` — pure mechanical errors that never needed an AI call |
| G4 | **No member-level structural checks** — duplicate methods/fields, constructor-vs-method confusion, `abstract`/body mismatches, illegal modifier combos, `return`-value/void mismatches, unreachable-statement detection | These are the classic CFR/Procyon/JADX breakage patterns; all are detectable from the CST we already build |
| G5 | **No fixer at all** — detection without repair | Every fixable finding is today either left broken or handed to an LLM; deterministic, provably-safe fixes are cheaper, faster, and reproducible |
| G6 | **No type/declaration checking** — `java-parser` is syntax-only by design | `int x = "a";` parses fine. Only javac itself can fully verify types/declarations — so the design adds a **javac-oracle tier** using the job's configured JDK |
| G7 | **Duplicated ESM-import boilerplate** — `deterministicRemediationService.ts` re-implements the same cached `import('java-parser')` loader | Two copies of the same comment/loader to keep in sync |

Consumers today (all use only `valid`/`error`):
- [aiReconstructionService.ts](../src/services/aiReconstructionService.ts) — accepts/rejects AI output
- [aiRemediationService.ts](../src/services/aiRemediationService.ts#L233) — rejects non-parsing AI fixes
- [candidateScoringService.ts](../src/services/candidateScoringService.ts) — candidate quality signal
- [decompileJobService.ts](../src/services/decompileJobService.ts#L416) — accepts/rejects patched methods
- [methodPatcherService.ts](../src/services/methodPatcherService.ts) — validates transplanted bodies
- [unresolvedLibDecompiler.ts](../src/services/unresolvedLibDecompiler.ts)

**Constraint:** the `SyntaxCheckResult.valid/error` shape and the `checkJavaSyntax(source)` signature
must stay backward-compatible — six callers depend on it.

---

## 2. Target Architecture

Three tiers, each strictly stronger and slower than the previous. Callers pick the cheapest tier
that answers their question.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ TIER 1 — CST analysis (pure java-parser, ms-level, always available)     │
│   core/javaParser.ts        single cached loader + CST walking utils     │
│   core/javaSyntaxCheck.ts   backward-compat façade (unchanged export)    │
│   core/javaAnalyzer.ts      analyzeJavaFile() → JavaFileAnalysis         │
│        • full diagnostics (line/col/length/code/severity)                │
│        • structure model: package, imports, top-level & nested types,    │
│          members (name/kind/modifiers/signature/line range)              │
│        • JDK feature-gate check vs job target version                    │
├─────────────────────────────────────────────────────────────────────────┤
│ TIER 2 — Deterministic fixer (pure, no AI, no javac)                     │
│   core/javaFixer.ts         fixJavaFile(analysis) → FixResult            │
│        ordered, independent rules; iterate to fixpoint with re-parse;    │
│        every rule is provably safe (listed in §5)                        │
├─────────────────────────────────────────────────────────────────────────┤
│ TIER 3 — javac oracle (the real JDK, only when correctness is critical)  │
│   core/javacOracle.ts       compileCheckJavaFile(path, ctx)              │
│        `javac -proc:none -d <tmp>` from Config.jdkHomeForVersion() —     │
│        the authoritative "will this compile under the JDK used" answer,  │
│        including type & declaration checking the parser can't do         │
└─────────────────────────────────────────────────────────────────────────┘
```

### 2.1 New/changed modules

| File | Action | Responsibility |
|------|--------|----------------|
| `src/core/javaParser.ts` | **new** | Single cached `java-parser` dynamic-import loader (removes the duplicated loader in `javaSyntaxCheck.ts` and `deterministicRemediationService.ts`), plus CST-walking helpers (`visitAll`, `findNodes`, token→position mapping, text-range extraction) |
| `src/core/javaSyntaxCheck.ts` | **update** | Keep `checkJavaSyntax()` exactly as-is (façade over the new analyzer); add `analyzeJavaSyntax()` returning the rich result below |
| `src/core/javaAnalyzer.ts` | **new** | CST → `JavaFileAnalysis`: diagnostics + structure model + JDK feature gate (§3, §4) |
| `src/core/javaFixer.ts` | **new** | Deterministic fix rules (§5) applied to fixpoint |
| `src/core/javacOracle.ts` | **new** | Per-file `javac` invocation under the job's JDK (§6) |
| `src/core/javaFixPipeline.ts` | **new** | Orchestrator: analyze → fix → re-analyze → (optionally) oracle, with a bounded loop and a structured report |
| `src/services/deterministicRemediationService.ts` | **update** | Replace its private loader with `javaParser.ts`; reuse the analyzer's import/type model instead of re-scanning textually where shapes overlap |
| `src/services/aiRemediationService.ts` | **update** | Feed structured diagnostics into the prompt; acceptance test becomes *error-count reduction*, not bare parse-validity (§7) |
| `src/services/candidateScoringService.ts` | **update** | Score with diagnostic severities (§7) |
| `src/services/decompileJobService.ts` | **update** | Run Tier-2 fixer at line ~416 before the patch accept/reject check (§7) |
| `tests/` | **new** | Fixture-driven tests per rule (§8) |

### 2.2 Core data model

```ts
// src/core/javaAnalyzer.ts

export type DiagnosticSeverity = 'error' | 'warning';

/** Stable, greppable codes — every rule owns a range. */
export type JavaDiagCode =
  // 1xxx — grammar/parse (from java-parser itself)
  | 'JP1000_PARSE_ERROR'
  // 2xxx — file/class/package structure (JLS §7)
  | 'JST2001_MISSING_TOP_LEVEL_TYPE'        // today's JEP-445 loophole check
  | 'JST2002_PUBLIC_TYPE_FILENAME_MISMATCH'
  | 'JST2003_PACKAGE_DIR_MISMATCH'
  | 'JST2004_MULTIPLE_PUBLIC_TOP_LEVEL_TYPES'
  | 'JST2005_DUPLICATE_TOP_LEVEL_TYPE'      // same FQCN twice in the project
  | 'JST2006_EMPTY_FILE'
  // 3xxx — member structure
  | 'JMB3001_DUPLICATE_METHOD_SIGNATURE'
  | 'JMB3002_DUPLICATE_FIELD'
  | 'JMB3003_METHOD_LOOKS_LIKE_CTOR'        // name == class name but has return type (CFR classic)
  | 'JMB3004_CTOR_HAS_RETURN_TYPE'          // javac: "invalid method declaration; return type required"
  | 'JMB3005_ABSTRACT_METHOD_IN_CONCRETE_CLASS'
  | 'JMB3006_MISSING_METHOD_BODY'           // non-abstract method ending in ';'
  | 'JMB3007_ILLEGAL_MODIFIER_COMBO'        // abstract+final, final+volatile on fields, etc.
  | 'JMB3008_VOID_METHOD_RETURNS_VALUE'
  | 'JMB3009_MISSING_RETURN_STATEMENT'      // non-void path without return
  | 'JMB3010_INTERFACE_METHOD_WITH_BODY_NO_DEFAULT'
  // 4xxx — JDK version gate (§4)
  | 'JDK4xxx_FEATURE_REQUIRES_JAVA_N'
  // 5xxx — imports
  | 'IMP5001_DUPLICATE_IMPORT'
  | 'IMP5002_CONFLICTING_SINGLE_IMPORT'     // same simple name, two packages
  | 'IMP5003_UNUSED_IMPORT'
  | 'IMP5004_IMPORT_ON_DEMAND_SHADOWS';     // a.* vs single-type b.X ambiguity

export interface JavaDiagnostic {
  code: JavaDiagCode;
  severity: DiagnosticSeverity;
  message: string;
  line: number;        // 1-based, matches javac convention
  column: number;      // 1-based
  length?: number;     // token length when known
  /** Machine-usable payload for the fixer (e.g. { expectedName, actualName }). */
  data?: Record<string, unknown>;
}

export interface JavaTypeDecl {
  name: string;
  kind: 'class' | 'interface' | 'enum' | 'record' | 'annotation';
  modifiers: string[];               // as written
  isPublic: boolean;
  startLine: number; endLine: number;
  enclosing?: string;                // simple name of enclosing type, for nested types
  methods: JavaMemberDecl[];
  fields: JavaMemberDecl[];
}

export interface JavaMemberDecl {
  kind: 'method' | 'constructor' | 'field' | 'initializer';
  name: string;
  modifiers: string[];
  /** Normalized `name(paramType1,paramType2)` — same scheme methodPatcherService.ts already uses. */
  signatureKey?: string;
  returnType?: string;               // as written (methods only)
  type?: string;                     // as written (fields only)
  hasBody: boolean;
  startLine: number; endLine: number;
}

export interface JavaFileAnalysis {
  valid: boolean;                    // no error-severity diagnostics (== today's checkJavaSyntax)
  packageName: string | null;
  imports: { name: string; onDemand: boolean; static: boolean; line: number }[];
  types: JavaTypeDecl[];             // top-level and nested, in source order
  diagnostics: JavaDiagnostic[];
  /** True when the CST parsed but only via the implicit-class path (current loophole check). */
  implicitClassOnly: boolean;
  cst: unknown;                      // kept for fixer rules; opaque to callers
}

export interface AnalyzeContext {
  filePath?: string;                 // absolute — enables filename/package checks
  projectSourceRoot?: string;        // e.g. <generatedProjectDir>/src/main/java
  javaVersion?: number;              // job.targetJavaVersion || detectedJavaMajorVersion
  knownTypeNames?: Map<string, string[]>; // simpleName -> FQCNs, project+deps (for IMP5002/5003/5004)
}
```

---

## 3. Structural Verification Rules (JLS §7) — "files inside the correct classes"

These implement the user's requirement *"verify and fix that java files are inside the correct
classes"*. All are computable from the CST + the filesystem path, **no AI needed**.

| Code | Check | Deterministic fix |
|------|-------|-------------------|
| JST2001 | Real top-level type exists (existing loophole check, promoted to a diagnostic) | If exactly one coherent member block exists, wrap in a class named after the file — otherwise leave for AI |
| JST2002 | The **public** top-level type's name == filename stem | Prefer renaming the **file** in decompiled projects (the type name came from the class file; the filename is ours). Rename the type only when the file can't be moved |
| JST2003 | `package a.b.c;` matches the path of `filePath` relative to `projectSourceRoot` | Prefer editing the `package` line (one token edit) unless the directory has other files claiming a different package — then move the file |
| JST2004 | At most one `public` top-level type | Strip `public` from the type(s) whose name ≠ filename — always safe: decompiled helper classes in the same file were package-private in the original anyway |
| JST2005 | No two files declare the same FQCN (project-wide; needs `knownTypeNames`) | Report only — resolution is a policy decision (method-patcher should have merged them) |
| JMB3003/JMB3004 | Constructor/name confusion: a method whose name equals its class must have **no** return type; javac's exact error is `invalid method declaration; return type required` | Delete the return-type token — the intent is unambiguous (name matches, no return type = constructor) |
| JMB3005/JMB3006 | Non-`abstract` method without body (trailing `;`) in a concrete class; and `abstract` methods in interfaces written explicitly (legal but noisy) | Give the method a minimal compilable stub body returning the zero value for its type (`0/false/null`/`new UnsupportedOperationException()` policy-toggled) — decompiler output with missing bodies is already semantically lost, a stub is strictly better than uncompilable |
| JMB3007 | Illegal modifier intersections (JLS §8.1.1.2, §8.3.1, §9.1.1.1): `abstract final class`, `abstract final method`, `abstract private method`, `final volatile field`, `public static final` on interface members flagged as redundant, etc. | Drop the modifier that JLS forbids (always the redundant/conflicting one; table-driven) |
| JMB3008 | `return <expr>;` inside a `void` method or constructor | `return <expr>;` → `return;` only when the expression is a method call (its side effect is the point); otherwise truncate the statement to `return;` |
| JMB3009 | Non-void method with a path that falls off the end (javac: `missing return statement`) | Append `throw new UnsupportedOperationException("missing return — decompiler gap");` as the last statement — preserves compilability, loudly marks the semantic gap for review |
| JMB3001/JMB3002 | Two members with the same normalized signature key in one class | Report only (renaming picks a side semantically) — but rank high as AI-prompt evidence |
| JMB3010 | Interface method with a body but no `default`/`static`/`private` (Java 7-targeted interface decompiled with bodies, or corrupted) | Add `default` if javaVersion ≥ 8, else stub the body |

The **fix policy** follows the existing `deterministicRemediationService.ts` philosophy: *fix only
when provably safe; otherwise emit the diagnostic as structured evidence for the AI pass.*

---

## 4. JDK Feature Gate — "according to the JDK used"

`java-parser`'s grammar is a superset (≈JLS 22). A file can parse and still be illegal under the
job's target release. The job already knows its version
([decompileJobService.ts](../src/services/decompileJobService.ts#L193-L194): `targetJavaVersion ||
detectedJavaMajorVersion || Config.defaultTargetJavaVersion`, floored at 8), and
[Config.jdkHomeForVersion()](../src/config/config.ts#L235) maps version → JDK home.

New CST-walking gate keyed on the *actual* tokens/nodes, producing `JDK4xxx` diagnostics with
`data: { feature, minVersion, targetVersion }`:

| Feature | CST/token signal | Min Java |
|---------|------------------|----------|
| `var` local inference | `localVariableDeclaration` with type token `var` (distinguished from a type named `var`) | 10 |
| Switch expressions / `->` rules / `yield` | `switchRule` / `yieldStatement` nodes | 14 |
| `instanceof` pattern | `pattern` node under `instanceofExpression` | 16 |
| Records | `recordDeclaration` | 16 |
| Text blocks | `TEXT_BLOCK` token | 15 |
| Sealed/permits | `sealed` / `permits` contextual keywords in `classDeclaration` modifiers | 17 |
| Unnamed patterns `_` | `unnamedPattern` | 22 |
| `_` as plain identifier | identifier token `_` | **illegal ≥ 9**, warning ≥ 8 |
| Underscore numeric separators, diamond `<>` (older targets) | literal tokens / `diamond` node | 7 |
| `@FunctionalInterface`-style API features | n/a — API-level, not grammar | — |

Fix strategy for the gate: **never rewrite language features downward** (desugaring a switch
expression is a semantic transformation). These diagnostics are *accept/reject signals* — a
candidate using Java-14 syntax for a Java-8 target is rejected/scored down in
`candidateScoringService` (another engine's output for the same class is often compliant), and
surfaced verbatim to the AI prompt ("rewrite without switch expressions; target is Java 8").

---

## 5. Tier-2 Fixer Pipeline (`javaFixer.ts`)

```ts
export interface FixRule {
  code: JavaDiagCode;                    // which diagnostic(s) it addresses
  apply(analysis: JavaFileAnalysis, source: string): string | null; // null = not applicable
}

export interface FixResult {
  source: string;                        // fixed (or original if unchanged)
  applied: JavaDiagCode[];
  remaining: JavaDiagnostic[];           // re-analyzed after fixpoint
  changed: boolean;
}
```

Properties:
- **Fixpoint loop:** analyze → apply first applicable rule per diagnostic code → re-parse → repeat,
  max 8 iterations (each rule must terminate; the loop bound is the safety net).
- **Token-based edits, not regex:** every rule edits by CST token offsets (the existing
  `insertMissingCastsAst()` in `deterministicRemediationService.ts` proved live that naive
  line/col text guesses are wrong for javac-reported positions — the same lesson applies here).
- **Re-validate before accept:** if any rule produces text that no longer parses, that rule's edit
  is discarded, not the file.
- **Rule order:** structure first (JST2xxx — class wrapper, public/filename, package) → members
  (JMB3xxx) → imports (IMP5xxx) — later rules depend on the wrapper existing.

Import rules reuse the *known-type resolution set* `deterministicRemediationService.ts` already
builds (`resolved Maven coordinates + the app's own packages`); the analyzer's import table makes
IMP5001/5002 trivial (exact-duplicate and same-simple-name detection), IMP5003 requires
member-name usage scanning (warning-only), IMP5004 follows the JLS §7.5 shadowing order.

---

## 6. Tier-3 — javac Oracle ("types and declarations are correct")

Tiers 1–2 cannot type-check (`int x = "a";` parses). The authoritative check for *types and
declarations* is the JDK itself, and we already know which one the job uses:

```ts
// src/core/javacOracle.ts
export interface JavacCheckOptions {
  javaHome?: string | null;      // Config.jdkHomeForVersion(job.detectedJavaMajorVersion)
  classpath?: string[];          // resolved dep jars from DependencyResolution
  release?: number;              // --release N (preferred over -source/-target; also gates the API)
}

export async function javacCheckFile(filePath: string, opts: JavacCheckOptions): Promise<JavaDiagnostic[]> {
  // <javaHome>/bin/javac -proc:none --release N -cp <deps> -d <tmpdir> -Xmaxerrs 50 file
  // parse stderr "File.java:12: error: ..." + caret line into JavaDiagnostic
}
```

Design decisions:
- **`-proc:none`** — no annotation processing (we're checking compilability, not running processors).
- **`--release N`** instead of `-source/-target` — also validates against the N-era platform API,
  so calls to post-N `java.*` APIs are flagged too (a decompiled class may reference a method that
  only exists in newer JDKs).
- **Whole-file, not whole-project** — the project-wide run stays with `mavenVerifyService.ts`;
  the oracle exists to give the *fix loop* an exact oracle per file without a 30 s Maven cycle.
- Parse `error:`/`warning:` lines into the same `JavaDiagnostic` shape (codes `JVC6xxx`) so the
  fixer and AI prompt treat oracle output and CST output uniformly.
- Graceful degradation: JDK home not configured → tier skipped, noted in the report.

---

## 7. Integration Changes (consumers)

1. **`javaSyntaxCheck.ts`** — `checkJavaSyntax()` reimplemented as
   `(await analyzeJavaFile(source)).valid ? {valid:true} : {valid:false, error:firstDiagnostic}`,
   keeping the exact current behavior for all six callers. New exports sit beside it.
2. **`decompileJobService.ts` (~line 416)** — after `methodPatcherService` produces
   `patchedSource`, run `fixJavaFile()` first; accept if `analysis.valid` afterwards. Recovers
   patches that fail today for mechanical reasons (missing wrapper, duplicate member).
3. **`aiRemediationService.ts` (~line 233)** —
   - Prompt: replace the raw first-error string with the full structured diagnostic list (code +
     line + message), and append the JDK-gate target line (`target is Java N; do not use …`).
   - Acceptance: accept the AI fix only if `analysis.diagnostics.filter(e).length` **decreases**
     vs. the pre-fix analysis (prevents "parses but moved the error" fixes, which today count as
     success and burn a Maven cycle).
4. **`candidateScoringService.ts`** — replace its failure-marker/brace heuristics' syntax verdict
   with the analyzer's weighted error count (`error = 10 pts, warning = 1 pt`), folded into the
   existing score; JDK-gate violations when `job.targetJavaVersion` is set count as errors.
5. **`deterministicRemediationService.ts`** — delete its private `getParseJava()`; import from
   `core/javaParser.ts`. Its `insertMissingCastsAst()` CST-offset technique becomes the shared
   `applyTokenEdit()` helper in `javaParser.ts`.
6. **`mavenVerifyService.ts`** — no change; remains the final authority. The new tiers only reduce
   how often we reach Maven with garbage.

---

## 8. Testing Plan

- `tests/core/javaAnalyzer.test.ts` — one fixture per diagnostic code (a deliberately broken
  `.java` string), asserting code/line/column. Include the **live-confirmed regression fixtures**
  from the existing comments: the CFR broken try/catch/finally file and the JEP-445 bare-method
  fragment.
- `tests/core/javaFixer.test.ts` — (broken, expectedFixed) pairs per rule, plus *idempotence*
  (`fix(fix(x)) == fix(x)`) and *fixpoint termination* assertions.
- `tests/core/jdkGate.test.ts` — feature matrix: each §4 feature parses clean when
  `javaVersion ≥ min`, emits `JDK4xxx` when below.
- `tests/core/javacOracle.test.ts` — gated on a JDK being present (`jdkHomeForVersion()` non-null),
  asserts `int x = "a";` is caught and mapped to a `JVC6xxx` diagnostic at the right line.
- End-to-end: a patched-method fixture through `decompileJobService`'s accept path.

## 9. Implementation Order (suggested)

1. `core/javaParser.ts` + analyzer skeleton (diagnostics, structure model) + backward-compat façade.
2. Structural checks JST2xxx + their fixes (biggest mechanical win: filename/package/public).
3. Member checks JMB3003/3004/3006/3007/3008 + fixes (the classic decompiler breakage set).
4. JDK feature gate + candidate-scoring integration.
5. Fixer pipeline + decompileJobService/aiRemediationService integration.
6. javac oracle + import rules (needs the known-type set plumbing).
