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
 * BJavaDecompiler - searches for a jar (or, failing that, another job's already-decompiled
 * output) that supplies a Java package `mvn compile` reports as entirely missing
 * (`package X does not exist`) — the companion to dependencyResolutionService.ts's
 * matchSharedLibrary(), for classes that were never bundled in the WAR's own WEB-INF/lib at all.
 * That earlier feature can only match a jar that's ALREADY one of the WAR's own dependencies (by
 * SHA-1 or filename); it has no way to find a jar the WAR never bundled in the first place.
 * Confirmed real case: FhcIntfSolProj.war references com.wovenware.icgrid.* classes that live in
 * an entirely separate product module never bundled in this particular WAR — the missing package
 * name (read straight out of javac's own error) is the only signal available, so the only way to
 * find it is to index every candidate source's own class/package table and look the name up
 * directly.
 *
 * Three candidate sources, tried in order (jar folders first — a real jar can be freshly
 * decompiled and may carry real pom.properties coordinates; already-decompiled source is cheaper
 * to reuse but just inherits whatever produced it):
 *   1. Config.sharedDependenciesDirs + Config.missingPackagesSearchDirs jar files (by class table).
 *   2. Config.missingPackagesSearchDirs' own SUBDIRECTORIES, each treated as one decompiled
 *      module root (by .java file path, same convention as (3)) — a manually-curated "permanent
 *      library" of already-decompiled source, always consulted when configured regardless of the
 *      workspace-scan toggle below, since the user explicitly pointed at this folder for exactly
 *      this purpose. Confirmed real case: MISSING_PACKAGES_SEARCH_DIR pointed at a hand-copied
 *      collection of prior decompiled-libs/<artifactId>/ output.
 *   3. When Config.searchWorkspaceDecompiledLibs is on: every OTHER job's own
 *      data/workspaces/<jobId>/decompiled-libs/<artifactId>/ tree (already-decompiled .java
 *      source, by directory structure).
 * (2) and (3) are only consulted when (1) found nothing at all for a given package, never to
 * break a tie or override an ambiguous jar result; (2) and (3) are merged into one combined
 * source-index before that fallback lookup, so a package split across a manual library folder and
 * a live job workspace is still just as ambiguous (or not) as it should be.
 */

import fs from 'fs';
import path from 'path';
import { Config } from '../config/config';
import { Logger } from '../core/logger';
import { listAllSharedDependencyJars, identifySharedJar } from './dependencyResolutionService';
import { listJarClasses } from './mavenSearchService';

const logger = Logger.getLogger('SharedLibraryPackageSearch');

export interface SharedPackageMatch {
  jarPath: string;
  groupId: string;
  artifactId: string;
  version: string;
  matchedClassCount: number;
}

/** A match found in another job's already-decompiled dependency source rather than a jar — no
 * jar to install-file, the source is simply copied into the current job's own workspace and
 * wired in as an extra source root, same as any other decompiled-and-inlined dependency. */
export interface WorkspaceSourceMatch {
  jobId: string;
  artifactId: string;
  /** Absolute path to the donor job's decompiled-libs/<artifactId> directory. */
  sourceDir: string;
  matchedFileCount: number;
}

/** High enough that no real jar's class table gets truncated (listJarClasses's own default cap
 * of 40 exists for a "candidates to show a human" UI list, not for this exhaustive index). */
const ALL_CLASSES = 1_000_000;

/**
 * package -> jar path(s) that contain at least one class DIRECTLY in that exact package —
 * matches javac's own semantics for `import a.b.c.*` / `import a.b.c.Foo` (both require a class
 * directly in a.b.c; a class merely in some sub-package of it doesn't count, so this deliberately
 * does NOT do prefix matching). Scans Config.sharedDependenciesDirs AND
 * Config.missingPackagesSearchDirs together (deduplicated) — the latter is purely additive, for a
 * folder you only want consulted for this search, not the already-bundled-jar identity matcher.
 * Built once per job run and reused across every missing-package lookup in that run — re-listing
 * every jar's full class table per package would be needlessly expensive once a WAR has more than
 * a couple of gaps.
 */
export function buildSharedLibraryPackageIndex(): Map<string, string[]> {
  const jarPaths = new Set([...listAllSharedDependencyJars(), ...listAllMissingPackageSearchJars()]);
  return indexJarsByPackage(jarPaths);
}

/** package -> jar path(s) that contain at least one class DIRECTLY in that exact package, scanning
 * ONLY Config.javaEeProvidedLibsDirs (a real Java EE container installation's own runtime libs,
 * e.g. GlassFish's glassfish/lib + glassfish/modules) — kept as its own index rather than merged
 * into buildSharedLibraryPackageIndex() above so a match here can be treated differently (scope
 * 'provided', installed but never decompiled — see decompileJobService.ts) from a match against
 * the user's own shared/proprietary jars. */
export function buildJavaEeProvidedLibsIndex(): Map<string, string[]> {
  const jarPaths = new Set(listAllJavaEeProvidedLibsJars());
  return indexJarsByPackage(jarPaths);
}

/** Shared class-table-scanning core for both jar-based indexes above — same javac semantics as
 * described on buildSharedLibraryPackageIndex (no sub-package prefix matching). */
function indexJarsByPackage(jarPaths: Iterable<string>): Map<string, string[]> {
  const index = new Map<string, string[]>();
  for (const jarPath of jarPaths) {
    let classes: string[];
    try {
      classes = listJarClasses(jarPath, ALL_CLASSES);
    } catch (err: any) {
      logger.warn(`Could not list classes in jar ${jarPath}: ${err.message}`);
      continue;
    }
    const packages = new Set<string>();
    for (const fqcn of classes) {
      const lastDot = fqcn.lastIndexOf('.');
      if (lastDot === -1) continue; // default-package class — never what a real import needs
      packages.add(fqcn.slice(0, lastDot));
    }
    for (const pkg of packages) {
      if (!index.has(pkg)) index.set(pkg, []);
      index.get(pkg)!.push(jarPath);
    }
  }
  return index;
}

/** Every `.jar` under every configured Config.javaEeProvidedLibsDirs entry — mirrors
 * listAllMissingPackageSearchJars()'s missing/invalid-directory handling (logged and skipped,
 * never thrown). */
function listAllJavaEeProvidedLibsJars(): string[] {
  const found: string[] = [];
  for (const dir of Config.javaEeProvidedLibsDirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      logger.warn(`Configured Java EE container library directory does not exist, skipping: ${dir}`);
      continue;
    }
    found.push(...walkJarFilesRecursive(dir));
  }
  return found;
}

/** Every `.jar` under every configured Config.missingPackagesSearchDirs entry — mirrors
 * dependencyResolutionService.ts's listAllSharedDependencyJars() (same missing/invalid-directory
 * handling: logged and skipped, never thrown), kept separate only because it reads a different
 * config list. */
function listAllMissingPackageSearchJars(): string[] {
  const found: string[] = [];
  for (const dir of Config.missingPackagesSearchDirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      logger.warn(`Configured missing-packages-search directory does not exist, skipping: ${dir}`);
      continue;
    }
    found.push(...walkJarFilesRecursive(dir));
  }
  return found;
}

function walkJarFilesRecursive(dir: string): string[] {
  const found: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err: any) {
    logger.warn(`Could not read directory ${dir}: ${err.message}`);
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkJarFilesRecursive(full));
    else if (entry.isFile() && /\.jar$/i.test(entry.name)) found.push(full);
  }
  return found;
}

/** package -> the set of exact package names a decompiled module root (an <artifactId> directory
 * whose contents are .java files laid out in normal package-matching directory structure) covers
 * — derived from each file's path relative to that root, the same convention build-helper-maven-
 * plugin's add-source relies on elsewhere in this app, so it's already guaranteed to hold for
 * anything this app itself produced (or a human copied in the same shape). Shared by both
 * buildWorkspaceDecompiledLibsIndex (one call per job's decompiled-libs/<artifactId>) and
 * buildManualSourceLibraryIndex (one call per MISSING_PACKAGES_SEARCH_DIR subdirectory) so the two
 * never drift into independently-buggy copies of the same directory walk. */
function packagesUnderModuleRoot(moduleDir: string): Set<string> {
  const packages = new Set<string>();
  (function walk(dir: string, relSegments: string[]) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        walk(path.join(dir, entry.name), [...relSegments, entry.name]);
      } else if (entry.name.endsWith('.java') && relSegments.length > 0) {
        packages.add(relSegments.join('.'));
      }
    }
  })(moduleDir, []);
  return packages;
}

/** Synthetic "jobId" for a WorkspaceSourceMatch that actually came from a manually-curated
 * MISSING_PACKAGES_SEARCH_DIR folder rather than a real job's workspace — human-readable enough
 * to show correctly in logs/UI ("found already decompiled in job shared-source-library's X")
 * without needing a whole separate match type just to drop one field. */
export const MANUAL_SOURCE_LIBRARY_LABEL = 'shared-source-library';

/**
 * package -> {jobId, artifactId, dir}[] for every OTHER job's decompiled-libs output — walks
 * data/workspaces/<jobId>/decompiled-libs/<artifactId>/**\/*.java. `excludeJobId` skips the
 * current job's own workspace — a package genuinely missing from THIS job can never already be
 * sitting in this same job's own decompiled-libs, so scanning it would only waste time.
 */
export function buildWorkspaceDecompiledLibsIndex(excludeJobId: string): Map<string, { jobId: string; artifactId: string; dir: string }[]> {
  const index = new Map<string, { jobId: string; artifactId: string; dir: string }[]>();
  const workspacesRoot = Config.workspacesPath;
  let jobDirs: string[];
  try {
    jobDirs = fs.readdirSync(workspacesRoot, { withFileTypes: true })
      .filter(e => e.isDirectory() && e.name !== excludeJobId)
      .map(e => e.name);
  } catch (err: any) {
    logger.warn(`Could not read workspaces directory ${workspacesRoot}: ${err.message}`);
    return index;
  }

  for (const jobId of jobDirs) {
    const libsRoot = path.join(workspacesRoot, jobId, 'decompiled-libs');
    let artifactDirs: string[];
    try {
      artifactDirs = fs.readdirSync(libsRoot, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
    } catch {
      continue; // no decompiled-libs for this job (never hit an unresolved dependency) — normal, not an error
    }

    for (const artifactId of artifactDirs) {
      const artifactDir = path.join(libsRoot, artifactId);
      for (const pkg of packagesUnderModuleRoot(artifactDir)) {
        if (!index.has(pkg)) index.set(pkg, []);
        index.get(pkg)!.push({ jobId, artifactId, dir: artifactDir });
      }
    }
  }
  return index;
}

/**
 * package -> {jobId, artifactId, dir}[] for every subdirectory of every configured
 * Config.missingPackagesSearchDirs entry — each subdirectory is treated as one already-decompiled
 * module root, exactly like a job's own decompiled-libs/<artifactId>/, so a hand-curated "permanent
 * library" folder (e.g. copied out of prior jobs' decompiled-libs/ output) works the same way
 * without needing a live job workspace to reuse. Always built when any
 * missingPackagesSearchDirs entry is configured, independent of Config.searchWorkspaceDecompiledLibs
 * (that toggle only gates automatically scanning OTHER JOBS' own workspaces — an explicitly
 * pointed-at folder is a deliberate choice, not the same cost/tradeoff).
 */
export function buildManualSourceLibraryIndex(): Map<string, { jobId: string; artifactId: string; dir: string }[]> {
  const index = new Map<string, { jobId: string; artifactId: string; dir: string }[]>();
  for (const rootDir of Config.missingPackagesSearchDirs) {
    let subdirs: string[];
    try {
      subdirs = fs.readdirSync(rootDir, { withFileTypes: true }).filter(e => e.isDirectory()).map(e => e.name);
    } catch (err: any) {
      logger.warn(`Could not read missing-packages-search directory ${rootDir}: ${err.message}`);
      continue;
    }
    for (const artifactId of subdirs) {
      const moduleDir = path.join(rootDir, artifactId);
      for (const pkg of packagesUnderModuleRoot(moduleDir)) {
        if (!index.has(pkg)) index.set(pkg, []);
        index.get(pkg)!.push({ jobId: MANUAL_SOURCE_LIBRARY_LABEL, artifactId, dir: moduleDir });
      }
    }
  }
  return index;
}

/** Merges a workspace-style index (job-scan) with a manual-source-library index into one combined
 * lookup table, for a single call to resolveMissingPackage() to treat both as one source tier. */
export function mergeSourceLibraryIndexes(
  a: Map<string, { jobId: string; artifactId: string; dir: string }[]>,
  b: Map<string, { jobId: string; artifactId: string; dir: string }[]>,
): Map<string, { jobId: string; artifactId: string; dir: string }[]> {
  const merged = new Map<string, { jobId: string; artifactId: string; dir: string }[]>();
  for (const src of [a, b]) {
    for (const [pkg, entries] of src) {
      if (!merged.has(pkg)) merged.set(pkg, []);
      merged.get(pkg)!.push(...entries);
    }
  }
  return merged;
}

export type MissingPackageLookup =
  | { status: 'resolved'; source: 'jar'; match: SharedPackageMatch }
  | { status: 'resolved-multi'; source: 'jar'; matches: SharedPackageMatch[] }
  | { status: 'resolved'; source: 'workspace'; match: WorkspaceSourceMatch }
  | { status: 'ambiguous'; candidateJars: string[] }
  | { status: 'not_found' };

/** Classes a jar contributes DIRECTLY to one package (same javac semantics as the index build —
 * no sub-package prefix matching). Exported so decompileJobService.ts's dead-code-pruning pass
 * can reuse the identical definition rather than a second, independently-drifting copy. */
export function classesInPackage(jarPath: string, pkg: string): string[] {
  return listJarClasses(jarPath, ALL_CLASSES)
    .filter(fqcn => fqcn.startsWith(`${pkg}.`) && !fqcn.slice(pkg.length + 1).includes('.'));
}

/**
 * Looks up one missing package, jar index first, workspace index only as a fallback when the jar
 * index found nothing at all for that package (never to break a jar-index tie — a genuinely
 * ambiguous jar result stays ambiguous rather than being second-guessed by a workspace reuse).
 *
 * More than one jar candidate for the same package is common for a real SDK that's split across
 * several companion jars (confirmed real case: IBM MQ's own `com.ibm.mq.jar` +
 * `com.ibm.mq.jmqi.jar` both declare *something* under `com.ibm.mq`, even though only one of them
 * happened to hold the specific classes a given WAR needed) — rather than treating every multi-jar
 * hit as unresolvable, this checks whether the candidates' own class sets for that exact package
 * actually OVERLAP (same class name defined in more than one jar — a genuine "which one is real"
 * conflict, e.g. two different versions of the same library) versus being cleanly complementary
 * (no shared class names — safe to install every one of them, since Maven can't get confused about
 * which jar answers for a class that only exists in one of them). Only a real overlap is reported
 * as 'ambiguous' and left for manual resolution; a clean split resolves as 'resolved-multi'.
 */
export function resolveMissingPackage(
  pkg: string,
  jarIndex: Map<string, string[]>,
  workspaceIndex?: Map<string, { jobId: string; artifactId: string; dir: string }[]>,
): MissingPackageLookup {
  const jarCandidates = Array.from(new Set(jarIndex.get(pkg) || []));
  if (jarCandidates.length > 1) {
    const classesByJar = new Map<string, string[]>();
    for (const jarPath of jarCandidates) classesByJar.set(jarPath, classesInPackage(jarPath, pkg));
    const seen = new Set<string>();
    let conflict = false;
    for (const classes of classesByJar.values()) {
      for (const fqcn of classes) {
        if (seen.has(fqcn)) { conflict = true; break; }
        seen.add(fqcn);
      }
      if (conflict) break;
    }
    if (!conflict) {
      logger.info(`Missing package ${pkg} is supplied by ${jarCandidates.length} complementary shared-dependencies jars with no overlapping classes (${jarCandidates.map(j => path.basename(j)).join(', ')}) — adding all of them.`);
      const matches = jarCandidates.map(jarPath => ({ jarPath, ...identifySharedJar(jarPath), matchedClassCount: classesByJar.get(jarPath)!.length }));
      return { status: 'resolved-multi', source: 'jar', matches };
    }
    logger.warn(`Missing package ${pkg} is supplied by ${jarCandidates.length} different shared-dependencies jars that define at least one of the SAME class (${jarCandidates.map(j => path.basename(j)).join(', ')}) — a genuine version/identity conflict, too ambiguous to auto-pick.`);
    return { status: 'ambiguous', candidateJars: jarCandidates.map(j => path.basename(j)) };
  }
  if (jarCandidates.length === 1) {
    const jarPath = jarCandidates[0];
    const matchedClassCount = classesInPackage(jarPath, pkg).length;
    return { status: 'resolved', source: 'jar', match: { jarPath, ...identifySharedJar(jarPath), matchedClassCount } };
  }

  if (workspaceIndex) {
    const wsCandidates = workspaceIndex.get(pkg) || [];
    // Dedupe by artifactId+dir — the same donor module can't meaningfully appear twice, but guard
    // against it anyway rather than assume the index-building step never could produce that.
    const uniqueDirs = Array.from(new Map(wsCandidates.map(c => [c.dir, c])).values());
    if (uniqueDirs.length === 1) {
      const { jobId, artifactId, dir } = uniqueDirs[0];
      let matchedFileCount = 0;
      try {
        matchedFileCount = fs.readdirSync(path.join(dir, ...pkg.split('.'))).filter(f => f.endsWith('.java')).length;
      } catch { /* best-effort count only, never fatal */ }
      logger.info(`Missing package ${pkg} — no shared-dependencies jar supplies it, but found already-decompiled in job ${jobId}'s ${artifactId}.`);
      return { status: 'resolved', source: 'workspace', match: { jobId, artifactId, sourceDir: dir, matchedFileCount } };
    }
    if (uniqueDirs.length > 1) {
      const names = uniqueDirs.map(c => `${c.jobId}/${c.artifactId}`);
      logger.warn(`Missing package ${pkg} is supplied by ${uniqueDirs.length} different jobs' decompiled libraries (${names.join(', ')}) — too ambiguous to auto-pick, leaving unresolved.`);
      return { status: 'ambiguous', candidateJars: names };
    }
  }

  logger.warn(`Missing package ${pkg} — no shared-dependencies jar${workspaceIndex ? ' or previously-decompiled workspace library' : ''} supplies it.`);
  return { status: 'not_found' };
}
