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
 * BJavaDecompiler - pipeline orchestrator.
 *
 * Mirrors the job-state-machine / pause-resume / self-heal shape of
 * c:\PhpProjects\SysAdminCenterHCP\src\services\serverConverterService.ts, adapted for a
 * decompile-and-reconstruct pipeline instead of a server migration. Stage-level resumption:
 * extraction/dependency-resolution/decompilation/scoring/project-generation are treated as
 * fast, effectively-atomic steps (matching the plan's call to only check pause/cancel "between
 * AI batches and build-fix attempts" — the two genuinely slow, interruptible loops); resuming a
 * paused job re-enters the pipeline at its current `status` and reuses whatever's already on
 * disk/in job.classes/job.dependencies from the interrupted run rather than starting over.
 */

import fs from 'fs';
import path from 'path';
import { Config } from '../config/config';
import { Logger } from '../core/logger';
import { ApiError } from '../core/apiError';
import { newJobSkeleton, DecompileJob, DecompilerEngine, DependencyResolution, MissingPackageEntry } from '../models/job';
import { JobStore, TERMINAL_STATUSES } from './jobStore';
import { extract } from './extractionService';
import { resolveDependencies, updateCachedResolution, verifyArtifactResolvable, sha1OfFile, findProvidedApiForPackage } from './dependencyResolutionService';
import { buildSharedLibraryPackageIndex, buildJavaEeProvidedLibsIndex, buildWorkspaceDecompiledLibsIndex, buildManualSourceLibraryIndex, mergeSourceLibraryIndexes, resolveMissingPackage, SharedPackageMatch } from './sharedLibraryPackageSearchService';
import { pruneUnfixableFiles } from './deadCodePruningService';
import { decompileUnresolvedDependencies, copyDirRecursive } from './unresolvedLibDecompiler';
import { detectFrameworks } from './frameworkDetectionService';
import { ensureEngine, EngineStatus } from '../core/externalTools';
import { runAllDecompilers, DecompileRunResult } from './decompilerRunner';
import { scoreAllCandidates, findFailureMarkers } from './candidateScoringService';
import { cleanKnownDecompilerArtifacts } from './decompilerArtifactCleanup';
import { checkJavaSyntax } from '../core/javaSyntaxCheck';
import { runAiReconstruction } from './aiReconstructionService';
import { patchAllBrokenMethods } from './methodPatcherService';
import { generateProject, detectJavaVersionFromClassFile, deriveGroupArtifact } from './projectGeneratorService';
import { verifyBuild, installUnresolvedDependencies, buildResultSignature } from './mavenVerifyService';
import { remediate } from './aiRemediationService';
import { remediateDeterministically } from './deterministicRemediationService';
import { listJarClasses, autoMatchDependency } from './mavenSearchService';
import { buildProjectSymbolTable, ProjectSymbolTable } from './bytecodeMetadataService';

const logger = Logger.getLogger('DecompileJobService');

class ControlSignalHalt extends Error {
  constructor(public signal: 'pause' | 'cancel') { super(`Job halted by control signal: ${signal}`); }
}

function checkControlSignal(job: DecompileJob): void {
  const fresh = JobStore.get(job.id);
  if (fresh && (fresh.controlSignal === 'pause' || fresh.controlSignal === 'cancel')) {
    throw new ControlSignalHalt(fresh.controlSignal);
  }
}

function workspaceDirOf(job: DecompileJob): string {
  return path.join(Config.workspacesPath, job.workspaceDir);
}

export class DecompileJobService {
  static list() {
    return JobStore.list();
  }

  static get(id: string): DecompileJob | null {
    return JobStore.get(id);
  }

  /**
   * "Clear All Jobs" — deletes every job record AND its workspace directory (extracted files,
   * decompiled sources, the generated project, everything under data/workspaces/<id>/), for
   * disk-space cleanup or just tidying up the Jobs list. Only touches jobs in a genuinely
   * terminal state (completed/completed_with_errors/failed/cancelled) — a 'paused' job is
   * interrupted-but-resumable and is deliberately left alone rather than silently discarded, and
   * anything still actively running can't reach this code path with a stale in-memory status
   * anyway (see JobStore.loadAll()'s own stuck-job handling). Best-effort per job: one job's
   * workspace failing to delete (e.g. a file still open elsewhere) doesn't abort the rest.
   */
  static clearTerminalJobs(): { cleared: number; skipped: number } {
    const jobs = JobStore.list();
    let cleared = 0;
    let skipped = 0;
    for (const job of jobs) {
      if (!TERMINAL_STATUSES.includes(job.status)) { skipped++; continue; }
      try {
        fs.rmSync(workspaceDirOf(job), { recursive: true, force: true });
      } catch (err: any) {
        logger.warn(`Could not fully remove workspace for job ${job.id}: ${err.message}`);
      }
      JobStore.remove(job.id);
      cleared++;
    }
    logger.info(`Cleared ${cleared} terminal job(s), left ${skipped} paused/active job(s) untouched.`);
    return { cleared, skipped };
  }

  static requestPause(id: string): void {
    const job = JobStore.get(id);
    if (!job) return;
    job.controlSignal = 'pause';
    JobStore.save(job);
  }

  static requestCancel(id: string): void {
    const job = JobStore.get(id);
    if (!job) return;
    job.controlSignal = 'cancel';
    JobStore.save(job);
  }

  static resume(id: string): void {
    const job = JobStore.get(id);
    if (!job) return;
    if (job.status !== 'paused') return;
    job.controlSignal = 'none';
    JobStore.save(job);
    // Fire-and-forget, matching startJob's async pattern.
    DecompileJobService.runPipeline(job.id).catch(err => logger.error(`Resume failed for ${id}: ${err.message}`));
  }

  /** Lists candidate fully-qualified class names from inside a still-unresolved dependency jar —
   * the UI offers these as one-click search terms for the Maven search feature (see
   * mavenSearchService.ts). Needs the cached extraction to map jarName back to its on-disk path;
   * returns [] before extraction has run rather than throwing, since the dependency panel may
   * poll a job that hasn't reached that stage yet. */
  static listDependencyClasses(jobId: string, jarName: string): string[] {
    const job = JobStore.get(jobId);
    if (!job) return [];
    const extraction = readCachedExtraction(job, workspaceDirOf(job));
    if (!extraction) return [];
    const jarPath = extraction.libJars.find(p => path.basename(p) === jarName);
    if (!jarPath) return [];
    return listJarClasses(jarPath);
  }

  /**
   * Applies a user-picked Maven coordinate to one dependency (typically one the automatic
   * resolution passes left 'unresolved') and regenerates + re-verifies the project — the
   * "search Maven repositories for the missing dependency" workflow, same idea as NetBeans'
   * search-in-repositories fix for a red import. Works on a job in any terminal state
   * (completed/completed_with_errors), not just mid-pipeline — this is a standalone fix-and-
   * rebuild operation, not a resume of the original pipeline run.
   */
  static async resolveDependency(
    jobId: string,
    jarName: string,
    coords: { groupId: string; artifactId: string; version: string },
  ): Promise<DecompileJob> {
    const job = JobStore.get(jobId);
    if (!job) throw ApiError.notFound('Job not found');
    const dep = job.dependencies.find(d => d.jarName === jarName);
    if (!dep) throw ApiError.notFound(`No dependency named ${jarName} on this job`);

    const workspace = workspaceDirOf(job);
    const extraction = readCachedExtraction(job, workspace);
    if (!extraction) throw ApiError.conflict('This job has not completed extraction yet — nothing to regenerate.');
    if (!job.generatedProjectDir) throw ApiError.conflict('This job has not generated a project yet — nothing to regenerate.');

    const projectDir = path.join(workspace, job.generatedProjectDir);
    // The old decompiled-and-inlined source (if any) is now superseded by a real coordinate —
    // remove it from the already-generated project so its classes don't collide with (or
    // silently shadow) the ones the real dependency jar provides.
    if (dep.decompiledSourceDir && dep.artifactId) {
      fs.rmSync(path.join(projectDir, 'lib-src', dep.artifactId), { recursive: true, force: true });
    }

    JobStore.appendLog(job, 'info', `Manually resolved ${jarName} -> ${coords.groupId}:${coords.artifactId}:${coords.version} — regenerating project and re-verifying build.`);
    dep.groupId = coords.groupId;
    dep.artifactId = coords.artifactId;
    dep.version = coords.version;
    dep.classifier = null;
    dep.confidence = 'manual';
    dep.decompiledSourceDir = null;
    JobStore.save(job);

    const javaVersion = job.targetJavaVersion || job.detectedJavaMajorVersion || Config.defaultTargetJavaVersion
      || Math.max(detectSampleJavaVersion(extraction.classesDir) || 17, 8);
    const javaHome = Config.jdkHomeForVersion(javaVersion);
    const rootPackage = job.classes[0]?.fqcn ? path.dirname(job.classes[0].fqcn) : null;
    const manifestVendorId = readManifestVendorId(extraction.extractedDir);
    const { groupId, artifactId } = deriveGroupArtifact(job.originalFilename, rootPackage, manifestVendorId);

    generateProject({
      projectDir,
      workspaceDir: workspace,
      groupId, artifactId,
      packaging: job.inputType,
      appType: extraction.appType,
      javaVersion,
      dependencies: job.dependencies,
      transitiveExclusions: job.transitiveExclusions,
      reconstructedSourcesDir: path.join(workspace, 'reconstructed'),
      resourceFiles: extraction.resourceFiles,
      resourceFilesRoot: extraction.classesDir,
      webappFiles: extraction.webappFiles,
      webappFilesRoot: extraction.extractedDir,
      classes: job.classes,
      hasEmptyClasses: extraction.hasEmptyClasses,
      extractionWarnings: extraction.warnings,
      detectedFrameworks: job.detectedFrameworks || undefined,
      detectedPrimaryFramework: job.detectedPrimaryFramework,
    });

    const finalBuild = await verifyBuild(projectDir, line => JobStore.logOperation(job, line), javaHome);
    JobStore.setCurrentOperation(job, null);
    job.buildAttempts.push({
      attempt: job.buildAttempts.length + 1, success: finalBuild.success, errorCount: finalBuild.errorCount,
      errorsByFile: finalBuild.errorsByFile, timestamp: new Date().toISOString(),
    });
    JobStore.setStatus(job, finalBuild.success ? 'completed' : 'completed_with_errors');
    JobStore.appendLog(job, finalBuild.success ? 'info' : 'warn',
      finalBuild.success ? 'Build succeeded after manual dependency fix.' : `Build still has ${finalBuild.errorCount} error(s) after manual dependency fix.`);
    return job;
  }

  static async startJob(
    inputFilePath: string, originalFilename: string, options?: { targetJavaVersion?: number | null },
  ): Promise<DecompileJob> {
    const id = require('uuid').v4();
    const inputType: 'war' | 'jar' = originalFilename.toLowerCase().endsWith('.war') ? 'war' : 'jar';
    const job = newJobSkeleton(id, originalFilename, inputType, options?.targetJavaVersion ?? null);
    JobStore.create(job);

    const workspace = workspaceDirOf(job);
    fs.mkdirSync(workspace, { recursive: true });
    const storedInput = path.join(workspace, `input.${inputType}`);
    fs.copyFileSync(inputFilePath, storedInput);

    // Fire-and-forget — the caller (the upload route) gets the job record back immediately
    // and polls GET /api/jobs/:id for progress, matching every other job-shaped feature in
    // this user's portfolio.
    DecompileJobService.runPipeline(id).catch(err => logger.error(`Pipeline crashed for ${id}: ${err.message}`, { stack: err.stack }));

    return job;
  }

  private static async runPipeline(jobId: string): Promise<void> {
    const job = JobStore.get(jobId);
    if (!job) return;
    const workspace = workspaceDirOf(job);
    const storedInput = path.join(workspace, `input.${job.inputType}`);

    try {
      // ─── Stage 1: extraction ─────────────────────────────────────
      let extraction = readCachedExtraction(job, workspace);
      if (!extraction) {
        JobStore.setStatus(job, 'extracting');
        JobStore.appendLog(job, 'info', 'Extracting archive...');
        extraction = extract(storedInput, job.originalFilename, workspace);
        for (const w of extraction.warnings) JobStore.appendLog(job, 'warn', w);
        writeCachedExtraction(workspace, extraction);
      }
      if (job.appType !== extraction.appType) {
        job.appType = extraction.appType;
        if (extraction.appType === 'spring-boot') JobStore.appendLog(job, 'info', 'Detected Spring Boot fat-jar layout (BOOT-INF/classes + BOOT-INF/lib) — scoping decompilation accordingly.');
        JobStore.save(job);
      }

      // ─── Stage 2: dependency resolution ──────────────────────────
      if (job.status === 'queued' || job.status === 'extracting' || job.dependencies.length === 0) {
        if (extraction.libJars.length > 0) {
          JobStore.setStatus(job, 'resolving_dependencies');
          JobStore.appendLog(job, 'info', `Resolving ${extraction.libJars.length} dependency jar(s)...`);
          job.dependencies = await resolveDependencies(extraction.libJars);
          JobStore.save(job);
        }
      }

      // ─── Framework detection (no AI — coordinate + descriptor analysis) ──
      // Identifies Spring Boot / Spring MVC / Struts / JPA / EJB / JSF / Jakarta EE / etc.
      // from the resolved dependency coordinates and descriptor files (web.xml,
      // persistence.xml, applicationContext.xml). Surfaces in the UI and NOTES.md, and lets
      // users know which runtime environment to pick when opening the project in NetBeans.
      if (job.detectedFrameworks === null) {
        const fw = detectFrameworks(
          job.dependencies,
          extraction.extractedDir,
          extraction.classesDir,
          extraction.extractedDir,
        );
        job.detectedFrameworks = fw.frameworks;
        job.detectedPrimaryFramework = fw.primary;
        if (fw.frameworks.length) {
          const list = fw.frameworks.map(f => f.label).join(', ');
          JobStore.appendLog(job, 'info', `Detected framework(s): ${list} (primary: ${fw.primary ? fw.primary : 'none'})`);
        }
        JobStore.save(job);
      }

      // ─── Ensure decompiler engines are installed (visible, not silent — Tool Setup
      // panel is expected to have already triggered downloads; this is a safety net) ──
      // Only the engines DECOMPILE_ENGINES actually selects — an engine dropped for speed
      // isn't installed, checked, or run at all, not just skipped at invocation time.
      const engineNames = Config.enabledEngines;
      const engineStatuses: Record<DecompilerEngine, EngineStatus> = {} as any;
      for (const name of engineNames) {
        engineStatuses[name] = await ensureEngine(name).catch(err => {
          JobStore.appendLog(job, 'warn', `Could not ensure ${name}: ${err.message}`);
          return { name, installed: false, version: null, jarPath: null, sizeBytes: null, checksumVerified: false };
        });
      }
      if (engineNames.length < 5) {
        JobStore.appendLog(job, 'info', `DECOMPILE_ENGINES restricts this run to: ${engineNames.join(', ')}.`);
      }

      // ─── Decompile unresolved dependencies (best engine per class) ─
      // No public Maven coordinate exists for these (almost always internal/proprietary libs),
      // so a placeholder install-file is a dead end for review — decompile them too and compile
      // their source directly into the project (see projectGeneratorService.ts). This is also
      // the single most expensive optional stage on a WAR with many bundled third-party jars
      // (every enabled engine × every unresolved jar, then AI-cleaning every flagged class in
      // each) — DECOMPILE_UNRESOLVED_LIBS=false skips it, falling back to the original opaque
      // install-file placeholder instead.
      if (!Config.decompileUnresolvedLibs) {
        if (job.dependencies.some(d => d.confidence === 'unresolved')) {
          JobStore.appendLog(job, 'info', 'DECOMPILE_UNRESOLVED_LIBS=false — leaving unresolved dependencies as binary install-file placeholders instead of decompiling them.');
        }
      } else if (!fs.existsSync(path.join(workspace, '.unresolved_libs_done')) && job.dependencies.some(d => d.confidence === 'unresolved')) {
        const libJarPathByName = new Map(extraction.libJars.map(p => [path.basename(p), p]));
        await decompileUnresolvedDependencies(job.dependencies, libJarPathByName, workspace, engineStatuses,
          msg => JobStore.logOperation(job, msg));
        JobStore.setCurrentOperation(job, null);
        fs.writeFileSync(path.join(workspace, '.unresolved_libs_done'), '1');
        JobStore.save(job);
        const decompiledCount = job.dependencies.filter(d => d.decompiledSourceDir).length;
        if (decompiledCount) JobStore.appendLog(job, 'info', `Decompiled ${decompiledCount} unresolved dependenc${decompiledCount === 1 ? 'y' : 'ies'} — will be compiled directly into the project.`);
      }

      // ─── Stage 3: decompilation ───────────────────────────────────
      let decompileResults: DecompileRunResult[] = readCachedDecompileResults(workspace);
      if (!decompileResults.length && !extraction.hasEmptyClasses) {
        JobStore.setStatus(job, 'decompiling');
        JobStore.appendLog(job, 'info', 'Running CFR, Vineflower, jd-cli, JADX, and Procyon...');
        decompileResults = await runAllDecompilers(extraction.classesDir, workspace, engineStatuses,
          line => JobStore.logOperation(job, line));
        JobStore.setCurrentOperation(job, null);
        for (const r of decompileResults) {
          const timing = r.durationMs !== undefined ? ` (${(r.durationMs / 1000).toFixed(1)}s)` : '';
          JobStore.appendLog(job, r.ran ? 'info' : 'warn', `[${r.engine}] ${r.ran ? 'produced output' : `failed: ${r.error}`}${timing}`);
        }
        writeCachedDecompileResults(workspace, decompileResults);
      }

      // Deterministic, no-AI fixup for known decompiler artifacts (e.g. CFR's duplicated
      // break; across switch-case boundaries) — cheap and idempotent, safe to run every time
      // regardless of whether decompileResults just came from a fresh run or the cache.
      for (const r of decompileResults) {
        if (!r.ran) continue;
        const fixedCount = cleanKnownDecompilerArtifacts(r.outputDir);
        if (fixedCount > 0) JobStore.appendLog(job, 'info', `[${r.engine}] auto-fixed ${fixedCount} file(s) with known decompiler artifacts (e.g. duplicated break/continue/return).`);
      }

      // ─── Stage 3b: bytecode metadata (javap) ───────────────────────
      // Project-wide symbol table (member visibility + debug-info completeness), mined directly
      // from the ORIGINAL .class files, not the decompiled output. Feeds candidate scoring (skip
      // slot-reuse heuristics on classes that kept real debug info), AI reconstruction (never
      // rename a member another, unseen file might reference), and AI remediation (same
      // debug-info skip). Best-effort: a javap failure here just degrades every consumer back to
      // its pre-existing, less-precise behavior — never fails the job.
      let symbolTable: ProjectSymbolTable | null = readCachedSymbolTable(workspace);
      if (!symbolTable) {
        JobStore.appendLog(job, 'info', 'Extracting bytecode metadata (javap) for rename-safety and debug-info detection...');
        symbolTable = await buildProjectSymbolTable(extraction.classesDir);
        writeCachedSymbolTable(workspace, symbolTable);
      }

      // ─── Stage 4: candidate scoring ───────────────────────────────
      if (job.classes.length === 0 && decompileResults.length) {
        JobStore.setStatus(job, 'scoring_candidates');
        job.classes = await scoreAllCandidates(decompileResults, undefined, symbolTable);
        JobStore.appendLog(job, 'info', `Scored ${job.classes.length} class(es) across engines.`);
        JobStore.save(job);
      }

      // ─── Stage 4b: cross-engine method-level patching (no AI) ─────
      // For each class where the winning engine has a broken method (failure marker or
      // syntax error), attempt to transplant the method body from another engine that
      // decompiled the same method cleanly. Runs BEFORE AI reconstruction — if method
      // patching fixes all broken methods in a class, that class no longer needs AI at all.
      checkControlSignal(job);
      if (job.classes.length > 0 && !fs.existsSync(path.join(workspace, '.method_patch_done'))) {
        const engineDirs: Partial<Record<DecompilerEngine, string>> = {};
        for (const r of decompileResults) if (r.ran) engineDirs[r.engine] = r.outputDir;
        const patchDir = path.join(workspace, 'patched');
        const patchResult = await patchAllBrokenMethods(job.classes, engineDirs, patchDir);
        if (patchResult.patchedFiles > 0) {
          JobStore.appendLog(job, 'info', `Method patching: patched ${patchResult.patchedMethods} method(s) across ${patchResult.patchedFiles} file(s) from donor engines (no AI needed).`);
          // Overwrite the winning engine's output with the patched version so AI reconstruction
          // and project generation pick up the patched source automatically.
          for (const candidate of job.classes) {
            const patchedPath = path.join(patchDir, `${candidate.fqcn}.java`);
            if (fs.existsSync(patchedPath) && candidate.winningEngine) {
              const winnerDir = engineDirs[candidate.winningEngine];
              if (winnerDir) {
                const dest = path.join(winnerDir, `${candidate.fqcn}.java`);
                fs.copyFileSync(patchedPath, dest);
                // Re-check if the class still needs AI reconstruction
                const patchedSource = fs.readFileSync(dest, 'utf8');
                const { valid } = await checkJavaSyntax(patchedSource);
                if (valid && candidate.failureMarkers[candidate.winningEngine]) {
                  // Clear markers if the patched source no longer has them
                  const remainingMarkers = findFailureMarkers(candidate.winningEngine, patchedSource);
                  if (remainingMarkers.length === 0) {
                    delete candidate.failureMarkers[candidate.winningEngine];
                    candidate.winnerSyntaxValid = true;
                    candidate.aiStatus = 'skipped_clean';
                  }
                }
              }
            }
          }
          JobStore.save(job);
        }
        fs.writeFileSync(path.join(workspace, '.method_patch_done'), '1');
      }

      // ─── Stage 5: AI reconstruction ────────────────────────────────
      const reconstructedDir = path.join(workspace, 'reconstructed');
      checkControlSignal(job);
      if (job.classes.length > 0 && !fs.existsSync(path.join(workspace, '.ai_reconstruction_done'))) {
        JobStore.setStatus(job, 'ai_reconstructing');
        JobStore.appendLog(job, 'info', 'Running AI reconstruction pass...');
        const engineDirs: Partial<Record<DecompilerEngine, string>> = {};
        for (const r of decompileResults) if (r.ran) engineDirs[r.engine] = r.outputDir;
        const result = await runAiReconstruction(job.classes, engineDirs, job.dependencies, reconstructedDir, symbolTable);
        JobStore.appendLog(job, 'info', `AI reconstruction: ${result.reconstructedCount} reconstructed, ${result.fallbackCount} fell back, ${result.skippedCount} skipped (already clean).`);
        fs.writeFileSync(path.join(workspace, '.ai_reconstruction_done'), '1');
        JobStore.save(job);
      }
      checkControlSignal(job);

      // ─── Stage 6: project generation ───────────────────────────────
      const projectDir = path.join(workspace, 'project');

      let javaVersion = job.detectedJavaMajorVersion;
      if (!javaVersion) {
        const detected = detectSampleJavaVersion(extraction.classesDir) || 17;
        // Confirmed live: maven-compiler-plugin 3.13.0 flatly refuses source/target below 8
        // ("Source option 6 is no longer supported. Use 8 or later.") — clamp rather than pass
        // an old app's real bytecode version straight through. Safe: Java 8+ is a syntactic
        // superset of 6/7, so compiling old-targeted source at a higher level changes nothing
        // about correctness, only which compiler can build it.
        javaVersion = Math.max(detected, 8);
        job.detectedJavaMajorVersion = javaVersion;
      }
      // An explicit per-job choice (DecompileJobService.startJob's options) or, failing that, a
      // global Config.defaultTargetJavaVersion always overrides the bytecode-detected value —
      // e.g. this WAR is known to need Java 8 in NetBeans even though its own decompiled bytecode
      // detects differently, or every job on this machine should default to a specific release.
      const versionOverride = job.targetJavaVersion || Config.defaultTargetJavaVersion;
      if (versionOverride && versionOverride !== javaVersion) {
        javaVersion = versionOverride;
        job.detectedJavaMajorVersion = javaVersion;
      }
      // When Config.jdkHomeOverrides has a real JDK installation registered for this exact
      // release, every mvn invocation below runs under THAT JDK's own javac (JAVA_HOME/PATH
      // override) instead of whatever satisfies toolchainCheck.ts's own floor — see
      // mavenVerifyService.ts's envForJavaHome(). Null (the default) changes nothing.
      const javaHome = Config.jdkHomeForVersion(javaVersion);
      if (javaHome) JobStore.appendLog(job, 'info', `Compiling against Java ${javaVersion} using configured JDK home: ${javaHome}`);
      const rootPackage = job.classes[0]?.fqcn ? path.dirname(job.classes[0].fqcn) : null;
      const manifestVendorId = readManifestVendorId(extraction.extractedDir);
      const { groupId, artifactId } = deriveGroupArtifact(job.originalFilename, rootPackage, manifestVendorId);

      // Re-callable so Stage 7 can regenerate pom.xml/lib-src after demoting a dependency that
      // turned out not to actually resolve (see the broken-artifact handling below) — same
      // inputs, just re-run after job.dependencies has been mutated.
      const regenerateProject = () => generateProject({
        projectDir,
        workspaceDir: workspace,
        groupId, artifactId,
        packaging: job.inputType,
        appType: extraction.appType,
        javaVersion: javaVersion!,
        dependencies: job.dependencies,
        transitiveExclusions: job.transitiveExclusions,
        missingPackages: job.missingPackages,
        excludedUnfixableFiles: job.excludedUnfixableFiles,
        reconstructedSourcesDir: reconstructedDir,
        resourceFiles: extraction.resourceFiles,
        resourceFilesRoot: extraction.classesDir,
        webappFiles: extraction.webappFiles,
        webappFilesRoot: extraction.extractedDir,
        classes: job.classes,
        hasEmptyClasses: extraction.hasEmptyClasses,
        extractionWarnings: extraction.warnings,
        detectedFrameworks: job.detectedFrameworks || undefined,
        detectedPrimaryFramework: job.detectedPrimaryFramework,
      });

      if (!fs.existsSync(projectDir)) {
        JobStore.setStatus(job, 'generating_project');
        JobStore.appendLog(job, 'info', 'Generating Maven project...');
        regenerateProject();
        job.generatedProjectDir = 'project';
        JobStore.save(job);
      }

      // ─── Stage 7: build verification + self-healing retries ─────────
      checkControlSignal(job);
      JobStore.setStatus(job, 'verifying_build');

      const jarPathByName = new Map(extraction.libJars.map(p => [path.basename(p), p]));
      const aiTouchedFiles = new Set(
        job.classes.filter(c => c.aiStatus === 'reconstructed').map(c => path.join(projectDir, 'src', 'main', 'java', `${c.fqcn}.java`))
      );

      // Decompiled-and-inlined ones (see the CFR step above) are compiled directly into the
      // project now — no placeholder binary to install for those anymore.
      const unresolved = job.dependencies.filter(d => d.confidence === 'unresolved' && !d.decompiledSourceDir);
      if (unresolved.length) {
        JobStore.appendLog(job, 'info', `Installing ${unresolved.length} unresolved dependency placeholder(s) into local Maven repo...`);
        await installUnresolvedDependencies(projectDir, unresolved, jarPathByName, line => JobStore.logOperation(job, line), javaHome);
      }

      let finalBuild = await verifyBuild(projectDir, line => JobStore.logOperation(job, line), javaHome);
      JobStore.setCurrentOperation(job, null);
      let attemptNum = job.buildAttempts.length + 1;
      job.buildAttempts.push({
        attempt: attemptNum, success: finalBuild.success, errorCount: finalBuild.errorCount,
        errorsByFile: finalBuild.errorsByFile, timestamp: new Date().toISOString(),
      });
      JobStore.save(job);

      // Lazily built on first use (only when a missing-package failure actually shows up, and
      // only once — the shared-dependencies folder can't meaningfully change mid-run) and shared
      // across every remaining attempt below. attemptedMissingPackages stops the same package
      // that genuinely has no match anywhere in shared-libs from being re-logged/re-searched on
      // every subsequent attempt for the rest of the job.
      let sharedPackageIndex: Map<string, string[]> | null = null;
      let workspaceLibsIndex: Map<string, { jobId: string; artifactId: string; dir: string }[]> | null = null;
      let javaEeProvidedLibsIndex: Map<string, string[]> | null = null;
      // Defensive default for a job persisted before this field existed (jobStore.ts loads job
      // JSON with no schema migration) — a resumed old job must never throw on `.push()` below.
      // Seeded from any entries already on the job (a prior stage-7 run this same job went
      // through) so a resume doesn't re-search/re-log a package already settled last time.
      if (!job.missingPackages) job.missingPackages = [];
      if (!job.excludedUnfixableFiles) job.excludedUnfixableFiles = [];
      const attemptedMissingPackages = new Set<string>(job.missingPackages.map(e => e.package));

      while (!finalBuild.success && job.buildAttempts.length < Config.maxBuildFixAttempts) {
        checkControlSignal(job);
        JobStore.appendLog(job, 'warn', `Build attempt ${attemptNum} failed with ${finalBuild.errorCount} error(s) — attempting remediation.`);
        // Confirmed live: once every remaining error is in `likelyDependencyIssue` (no
        // re-resolution attempt exists for that bucket in this loop), deterministic+AI both
        // become permanent no-ops — every further attempt re-verifies the exact same unchanged
        // project and burns a full mvn compile for nothing (7 of 15 attempts wasted this way in
        // one real run). Track the error count this attempt started with and bail out early the
        // first time a full attempt (deterministic + AI) makes zero net progress, instead of
        // spinning through the rest of Config.maxBuildFixAttempts. errorSignatureAtAttemptStart is
        // tracked alongside the count — confirmed real case: a broken direct dependency getting
        // demoted/auto-matched exposed a DIFFERENT broken transitive dependency at the exact same
        // count (2 -> 2), and count-only comparison bailed out before the exclusion logic below
        // ever got a second attempt at the newly-exposed problem. Only bail when BOTH the count
        // AND the underlying broken-artifacts/errored-files/missing-packages signature are
        // unchanged — see buildResultSignature() in mavenVerifyService.ts.
        let errorCountAtAttemptStart = finalBuild.errorCount;
        let errorSignatureAtAttemptStart = buildResultSignature(finalBuild);

        // A resolved dependency that turns out not to actually resolve (confirmed live: an old
        // jar matched a real Central artifact whose own declared parent POM had since been
        // deleted) is a project-wide failure no source-level AI fix can touch. Demote it to
        // 'unresolved' and decompile it instead — the exact same fallback already used
        // for dependencies that never matched anything in the first place — then regenerate the
        // project so pom.xml drops the dead <dependency> in favor of the new lib-src/ entry.
        if (finalBuild.brokenArtifacts.length > 0) {
          const toDemote: DependencyResolution[] = finalBuild.brokenArtifacts
            .map(ba => job.dependencies.find(d => d.groupId === ba.groupId && d.artifactId === ba.artifactId))
            .filter((d): d is DependencyResolution => !!d && !d.decompiledSourceDir);
          // A broken artifact with no match in job.dependencies isn't one of the WAR's own
          // jars at all — it's TRANSITIVE (pulled in by something else), so there's no original
          // jar to decompile. Exclude it from every dependency instead (see
          // projectGeneratorService.ts); flagged in NOTES.md either way for manual review.
          const toExclude = finalBuild.brokenArtifacts.filter(ba =>
            !job.dependencies.some(d => d.groupId === ba.groupId && d.artifactId === ba.artifactId) &&
            !job.transitiveExclusions.some(e => e.groupId === ba.groupId && e.artifactId === ba.artifactId)
          );

          if (toDemote.length) {
            JobStore.appendLog(job, 'warn', `${toDemote.length} matched dependenc${toDemote.length === 1 ? 'y' : 'ies'} failed to actually resolve on Maven Central (broken upstream POM): ${toDemote.map(d => d.jarName).join(', ')}`);
            // The guess that got here was WRONG (real artifact, doesn't actually build) — before
            // falling back to decompiling the original jar, try the smarter class-name auto-match
            // (same one dependencyResolutionService.ts's own last-resort pass uses), since it's
            // specifically good at recovering from exactly this failure mode (confirmed real
            // case: a jar named "mail.jar" guessed as the unrelated "com.ritense.valtimo:mail" —
            // auto-match instead finds the real javax.mail:javax.mail-api by voting across the
            // jar's own classes). Only what auto-match still can't fix falls through to decompile.
            const stillToDecompile: DependencyResolution[] = [];
            for (const d of toDemote) {
              d.confidence = 'unresolved';
              const jarPath = jarPathByName.get(d.jarName);
              let autoFixed = false;
              if (Config.autoMatchUnresolvedDeps && jarPath) {
                try {
                  const auto = await autoMatchDependency(jarPath);
                  if (auto) {
                    // Verify the auto-match actually has a downloadable jar on Central before
                    // accepting it — confirmed real case: this exact recovery path re-guessed
                    // net.sf.json-lib:json-lib:1.1 for a jar named json-lib-1.1-jdk13.jar on
                    // every single build-fix attempt (the coordinate has a valid POM and shows
                    // up in search, but json-lib only ever publishes classified jars), so without
                    // this check the loop never converges and burns every remaining attempt on
                    // the identical dead guess. A classifier recovered from the WAR's own
                    // filename (see classifierFromFilename in dependencyResolutionService.ts) is
                    // tried before giving up.
                    const verify = await verifyArtifactResolvable(auto.groupId, auto.artifactId, auto.version, d.jarName);
                    if (verify.ok) {
                      d.groupId = auto.groupId; d.artifactId = auto.artifactId; d.version = auto.version;
                      d.classifier = verify.classifier;
                      d.confidence = 'auto-class-match';
                      JobStore.appendLog(job, 'info', `Auto-matched ${d.jarName} -> ${auto.groupId}:${auto.artifactId}:${auto.version}${verify.classifier ? `:${verify.classifier}` : ''} (${auto.agreeingClasses}/${auto.sampledClasses} sampled classes agreed) instead of decompiling.`);
                      autoFixed = true;
                    } else {
                      JobStore.appendLog(job, 'warn', `Auto-matched coordinate ${auto.groupId}:${auto.artifactId}:${auto.version} for ${d.jarName} has no downloadable jar on Central — decompiling instead.`);
                    }
                  }
                } catch (err: any) {
                  JobStore.appendLog(job, 'warn', `Class-name auto-match failed for ${d.jarName}: ${err.message}`);
                }
              }
              // Either way the guess was wrong — never let it linger in the cache and keep
              // poisoning future jobs with the same jar bytes, whether or not auto-match saved it.
              updateCachedResolution(d.sha1, autoFixed ? { groupId: d.groupId!, artifactId: d.artifactId!, version: d.version!, classifier: d.classifier, confidence: 'auto-class-match' } : null);
              if (!autoFixed) stillToDecompile.push(d);
            }
            if (stillToDecompile.length) {
              JobStore.appendLog(job, 'info', `Decompiling ${stillToDecompile.length} dependenc${stillToDecompile.length === 1 ? 'y' : 'ies'} auto-match couldn't fix: ${stillToDecompile.map(d => d.jarName).join(', ')}`);
              await decompileUnresolvedDependencies(stillToDecompile, jarPathByName, workspace, engineStatuses,
                msg => JobStore.logOperation(job, msg));
              JobStore.setCurrentOperation(job, null);
            }
          }
          if (toExclude.length) {
            JobStore.appendLog(job, 'warn', `${toExclude.length} broken transitive dependenc${toExclude.length === 1 ? 'y' : 'ies'} (not one of this WAR's own jars) excluded: ${toExclude.map(e => `${e.groupId}:${e.artifactId}`).join(', ')}`);
            job.transitiveExclusions.push(...toExclude);
          }
          if (toDemote.length || toExclude.length) {
            regenerateProject();
            JobStore.save(job);

            // A dependency-resolution-level failure (what toDemote/toExclude just fixed) can
            // block Maven from even ATTEMPTING to compile a single class — confirmed real case:
            // `finalBuild` at this point was still attempt-1's result, a pure resolution failure
            // with an EMPTY errorsByFile (0 per-file errors surfaced, even though the real
            // per-file error count for this project was already in the thousands). Re-verify now
            // so deterministic/AI remediation below — and the "no net progress" check at the end
            // of this loop iteration — both work against the TRUE, currently-visible error set
            // instead of that stale pre-fix data. Without this, remediateDeterministically()/
            // remediate() ran against an empty errorsByFile (nothing to fix, correctly reported
            // "0 fixed"), and the end-of-attempt progress check then compared the newly-revealed
            // true error count against the OLD pre-fix count — making a dependency-resolution fix
            // that was actually necessary progress look like a catastrophic regression, and
            // aborting the entire retry loop before deterministic/AI remediation ever got a
            // chance to run against the real errors (which they are often very effective against
            // — see insertMissingCastsForRawMethodCalls()'s history in deterministicRemediationService.ts).
            finalBuild = await verifyBuild(projectDir, line => JobStore.logOperation(job, line), javaHome);
            JobStore.setCurrentOperation(job, null);
            attemptNum = job.buildAttempts.length + 1;
            job.buildAttempts.push({
              attempt: attemptNum, success: finalBuild.success, errorCount: finalBuild.errorCount,
              errorsByFile: finalBuild.errorsByFile, timestamp: new Date().toISOString(),
            });
            JobStore.save(job);
            if (finalBuild.success) continue;
            // Reset the "no progress" baseline to what remediation below is actually about to
            // work against — NOT the stale pre-dependency-fix count from the top of this attempt.
            errorCountAtAttemptStart = finalBuild.errorCount;
            errorSignatureAtAttemptStart = buildResultSignature(finalBuild);
            // Maven's dependency resolver stops at the FIRST broken artifact it hits in the
            // graph — fixing one can unmask a completely different, already-present one further
            // down (confirmed real case: toDemote auto-matching a broken tomahawk-1.1.3.jar
            // immediately unmasked an already-present javax.mail:mail/javax.activation:activation
            // transitive failure from commons-email that Maven had never even gotten to report
            // yet). Without this, the newly-exposed brokenArtifacts fell through to
            // deterministic/AI remediation below — both no-ops against a pure dependency-
            // resolution failure (empty errorsByFile) — and the unconditional re-verify at the
            // bottom of this loop iteration reproduced the exact same reset baseline, tripping
            // the "no progress" bail-out at the end of this same iteration before a fresh
            // iteration's top-of-loop check ever got a chance to run THIS SAME toDemote/toExclude
            // logic against them. `continue` sends it there immediately instead.
            if (finalBuild.brokenArtifacts.length > 0) continue;
          }
        }

        // Classes the decompiled source references that were never bundled in this WAR's own
        // WEB-INF/lib at all (confirmed real case: FhcIntfSolProj.war referencing
        // com.wovenware.icgrid.* classes that live in an entirely separate product module) — the
        // brokenArtifacts handling above can't touch these, since there's no existing
        // job.dependency to demote/exclude in the first place, only a bare package name from
        // javac's own "package X does not exist". Searches Config.sharedDependenciesDirs +
        // Config.missingPackagesSearchDirs (jars, by class table) and, if enabled, every OTHER
        // job's own decompiled-libs output (see sharedLibraryPackageSearchService.ts) for
        // something that supplies it and, if found unambiguously, adds it as a brand-new
        // dependency the WAR never had. Every package seen (resolved or not) is recorded on
        // job.missingPackages so the UI can show the full "what's still missing and why" picture,
        // not just the ones that got fixed.
        const newMissingPackages = finalBuild.missingPackages.filter(p => !attemptedMissingPackages.has(p));
        // Populated by whichever pass(es) below actually resolve something this attempt — checked
        // together, after the whole Pass 0/1/general-search chain, to decide whether a
        // regenerate+re-verify is warranted at all (declared here, once, so every pass shares the
        // same arrays instead of each needing its own install/regenerate/re-verify round-trip).
        const providedDepsToInstall: DependencyResolution[] = [];
        const addedDepsToInstall: DependencyResolution[] = [];
        const addedDepsAlreadyDecompiled: DependencyResolution[] = [];
        // Pass 0 (the static catalog) adds a dependency straight to job.dependencies with no jar
        // to install at all — real, already-downloadable Central coordinates, nothing to stage —
        // so it can't signal "something changed, regenerate the pom" via the three install arrays
        // above the way every other pass does. Confirmed live: without this flag, a job resolved
        // ENTIRELY via Pass 0 (e.g. a lone `javax.mail` reference) silently kept its stale,
        // dependency-less pom.xml forever — job.dependencies had the right entry, but nothing ever
        // told regenerateProject() to run.
        let anyCatalogApiResolved = false;
        if (newMissingPackages.length > 0) {
          const recordMissingPackage = (entry: MissingPackageEntry) => {
            job.missingPackages = job.missingPackages.filter(e => e.package !== entry.package);
            job.missingPackages.push(entry);
          };

          // Pass 0: known Java EE / Jakarta EE container-provided APIs (javax.mail,
          // javax.persistence, etc.) — no configuration needed at all, since these ship as real,
          // stable, standalone "-api" artifacts on Maven Central (PROVIDED_API_CATALOG in
          // dependencyResolutionService.ts). Handles the common case of code that runs inside a
          // container like GlassFish/WildFly/WebSphere, which supplies these at runtime, before
          // falling through to any directory search below. Unconditional — runs even when nothing
          // under Pipeline Tuning is configured, unlike every pass after it.
          const stillMissingAfterCatalog: string[] = [];
          for (const pkg of newMissingPackages) {
            const entry = findProvidedApiForPackage(pkg);
            if (!entry || job.dependencies.some(d => d.groupId === entry.groupId && d.artifactId === entry.artifactId)) {
              stillMissingAfterCatalog.push(pkg);
              continue;
            }
            attemptedMissingPackages.add(pkg);
            const newDep: DependencyResolution = {
              jarName: `${entry.artifactId}-${entry.version}.jar`, sha1: '',
              groupId: entry.groupId, artifactId: entry.artifactId, version: entry.version,
              classifier: null, scope: 'provided', confidence: 'provided-api', decompiledSourceDir: null,
              sharedLibrarySource: null,
            };
            job.dependencies.push(newDep);
            anyCatalogApiResolved = true;
            recordMissingPackage({ package: pkg, status: 'resolved', resolvedVia: `java-ee-provided-api:${entry.artifactId}`, candidateJars: [] });
            JobStore.appendLog(job, 'info', `Missing package ${pkg} -> recognized as a container-provided Java EE API — added ${entry.groupId}:${entry.artifactId}:${entry.version} as scope=provided (a real Central artifact, no application server needed on disk).`);
          }

          // Pass 1: a real Java EE container installation's own runtime libraries
          // (JAVAEE_PROVIDED_LIBS_DIR, e.g. $GLASSFISH_HOME/glassfish/{lib,modules}) — for
          // anything Pass 0's static catalog doesn't cover (a vendor extension, an older/newer
          // spec version). These jars ARE the container's actual implementation, not a
          // redistributable Central artifact, so they're install:install-file'd into the local
          // repo directly rather than resolved from Central, and — unlike a genuinely-unresolved
          // third-party WAR dependency — never decompiled: this is the application server's own
          // code, not the WAR's.
          let stillMissing = stillMissingAfterCatalog;
          if (Config.javaEeProvidedLibsDirs.length > 0 && stillMissing.length > 0) {
            if (!javaEeProvidedLibsIndex) {
              javaEeProvidedLibsIndex = buildJavaEeProvidedLibsIndex();
              JobStore.appendLog(job, 'info', `Indexed Java EE container-provided library folder(s) by package (${javaEeProvidedLibsIndex.size} package(s) found).`);
            }
            const stillMissingAfterContainerLibs: string[] = [];
            for (const pkg of stillMissing) {
              const lookup = resolveMissingPackage(pkg, javaEeProvidedLibsIndex);
              if (lookup.status === 'not_found') { stillMissingAfterContainerLibs.push(pkg); continue; }
              if (lookup.status === 'ambiguous') {
                attemptedMissingPackages.add(pkg);
                recordMissingPackage({ package: pkg, status: 'ambiguous', resolvedVia: null, candidateJars: lookup.candidateJars });
                continue;
              }
              attemptedMissingPackages.add(pkg);
              const matches = lookup.status === 'resolved-multi' ? lookup.matches : [lookup.match as SharedPackageMatch];
              for (const match of matches) {
                const jarBasename = path.basename(match.jarPath);
                if (job.dependencies.some(d => d.sharedLibrarySource === jarBasename)) continue;
                const newDep: DependencyResolution = {
                  jarName: jarBasename, sha1: sha1OfFile(match.jarPath),
                  groupId: match.groupId, artifactId: match.artifactId, version: match.version,
                  classifier: null, scope: 'provided', confidence: 'provided-api', decompiledSourceDir: null,
                  sharedLibrarySource: jarBasename,
                };
                job.dependencies.push(newDep);
                jarPathByName.set(newDep.jarName, match.jarPath);
                providedDepsToInstall.push(newDep);
                JobStore.appendLog(job, 'info', `Missing package ${pkg} -> found in Java EE container library ${newDep.jarName} — added as ${match.groupId}:${match.artifactId}:${match.version}, scope=provided (container-supplied, not decompiled).`);
              }
              recordMissingPackage({ package: pkg, status: 'resolved', resolvedVia: `java-ee-container-lib:${matches.map(m => path.basename(m.jarPath)).join(', ')}`, candidateJars: [] });
            }
            stillMissing = stillMissingAfterContainerLibs;
          }

          const anySearchConfigured = Config.sharedDependenciesDirs.length > 0
            || Config.missingPackagesSearchDirs.length > 0
            || Config.searchWorkspaceDecompiledLibs;
          if (stillMissing.length === 0) {
            // Everything left was resolved by Pass 0/1 above — nothing for the general
            // shared-dependencies/workspace search below to do this attempt.
          } else if (!anySearchConfigured) {
            for (const pkg of stillMissing) {
              attemptedMissingPackages.add(pkg);
              recordMissingPackage({ package: pkg, status: 'not_configured', resolvedVia: null, candidateJars: [] });
            }
          } else {
          if (!sharedPackageIndex) {
            sharedPackageIndex = buildSharedLibraryPackageIndex();
            JobStore.appendLog(job, 'info', `Indexed shared-dependencies/missing-package-search folders by package (${sharedPackageIndex.size} package(s) found) to search for classes missing from this WAR entirely.`);
          }
          if (!workspaceLibsIndex) {
            // Manual-source-library folders (MISSING_PACKAGES_SEARCH_DIR subdirectories, each
            // treated as one already-decompiled module) are always consulted when configured —
            // that's a deliberate, explicit choice, unlike scanning every OTHER job's own live
            // workspace, which stays behind its own opt-in toggle since it's real, avoidable work
            // for anyone not running related WARs through this app.
            const manualIndex = buildManualSourceLibraryIndex();
            const jobsIndex = Config.searchWorkspaceDecompiledLibs ? buildWorkspaceDecompiledLibsIndex(job.id) : new Map();
            workspaceLibsIndex = mergeSourceLibraryIndexes(manualIndex, jobsIndex);
            if (workspaceLibsIndex.size) {
              JobStore.appendLog(job, 'info', `Indexed already-decompiled source libraries by package (${manualIndex.size} package(s) from shared-source-library folder(s), ${jobsIndex.size} from other jobs' workspaces) to search for classes missing from this WAR entirely.`);
            }
          }
          // Adds one shared-dependencies jar as a new dependency (install + decompile), skipping
          // it if this job already has an entry for that exact jar — shared between the
          // single-candidate and complementary-multi-candidate branches below so a package
          // resolved either way gets identical treatment.
          const addJarDep = (pkg: string, match: SharedPackageMatch): void => {
            const jarBasename = path.basename(match.jarPath);
            if (job.dependencies.some(d => d.sharedLibrarySource === jarBasename)) return;
            const newDep: DependencyResolution = {
              jarName: jarBasename, sha1: sha1OfFile(match.jarPath),
              groupId: match.groupId, artifactId: match.artifactId, version: match.version,
              classifier: null, scope: 'compile', confidence: 'unresolved', decompiledSourceDir: null,
              sharedLibrarySource: jarBasename,
            };
            job.dependencies.push(newDep);
            jarPathByName.set(newDep.jarName, match.jarPath);
            addedDepsToInstall.push(newDep);
            JobStore.appendLog(job, 'info', `Missing package ${pkg} -> found in shared-dependencies jar ${newDep.jarName} (${match.matchedClassCount} class(es) in that package) — added as ${match.groupId}:${match.artifactId}:${match.version}.`);
          };

          for (const pkg of stillMissing) {
            attemptedMissingPackages.add(pkg);
            const lookup = resolveMissingPackage(pkg, sharedPackageIndex, workspaceLibsIndex ?? undefined);
            if (lookup.status === 'not_found') {
              recordMissingPackage({ package: pkg, status: 'not_found', resolvedVia: null, candidateJars: [] });
              continue;
            }
            if (lookup.status === 'ambiguous') {
              recordMissingPackage({ package: pkg, status: 'ambiguous', resolvedVia: null, candidateJars: lookup.candidateJars });
              continue;
            }

            if (lookup.status === 'resolved-multi') {
              // Complementary split jars with no overlapping classes (confirmed real case: IBM
              // MQ's SDK spread across com.ibm.mq.jar + com.ibm.mq.jmqi.jar) — safe to add every
              // one, since Maven can never be confused about which jar answers for a class that
              // only exists in one of them.
              const names = lookup.matches.map(m => path.basename(m.jarPath)).join(', ');
              recordMissingPackage({ package: pkg, status: 'resolved', resolvedVia: names, candidateJars: [] });
              for (const match of lookup.matches) addJarDep(pkg, match);
              continue;
            }

            // The same shared jar can supply more than one of this attempt's missing packages
            // (confirmed real case: a single IcGrid module jar covers several
            // com.wovenware.icgrid.* sub-packages at once) — never add it twice.
            if (lookup.source === 'jar') {
              const match = lookup.match;
              const jarBasename = path.basename(match.jarPath);
              recordMissingPackage({ package: pkg, status: 'resolved', resolvedVia: jarBasename, candidateJars: [] });
              addJarDep(pkg, match);
            } else {
              // Reusing another job's already-decompiled (and AI-cleaned) dependency source —
              // no jar exists at all, so there's nothing to install:install-file; copy the donor
              // module's source straight into this job's own decompiled-libs/ and wire it in
              // exactly like any other decompiled-and-inlined dependency (see
              // projectGeneratorService.ts's decompiledLibs bucket, which only checks confidence
              // === 'unresolved' && decompiledSourceDir set — indifferent to how that source got
              // there).
              const match = lookup.match;
              const resolvedViaLabel = `workspace:${match.jobId}/${match.artifactId}`;
              recordMissingPackage({ package: pkg, status: 'resolved', resolvedVia: resolvedViaLabel, candidateJars: [] });
              if (job.dependencies.some(d => d.groupId === 'local.workspace' && d.artifactId === match.artifactId)) continue;
              const relDir = path.join('decompiled-libs', match.artifactId);
              const destDir = path.join(workspace, relDir);
              try {
                fs.mkdirSync(destDir, { recursive: true });
                copyDirRecursive(match.sourceDir, destDir);
              } catch (err: any) {
                JobStore.appendLog(job, 'warn', `Missing package ${pkg}: found in job ${match.jobId}'s ${match.artifactId} but failed to copy its decompiled source: ${err.message}`);
                continue;
              }
              const newDep: DependencyResolution = {
                jarName: `${match.artifactId}.jar`, sha1: '',
                groupId: 'local.workspace', artifactId: match.artifactId, version: '0.0.0-workspace',
                classifier: null, scope: 'compile', confidence: 'unresolved', decompiledSourceDir: relDir,
                sharedLibrarySource: resolvedViaLabel,
              };
              job.dependencies.push(newDep);
              addedDepsAlreadyDecompiled.push(newDep);
              JobStore.appendLog(job, 'info', `Missing package ${pkg} -> found already decompiled in job ${match.jobId}'s ${match.artifactId} (${match.matchedFileCount} file(s) in that package) — copied into this job's decompiled-libs/.`);
            }
          }
          }
        }
        if (providedDepsToInstall.length) {
          // Container-provided jars (Pass 1 above) are installed so Maven can resolve them, but
          // deliberately never decompiled — this is the application server's own implementation
          // code, not the WAR's, unlike a genuinely-unresolved third-party dependency.
          JobStore.appendLog(job, 'info', `Installing ${providedDepsToInstall.length} Java EE container-provided jar(s) into local Maven repo (scope=provided, not decompiled)...`);
          await installUnresolvedDependencies(projectDir, providedDepsToInstall, jarPathByName, line => JobStore.logOperation(job, line), javaHome);
          JobStore.setCurrentOperation(job, null);
        }
        if (addedDepsToInstall.length) {
          JobStore.appendLog(job, 'info', `Installing ${addedDepsToInstall.length} newly-found shared-dependencies jar(s) into local Maven repo...`);
          await installUnresolvedDependencies(projectDir, addedDepsToInstall, jarPathByName, line => JobStore.logOperation(job, line), javaHome);
          await decompileUnresolvedDependencies(addedDepsToInstall, jarPathByName, workspace, engineStatuses,
            msg => JobStore.logOperation(job, msg));
          JobStore.setCurrentOperation(job, null);
        }
        if (anyCatalogApiResolved || providedDepsToInstall.length || addedDepsToInstall.length || addedDepsAlreadyDecompiled.length) {
          regenerateProject();
          JobStore.save(job);

          // Same reasoning as the toDemote/toExclude re-verify above — this is a new
          // dependency-resolution-level fix, so the true error set needs re-checking now rather
          // than letting remediation below run against stale pre-fix data.
          finalBuild = await verifyBuild(projectDir, line => JobStore.logOperation(job, line), javaHome);
          JobStore.setCurrentOperation(job, null);
          attemptNum = job.buildAttempts.length + 1;
          job.buildAttempts.push({
            attempt: attemptNum, success: finalBuild.success, errorCount: finalBuild.errorCount,
            errorsByFile: finalBuild.errorsByFile, timestamp: new Date().toISOString(),
          });
          JobStore.save(job);
          if (finalBuild.success) continue;
          errorCountAtAttemptStart = finalBuild.errorCount;
          errorSignatureAtAttemptStart = buildResultSignature(finalBuild);
          // Same reasoning as the toDemote/toExclude continue above — this fix can unmask a
          // different broken artifact further down the dependency graph that deterministic/AI
          // remediation below can never touch; send it back to the top of the loop immediately
          // instead of letting it get stranded by the "no progress" bail-out.
          if (finalBuild.brokenArtifacts.length > 0) continue;
        }

        // Last-resort, opt-in pruning of decompiled dependency source that references a package
        // confirmed unresolvable everywhere (see deadCodePruningService.ts) — e.g. log4j's own
        // bundled, never-instantiated JMSAppender/JMX Agent classes needing com.sun.jdmk.comm, an
        // API with no Maven artifact under any coordinate to ever find. Runs after missing-package
        // resolution above has had its chance (a package only prunes once genuinely 'not_found',
        // never while still 'ambiguous' — that one has a real answer, just needs a human), against
        // whichever finalBuild is current (that block may have already re-verified once this
        // attempt).
        if (Config.pruneUnfixableDecompiledClasses) {
          const notFoundPackages = new Set(job.missingPackages.filter(p => p.status === 'not_found').map(p => p.package));
          if (notFoundPackages.size > 0) {
            const pruned = pruneUnfixableFiles(projectDir, workspace, notFoundPackages, finalBuild.errorsByFile);
            if (pruned.length) {
              const now = new Date().toISOString();
              job.excludedUnfixableFiles.push(...pruned.map(p => ({ relativePath: p.relativePath, reason: p.reason, timestamp: now })));
              JobStore.appendLog(job, 'warn', `Pruned ${pruned.length} decompiled class(es) with no obtainable dependency (moved to workspace excluded-unfixable-classes/, not deleted): ${pruned.map(p => p.relativePath).join(', ')}`);
              JobStore.save(job);

              finalBuild = await verifyBuild(projectDir, line => JobStore.logOperation(job, line), javaHome);
              JobStore.setCurrentOperation(job, null);
              attemptNum = job.buildAttempts.length + 1;
              job.buildAttempts.push({
                attempt: attemptNum, success: finalBuild.success, errorCount: finalBuild.errorCount,
                errorsByFile: finalBuild.errorsByFile, timestamp: new Date().toISOString(),
              });
              JobStore.save(job);
              if (finalBuild.success) continue;
              errorCountAtAttemptStart = finalBuild.errorCount;
              errorSignatureAtAttemptStart = buildResultSignature(finalBuild);
              // Same reasoning as the toDemote/toExclude continue above.
              if (finalBuild.brokenArtifacts.length > 0) continue;
            }
          }
        }

        // ─── Deterministic (no-AI) remediation pass ──────────────────
        // Runs BEFORE the AI pass — fixes what it can mechanically (missing imports for
        // known types, unreachable statements), then re-verifies. If the deterministic pass
        // fixed everything, the AI pass is skipped entirely (cheaper, faster). If AI is not
        // configured at all, this is the only remediation that runs.
        const appClassFqcns = job.classes.map(c => c.fqcn);
        const detOutcome = await remediateDeterministically(finalBuild, job.dependencies, appClassFqcns, projectDir);
        if (detOutcome.fixed.length || detOutcome.partiallyFixed.length) {
          JobStore.appendLog(job, 'info', `Deterministic remediation: ${detOutcome.fixed.length} fixed, ${detOutcome.partiallyFixed.length} partially fixed, ${detOutcome.unfixed.length} unfixed.`);

          // Re-verify after deterministic fixes — if everything is fixed, skip the AI pass
          finalBuild = await verifyBuild(projectDir, line => JobStore.logOperation(job, line), javaHome);
          JobStore.setCurrentOperation(job, null);
          attemptNum = job.buildAttempts.length + 1;
          job.buildAttempts.push({
            attempt: attemptNum, success: finalBuild.success, errorCount: finalBuild.errorCount,
            errorsByFile: finalBuild.errorsByFile, timestamp: new Date().toISOString(),
          });
          JobStore.save(job);
          if (finalBuild.success) continue; // skip AI pass — deterministic fixes were enough
        }

        // ─── AI remediation pass (only if deterministic didn't fix everything) ──
        const outcome = await remediate(finalBuild, aiTouchedFiles, symbolTable ?? undefined, projectDir);
        JobStore.appendLog(job, 'info', `AI remediation: ${outcome.fixed.length} fixed, ${outcome.likelyDependencyIssue.length} flagged as dependency issues, ${outcome.unfixed.length} unfixed.`);

        finalBuild = await verifyBuild(projectDir, line => JobStore.logOperation(job, line), javaHome);
        JobStore.setCurrentOperation(job, null);
        attemptNum = job.buildAttempts.length + 1;
        job.buildAttempts.push({
          attempt: attemptNum, success: finalBuild.success, errorCount: finalBuild.errorCount,
          errorsByFile: finalBuild.errorsByFile, timestamp: new Date().toISOString(),
        });
        JobStore.save(job);

        if (!finalBuild.success && finalBuild.errorCount >= errorCountAtAttemptStart
            && buildResultSignature(finalBuild) === errorSignatureAtAttemptStart) {
          JobStore.appendLog(job, 'warn', `No net progress this attempt (${errorCountAtAttemptStart} -> ${finalBuild.errorCount} errors, same underlying broken artifacts/files) — remaining failures need manual attention or a new fix, not more retries. Stopping early instead of using the rest of the ${Config.maxBuildFixAttempts} attempt budget.`);
          break;
        }
      }

      JobStore.setCurrentOperation(job, null);
      if (finalBuild.success) {
        JobStore.setStatus(job, 'completed');
        JobStore.appendLog(job, 'info', 'Build succeeded — project is ready.');
      } else {
        JobStore.setStatus(job, 'completed_with_errors');
        JobStore.appendLog(job, 'warn', `Build still has ${finalBuild.errorCount} error(s) after ${job.buildAttempts.length} attempt(s) — see BJAVADECOMPILER-NOTES.md and the generated project for what needs manual attention.`);
      }
    } catch (err: any) {
      const current = JobStore.get(jobId);
      if (!current) return;
      JobStore.setCurrentOperation(current, null);
      if (err instanceof ControlSignalHalt) {
        current.controlSignal = 'none';
        JobStore.setStatus(current, err.signal === 'pause' ? 'paused' : 'cancelled');
        JobStore.appendLog(current, 'info', `Job ${err.signal}d.`);
        return;
      }
      current.errorMessage = err.message;
      JobStore.setStatus(current, 'failed');
      JobStore.appendLog(current, 'error', `Pipeline failed: ${err.message}`);
      logger.error(`Job ${jobId} failed: ${err.message}`, { stack: err.stack });
    }
  }
}

// ─── Small on-disk caches so resuming a paused job doesn't redo cheap-but-not-free work ──

function readCachedExtraction(job: DecompileJob, workspace: string): ReturnType<typeof extract> | null {
  const marker = path.join(workspace, '.extraction_done.json');
  if (!fs.existsSync(marker)) return null;
  try { return JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { return null; }
}
function writeCachedExtraction(workspace: string, extraction: ReturnType<typeof extract>): void {
  fs.writeFileSync(path.join(workspace, '.extraction_done.json'), JSON.stringify(extraction), 'utf8');
}

function readCachedDecompileResults(workspace: string): DecompileRunResult[] {
  const marker = path.join(workspace, '.decompile_done.json');
  if (!fs.existsSync(marker)) return [];
  try { return JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { return []; }
}
function writeCachedDecompileResults(workspace: string, results: DecompileRunResult[]): void {
  fs.writeFileSync(path.join(workspace, '.decompile_done.json'), JSON.stringify(results), 'utf8');
}

function readCachedSymbolTable(workspace: string): ProjectSymbolTable | null {
  const marker = path.join(workspace, '.symbol_table.json');
  if (!fs.existsSync(marker)) return null;
  try { return JSON.parse(fs.readFileSync(marker, 'utf8')); } catch { return null; }
}
function writeCachedSymbolTable(workspace: string, table: ProjectSymbolTable): void {
  fs.writeFileSync(path.join(workspace, '.symbol_table.json'), JSON.stringify(table), 'utf8');
}

function detectSampleJavaVersion(classesDir: string): number | null {
  if (!fs.existsSync(classesDir)) return null;
  const stack = [classesDir];
  while (stack.length) {
    const dir = stack.pop()!;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { stack.push(full); continue; }
      if (entry.name.endsWith('.class')) {
        const v = detectJavaVersionFromClassFile(full);
        if (v) return v;
      }
    }
  }
  return null;
}

function readManifestVendorId(extractedDir: string): string | null {
  const manifestPath = path.join(extractedDir, 'META-INF', 'MANIFEST.MF');
  if (!fs.existsSync(manifestPath)) return null;
  const text = fs.readFileSync(manifestPath, 'utf8');
  const m = text.match(/Implementation-Vendor-Id:\s*(.+)/i);
  return m ? m[1].trim() : null;
}
