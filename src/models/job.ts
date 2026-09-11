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
 * BJavaDecompiler - job/pipeline data model.
 * Plain TS interfaces, no ORM — persisted as one JSON file per job (see services/jobStore.ts).
 */

export type JobStatus =
  | 'queued'
  | 'extracting'
  | 'resolving_dependencies'
  | 'decompiling'
  | 'scoring_candidates'
  | 'ai_reconstructing'
  | 'generating_project'
  | 'verifying_build'
  | 'completed'
  | 'completed_with_errors'
  | 'failed'
  | 'paused'
  | 'cancelled';

export type ControlSignal = 'none' | 'pause' | 'cancel';

export type DecompilerEngine = 'cfr' | 'vineflower' | 'jdcli' | 'jadx' | 'procyon';

/** 'manual' = user-picked via the Maven search feature (mavenSearchService.ts) after the
 * automatic passes left it 'unresolved' — see DecompileJobService.resolveDependency().
 * 'auto-class-match' = the same search picked automatically by voting across several of the
 * jar's own classes (mavenSearchService.ts's autoMatchDependency()) — lower confidence than a
 * human's pick, always surfaced as such in the UI/NOTES.md rather than presented as certain. */
/** 'provided-api' = a container-supplied Java EE/Jakarta EE API (javax.mail, javax.persistence,
 * etc.) recognized either from the static PROVIDED_API_CATALOG (dependencyResolutionService.ts —
 * a real, stable, standalone "-api" artifact on Maven Central, no jar needed at all) or from a
 * jar found under Config.javaEeProvidedLibsDirs (e.g. a real GlassFish/WildFly installation's own
 * lib/modules — the actual container implementation, install:install-file'd locally but never
 * decompiled, since it's the server's code, not the WAR's). Always paired with scope: 'provided'. */
export type DependencyConfidence = 'pom-properties' | 'sha1-match' | 'guess' | 'unresolved' | 'manual' | 'auto-class-match' | 'provided-api';

export interface DependencyResolution {
  jarName: string;
  sha1: string;
  groupId: string | null;
  artifactId: string | null;
  version: string | null;
  /** Maven classifier (e.g. "jdk15") — set only for libraries that never publish a plain,
   * unclassified jar (confirmed real case: net.sf.json-lib:json-lib has a valid POM and shows
   * up in Central's search index at every version, but the plain jar 404s forever; only the
   * jdk13/jdk15-classified jars actually exist). Derived from the WAR's own original jar
   * filename — see dependencyResolutionService.ts's classifierFromFilename(). Null for the
   * overwhelming majority of dependencies that publish a normal unclassified jar. */
  classifier: string | null;
  scope: 'compile' | 'provided' | 'runtime';
  confidence: DependencyConfidence;
  /** Set only for 'unresolved' entries where CFR successfully decompiled the jar (relative
   * path under the job's workspace). When set, this dependency's source gets compiled directly
   * into the project (as an extra source root) instead of being left as an opaque placeholder
   * <dependency> that just wraps the original binary jar — real, reviewable source beats a
   * black-box install for something with no identifiable public origin. */
  decompiledSourceDir: string | null;
  /** Basename of a jar in Config.sharedDependenciesDirs that this dependency's groupId/artifactId/
   * version were derived from (see dependencyResolutionService.ts's matchSharedLibrary()). Only
   * ever set alongside confidence 'unresolved' — the match upgrades the placeholder's identity
   * from the generic com.bjavadecompiler.unresolved namespace to something real, but never the
   * confidence itself (these coordinates are still not Central-downloadable). Null whenever no
   * shared-dependencies folder is configured or nothing in it matched. Surfaced in the UI/
   * BJAVADECOMPILER-NOTES.md so "unresolved" doesn't read as "no lead at all" when it was in fact
   * identified from a local jar the user already had. */
  sharedLibrarySource: string | null;
}

export type AiClassStatus = 'skipped_clean' | 'sent' | 'reconstructed' | 'failed_fallback';

export interface ClassCandidate {
  /** Fully-qualified binary name, e.g. com/example/Foo (outer class — inner classes travel with it). */
  fqcn: string;
  winningEngine: DecompilerEngine | null;
  scores: Partial<Record<DecompilerEngine, number>>;
  failureMarkers: Partial<Record<DecompilerEngine, string[]>>;
  /** Whether the WINNING engine's file actually parses as valid Java (via a real grammar
   * parser, not a heuristic) — false means every candidate for this class failed to parse and
   * the "winner" is just the least-bad of a bad lot; always needs AI attention regardless of
   * failure markers or naming. Null only when there was no winner at all. */
  winnerSyntaxValid: boolean | null;
  aiStatus: AiClassStatus;
  /** Diagnostic notes from variableConflictDetector.ts against the WINNING engine's source —
   * e.g. a single identifier reassigned incompatible-looking values across the file (the classic
   * CFR/Vineflower slot-reuse corruption). Empty when none were found or there was no winner.
   * Surfaced to the AI reconstruction/remediation prompts as explicit diagnostics, and also
   * forces AI reconstruction even for a candidate that otherwise parses cleanly and has no
   * failure markers — this corruption is frequently syntactically valid Java, so it can't be
   * caught by winnerSyntaxValid alone. */
  variableConflicts: string[];
}

export interface BuildAttempt {
  attempt: number;
  success: boolean;
  errorCount: number;
  /** File path -> error lines, for whatever failed this attempt. */
  errorsByFile: Record<string, string[]>;
  timestamp: string;
}

export interface JobLogEntry {
  timestamp: string;
  level: 'info' | 'warn' | 'error';
  message: string;
}

export interface DetectedFramework {
  id: string;
  label: string;
  confidence: 'confirmed' | 'inferred';
  evidence: string;
}

/** 'resolved' = found in exactly one Config.sharedDependenciesDirs jar, installed and added as a
 * new dependency (resolvedVia names it). 'ambiguous' = supplied by more than one shared jar,
 * left unresolved rather than guessed (candidateJars lists them). 'not_found' = a shared-
 * dependencies search actually ran and found nothing. 'not_configured' = no shared-dependencies
 * folder is set at all, so no search was even attempted. */
export type MissingPackageStatus = 'resolved' | 'ambiguous' | 'not_found' | 'not_configured';

export interface MissingPackageEntry {
  package: string;
  status: MissingPackageStatus;
  resolvedVia: string | null;
  candidateJars: string[];
}

export interface ExcludedUnfixableFile {
  /** Path relative to the generated project root, e.g. lib-src/log4j/org/apache/log4j/jmx/Agent.java. */
  relativePath: string;
  reason: string;
  timestamp: string;
}

export interface DecompileJob {
  id: string;
  originalFilename: string;
  inputType: 'war' | 'jar';
  /** Detected from the archive's internal layout (BOOT-INF vs WEB-INF vs flat) during
   * extraction — null until then. Drives pom.xml plugin selection and BJAVADECOMPILER-NOTES.md. */
  appType: 'spring-boot' | 'java-ee' | 'plain-jar' | null;
  /** Frameworks detected from dependency coordinates + descriptor files
   * (see frameworkDetectionService.ts) — surfaces in the UI/NOTES and drives pom enhancements. */
  detectedFrameworks: DetectedFramework[] | null;
  detectedPrimaryFramework: string | null;
  status: JobStatus;
  controlSignal: ControlSignal;
  createdAt: string;
  updatedAt: string;
  phaseTimestamps: Partial<Record<JobStatus, string>>;

  classes: ClassCandidate[];
  dependencies: DependencyResolution[];
  buildAttempts: BuildAttempt[];
  detectedJavaMajorVersion: number | null;
  /** User's explicit choice of Java release to compile against (e.g. this WAR needs Java 8 even
   * though it's being decompiled on a machine running JDK 17 in NetBeans) — set once at job
   * creation (see DecompileJobService.startJob's options), takes precedence over both the
   * bytecode-detected version and Config.defaultTargetJavaVersion. Null means "no explicit
   * choice, use the global default or auto-detect" — see decompileJobService.ts's Stage 6. */
  targetJavaVersion: number | null;
  /** Broken-artifact coordinates found during build verification that don't match any of this
   * job's own tracked dependencies — i.e. a TRANSITIVE dependency pulled in by something else,
   * not one of the WAR's own WEB-INF/lib jars, so there's no original jar to decompile.
   * Excluded from every top-level <dependency> in the generated pom.xml instead (see
   * projectGeneratorService.ts) — safe when the classes it would have provided are already
   * covered by an inlined lib-src/ (its sibling top-level jar got demoted the same way), and
   * flagged in BJAVADECOMPILER-NOTES.md either way for manual review if something still needs it. */
  transitiveExclusions: { groupId: string; artifactId: string }[];

  /** Every Java package `mvn compile` reported as entirely missing (`package X does not exist`)
   * at some point during this job's build-fix loop — i.e. a class the decompiled code references
   * that was never bundled in the WAR's own WEB-INF/lib at all, so dependencyResolutionService.ts
   * never had a jar to resolve in the first place (see sharedLibraryPackageSearchService.ts,
   * which is what actually searches Config.sharedDependenciesDirs for a jar that supplies it).
   * One entry per unique package name for the life of the job — surfaced in the UI/NOTES.md so
   * "what's still missing and why" doesn't require digging through raw build-attempt logs. */
  missingPackages: MissingPackageEntry[];

  /** Decompiled-dependency source files moved out of the compiled path by
   * deadCodePruningService.ts (Config.pruneUnfixableDecompiledClasses, off by default) because
   * they reference a package nothing can supply and nothing else in the project references them
   * (confirmed real case: log4j's own bundled, never-instantiated JMSAppender/JMX Agent classes,
   * which need com.sun.jdmk.comm — a Sun JVM extension with no Maven artifact under any
   * coordinate). Files are relocated to workspace excluded-unfixable-classes/, never deleted —
   * this list is what makes that decision inspectable after the fact rather than a silent edit. */
  excludedUnfixableFiles: ExcludedUnfixableFile[];

  log: JobLogEntry[];
  errorMessage: string | null;
  /** The exact subprocess command currently in flight (e.g. `java -jar tools/cfr-0.152.jar ...`
   * or `mvn -q -DskipTests compile`), for a live "what's happening right now" dashboard box —
   * distinct from `log`, which is the historical record. Null when nothing is running (between
   * stages, or job finished/paused/failed). */
  currentOperation: string | null;

  /** Paths are relative to data/workspaces/<jobId>/ */
  workspaceDir: string;
  generatedProjectDir: string | null;
}

export function newJobSkeleton(
  id: string, originalFilename: string, inputType: 'war' | 'jar', targetJavaVersion: number | null = null,
): DecompileJob {
  const now = new Date().toISOString();
  return {
    id,
    originalFilename,
    inputType,
    appType: null,
    detectedFrameworks: null,
    detectedPrimaryFramework: null,
    status: 'queued',
    controlSignal: 'none',
    createdAt: now,
    updatedAt: now,
    phaseTimestamps: { queued: now },
    classes: [],
    dependencies: [],
    buildAttempts: [],
    detectedJavaMajorVersion: null,
    targetJavaVersion,
    transitiveExclusions: [],
    missingPackages: [],
    excludedUnfixableFiles: [],
    log: [],
    errorMessage: null,
    currentOperation: null,
    workspaceDir: id,
    generatedProjectDir: null,
  };
}
