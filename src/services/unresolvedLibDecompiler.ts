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
 * BJavaDecompiler - decompiles dependency jars that couldn't be resolved to a real Maven
 * coordinate (see dependencyResolutionService.ts). Most WARs that hit this are internal/
 * proprietary libraries never published anywhere public — for those there is no "real"
 * coordinate to ever find, so leaving them as an opaque `com.bjavadecompiler.unresolved`
 * placeholder + a binary install-file is a dead end for review. Real, readable source that
 * compiles straight into the project (see projectGeneratorService.ts) is a far better outcome.
 *
 * Runs every installed engine (CFR/Vineflower/jd-cli/JADX) against each unresolved jar and
 * picks the best output per class via candidateScoringService.ts's scoring — the same
 * "run everything, score, pick a winner" approach Stage 3/4 already uses for the app's own
 * classes. Confirmed live this matters, not just for consistency: CFR 0.152 reliably mangles a
 * specific try/catch-reconstruction shape into 'catch' without 'try'/illegal-start-of-expression
 * syntax errors with no failure-marker comment at all (so CFR itself never flags it), while
 * jd-cli's JD-Core engine (the same decompiler JD-GUI uses) produces genuinely compilable output
 * on that exact shape.
 *
 * The winning file per class still gets the same AI cleanup pass as the app's own classes when
 * ITS OWN winning engine left a failure marker — reuses aiReconstructionService.ts's generic
 * batch-reconstruction core (not the ClassCandidate-tracking wrapper, since these files aren't
 * tracked as job.classes at all).
 */

import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { Config } from '../config/config';
import { Logger } from '../core/logger';
import { DecompilerEngine, DependencyResolution } from '../models/job';
import { EngineStatus } from '../core/externalTools';
import { runEngineAgainstJar, zipDirectoryToJar, DecompileRunResult } from './decompilerRunner';
import { scoreAllCandidates, findFailureMarkers } from './candidateScoringService';
import { cleanKnownDecompilerArtifacts } from './decompilerArtifactCleanup';
import { checkJavaSyntax } from '../core/javaSyntaxCheck';
import { runAiBatchReconstruction, ReconstructionItem } from './aiReconstructionService';

const logger = Logger.getLogger('UnresolvedLibDecompiler');

const NESTED_ARCHIVE_NAME_RE = /\.(jar|war|zip|ear)$/i;

/** Local-file-header / end-of-central-directory magic numbers — enough to identify "this entry's
 * bytes are themselves a zip/jar" regardless of what it's named. */
function looksLikeZipContent(data: Buffer): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b &&
    ((data[2] === 0x03 && data[3] === 0x04) || (data[2] === 0x05 && data[3] === 0x06) || (data[2] === 0x07 && data[3] === 0x08));
}

/**
 * Some "unresolved" dependency jars turn out to be an entire accidentally-bundled project export
 * (an Eclipse/SVN working copy zipped up whole) rather than a real library — confirmed live: one
 * such jar's own top-level .class entries numbered only 39, but it also contained SIX nested
 * `.jar` files under a `WebRoot/WEB-INF/lib/` path inside it (leftover `WEB-INF/lib` jars from
 * whatever project got exported) — AND, confirmed live as a second layer of the same problem,
 * old-format SVN working copies also keep a pristine binary copy of every tracked file under
 * `.svn/text-base/<name>.svn-base`, so each of those six jars had a SECOND copy sitting at e.g.
 * `WebRoot/WEB-INF/lib/.svn/text-base/wwapp_services-2.0.20110406.jar.svn-base` — a name that
 * does NOT end in `.jar`, so a name-only filter misses it entirely. JADX recursively unpacks and
 * decompiles ANY entry whose bytes are themselves a valid zip, regardless of its name — confirmed
 * by re-running against a jar with only the `.jar`-suffixed copies stripped and finding the
 * `.svn-base` copy still got pulled in. CFR/Vineflower/jd-cli/Procyon do not unpack nested
 * archives at all — they only ever see the real top-level entries. The result: for every class
 * that only exists inside one of those nested jars, JADX is the ONLY engine with any candidate at
 * all, so candidateScoringService.ts's "run everything, pick the best" competition never gets a
 * chance to run — whatever JADX produces ships as-is, including its own known `?? var = ...;`
 * unresolvable-type-placeholder corruption (see variableConflictDetector.ts), with zero fallback.
 * It can also silently duplicate an OLDER embedded copy of a class that's already correctly
 * resolved as its own separate dependency elsewhere in the WAR.
 *
 * Fix: strip any entry that is a nested archive BY CONTENT (its bytes start with a zip local-file-
 * header/EOCD signature), not just by name — the name check runs first as a cheap skip so an
 * obviously-named nested jar/war/zip never needs its bytes inspected, but every other entry still
 * gets a magic-number check before being trusted as a real resource. This way all five engines see
 * the identical, uniform set of top-level classes — no engine gets an unfair, uncontested view
 * that a genuinely bad decompile can't be rescued from. Returns the original jarPath unchanged (no
 * sanitize round-trip) when there's nothing to strip, which is the overwhelming majority of real
 * dependency jars.
 */
export async function stripNestedArchives(
  jarPath: string,
  tempDir: string,
): Promise<{ jarPath: string; strippedEntries: string[] }> {
  let zip: AdmZip;
  try {
    zip = new AdmZip(jarPath);
  } catch {
    return { jarPath, strippedEntries: [] }; // unreadable as a zip — let the real engines report that themselves
  }

  const entries = zip.getEntries();

  // Classify every entry once: name match is a cheap skip (no decompression needed for an
  // obviously-named nested jar/war/zip); everything else still gets its bytes checked for a zip
  // magic number before being trusted, since a renamed/extension-less copy (e.g. an SVN
  // `.svn-base` pristine copy) is exactly as much of a problem as an obviously-named one.
  const kept: { name: string; isDirectory: boolean; data: Buffer | null }[] = [];
  const strippedEntries: string[] = [];
  for (const entry of entries) {
    if (entry.isDirectory) { kept.push({ name: entry.entryName, isDirectory: true, data: null }); continue; }
    if (NESTED_ARCHIVE_NAME_RE.test(entry.entryName)) { strippedEntries.push(entry.entryName); continue; }
    const data = entry.getData();
    if (looksLikeZipContent(data)) { strippedEntries.push(entry.entryName); continue; }
    kept.push({ name: entry.entryName, isDirectory: false, data });
  }
  if (!strippedEntries.length) return { jarPath, strippedEntries: [] };

  const extractDir = path.join(tempDir, 'sanitize-src');
  fs.mkdirSync(extractDir, { recursive: true });
  for (const item of kept) {
    const dest = path.join(extractDir, item.name);
    if (item.isDirectory) { fs.mkdirSync(dest, { recursive: true }); continue; }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, item.data!);
  }

  const sanitizedJarPath = path.join(tempDir, 'sanitized.jar');
  await zipDirectoryToJar(extractDir, sanitizedJarPath);
  fs.rmSync(extractDir, { recursive: true, force: true });
  return { jarPath: sanitizedJarPath, strippedEntries };
}

/** Run every installed engine against `inputJar`, score each class, and copy the winning
 * engine's file per class into the flat `outputDir` (no per-engine subfolders in the result —
 * matches what CFR-only used to produce). Returns the winning engine per fqcn so the caller can
 * check that specific file's own failure markers afterward (a class's winner might still carry
 * markers if literally every engine struggled with it). */
async function runAllEnginesAndPickWinners(
  inputJar: string,
  tempDir: string,
  outputDir: string,
  engineStatuses: Record<DecompilerEngine, EngineStatus>,
  timeoutMs: number,
  onCommandStart?: (line: string) => void,
): Promise<Map<string, DecompilerEngine>> {
  const engineNames = Config.enabledEngines;

  async function runOrSkip(engine: DecompilerEngine): Promise<DecompileRunResult | null> {
    const status = engineStatuses[engine];
    if (!status?.installed || !status.jarPath) return null;
    const engineOutDir = path.join(tempDir, engine);
    try {
      return await runEngineAgainstJar(engine, status.jarPath, inputJar, engineOutDir, timeoutMs, onCommandStart);
    } catch (err: any) {
      logger.warn(`[${engine}] crashed decompiling ${path.basename(inputJar)}: ${err.message}`);
      return null;
    }
  }

  const settled = Config.decompileParallel
    ? await Promise.all(engineNames.map(runOrSkip))
    : await (async () => {
        const out: (DecompileRunResult | null)[] = [];
        for (const engine of engineNames) out.push(await runOrSkip(engine));
        return out;
      })();
  const results: DecompileRunResult[] = settled.filter((r): r is DecompileRunResult => r !== null);

  const winnerByFqcn = new Map<string, DecompilerEngine>();
  const usable = results.filter(r => r.ran);
  if (!usable.length) return winnerByFqcn;

  for (const r of usable) cleanKnownDecompilerArtifacts(r.outputDir);

  const candidates = await scoreAllCandidates(usable);
  fs.mkdirSync(outputDir, { recursive: true });
  for (const candidate of candidates) {
    if (!candidate.winningEngine) continue;
    const winnerDir = usable.find(r => r.engine === candidate.winningEngine)!.outputDir;
    const src = path.join(winnerDir, `${candidate.fqcn}.java`);
    if (!fs.existsSync(src)) continue;
    const dest = path.join(outputDir, `${candidate.fqcn}.java`);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(src, dest);
    winnerByFqcn.set(candidate.fqcn, candidate.winningEngine);
  }

  return winnerByFqcn;
}

/** AI-clean whichever files still carry their own winning engine's failure marker, overwriting
 * them in place. Best-effort — a batch that fails just leaves those files as decompiled. */
async function aiCleanFlaggedFiles(
  outputDir: string,
  winnerByFqcn: Map<string, DecompilerEngine>,
  allDependencies: DependencyResolution[],
  onBatchProgress?: (done: number, total: number) => void,
): Promise<{ reconstructed: number; flagged: number }> {
  const items: ReconstructionItem[] = [];
  const pathByFqcn = new Map<string, string>();

  for (const [fqcn, engine] of winnerByFqcn.entries()) {
    const file = path.join(outputDir, `${fqcn}.java`);
    if (!fs.existsSync(file)) continue;
    const source = fs.readFileSync(file, 'utf8');
    // Flag on either signal — a marker comment, OR a real parse failure the marker-based check
    // alone can miss entirely (confirmed live: CFR's mangled try/catch/finally output leaves no
    // marker comment at all but still won't parse).
    const hasMarkers = findFailureMarkers(engine, source).length > 0;
    const parsesCleanly = (await checkJavaSyntax(source)).valid;
    if (!hasMarkers && parsesCleanly) continue;
    items.push({ fqcn, source });
    pathByFqcn.set(fqcn, file);
  }

  if (!items.length) return { reconstructed: 0, flagged: 0 };

  const outcomes = await runAiBatchReconstruction(items, allDependencies, (fqcn, source) => {
    const dest = pathByFqcn.get(fqcn);
    if (dest) fs.writeFileSync(dest, source, 'utf8');
  }, onBatchProgress);

  let reconstructed = 0;
  for (const outcome of outcomes.values()) if (outcome === 'reconstructed') reconstructed++;
  return { reconstructed, flagged: items.length };
}

/** Recursively copies every file from `srcDir` into `destDir`, creating directories as needed. */
export function copyDirRecursive(srcDir: string, destDir: string): void {
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const src = path.join(srcDir, entry.name);
    const dest = path.join(destDir, entry.name);
    if (entry.isDirectory()) { fs.mkdirSync(dest, { recursive: true }); copyDirRecursive(src, dest); }
    else fs.copyFileSync(src, dest);
  }
}

/** Shared, app-wide cache directory for one jar's fully decompiled+AI-cleaned output, keyed by
 * the jar's own SHA-1 (identical bytes -> identical decompile, regardless of which job or which
 * WAR it was bundled in). A cache hit means this jar has already been through the full
 * "run every engine, score, AI-clean flagged classes" pipeline at least once before — copying
 * its result is always cheaper and gives the identical output a fresh run would produce. */
function decompiledLibCacheDirFor(sha1: string): string {
  return path.join(Config.decompiledLibCachePath, sha1);
}

export interface DedupeResult {
  /** fqcn -> {kept: artifactId, removedFrom: artifactId[]} for every class that was duplicated
   * across two or more decompiled dependencies. */
  conflicts: { fqcn: string; kept: string; removedFrom: string[] }[];
}

/**
 * Confirmed live on a real 47-dependency WAR: 50 classes existed, byte-identical or near-
 * identical, in TWO separate "unresolved" dependency jars at once (e.g. `fhccustintfsol.jar` and
 * `FhcExtraIntfSolProj.jar` both legitimately bundle `com.wovenware.fhc.intfsol.extra.Constants`
 * — an old enterprise app where the same shared classes got copy-pasted into multiple internal
 * library jars over the years, not a decompiler artifact and not something
 * stripNestedArchives()/candidateScoringService.ts can catch, since each copy decompiles cleanly
 * on its own). Each dependency's `lib-src/<artifactId>` folder becomes its own Maven source root
 * (projectGeneratorService.ts), so two source roots both declaring the same fully-qualified class
 * is a hard `javac` "duplicate class" error for every single one of them — this was the actual
 * dominant error category in that run, not visible as such until the `??`-placeholder corruption
 * (stripNestedArchives' own target) stopped drowning it out.
 *
 * Scans every decompiled dependency folder under `workspaceDir/decompiled-libs/` directly (not
 * the `dependencies` array — a caller may only pass a subset of dependencies for a given call, but
 * the directory on disk is always the authoritative full picture) and, for every fully-qualified
 * class that appears in more than one dependency, keeps exactly one copy and deletes the file from
 * every other dependency's folder. Prefers whichever copy actually parses as valid Java (ties
 * broken by dependency artifactId, alphabetically, for determinism) — same principle as
 * aiReconstructionService.ts's "prefer the next-best candidate when the winner doesn't parse".
 */
export async function dedupeAcrossDependencies(workspaceDir: string): Promise<DedupeResult> {
  const libsRoot = path.join(workspaceDir, 'decompiled-libs');
  const result: DedupeResult = { conflicts: [] };
  if (!fs.existsSync(libsRoot)) return result;

  const artifactIds = fs.readdirSync(libsRoot, { withFileTypes: true })
    .filter(e => e.isDirectory()).map(e => e.name).sort();

  const byFqcn = new Map<string, string[]>(); // fqcn (relative .java path) -> artifactIds that have it
  for (const artifactId of artifactIds) {
    const depDir = path.join(libsRoot, artifactId);
    (function walk(dir: string, rel: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) { walk(full, relPath); continue; }
        if (!entry.name.endsWith('.java')) continue;
        if (!byFqcn.has(relPath)) byFqcn.set(relPath, []);
        byFqcn.get(relPath)!.push(artifactId);
      }
    })(depDir, '');
  }

  for (const [fqcn, owners] of byFqcn) {
    if (owners.length < 2) continue;

    let keeper = owners[0];
    for (const artifactId of owners) {
      const { valid } = await checkJavaSyntax(fs.readFileSync(path.join(libsRoot, artifactId, fqcn), 'utf8'));
      if (valid) { keeper = artifactId; break; }
    }

    const removedFrom: string[] = [];
    for (const artifactId of owners) {
      if (artifactId === keeper) continue;
      fs.rmSync(path.join(libsRoot, artifactId, fqcn), { force: true });
      removedFrom.push(artifactId);
    }
    result.conflicts.push({ fqcn, kept: keeper, removedFrom });
  }

  return result;
}

/**
 * Mutates each 'unresolved' dependency in place, setting `decompiledSourceDir` (relative to
 * `workspaceDir`) when at least one engine succeeds. Deliberately best-effort per jar — one
 * failing jar (e.g. genuinely corrupt, or every engine chokes on something pathological) must
 * never block the others or the job; it just stays an unresolved placeholder, same as before
 * this feature existed.
 */
export async function decompileUnresolvedDependencies(
  dependencies: DependencyResolution[],
  libJarPathByName: Map<string, string>,
  workspaceDir: string,
  engineStatuses: Record<DecompilerEngine, EngineStatus>,
  /** Called at key points per jar so the job's user-facing log shows real progress — this stage
   * can now run long (real per-class syntax verification + AI cleanup across every unresolved
   * jar, some with thousands of classes) with no other status/log update in between, so without
   * this a job in this stage looks frozen to anyone watching the API/UI even though it's making
   * real progress internally. */
  onProgress?: (msg: string) => void,
): Promise<void> {
  const unresolved = dependencies.filter(d => d.confidence === 'unresolved');
  if (!unresolved.length) return;

  const anyEngineInstalled = (['cfr', 'vineflower', 'jdcli', 'jadx', 'procyon'] as DecompilerEngine[])
    .some(e => engineStatuses[e]?.installed && engineStatuses[e]?.jarPath);
  if (!anyEngineInstalled) {
    logger.warn(`${unresolved.length} unresolved dependenc${unresolved.length === 1 ? 'y' : 'ies'} found but no decompiler engine is installed — leaving them as placeholders. Install one from Tool Setup to decompile these too.`);
    return;
  }

  let jarIndex = 0;
  for (const dep of unresolved) {
    jarIndex++;
    const jarPath = libJarPathByName.get(dep.jarName);
    if (!jarPath || !fs.existsSync(jarPath)) {
      logger.warn(`Cannot decompile ${dep.jarName} — original jar not found on disk.`);
      continue;
    }

    const relDir = path.join('decompiled-libs', dep.artifactId!);
    const outputDir = path.join(workspaceDir, relDir);

    const cacheDir = decompiledLibCacheDirFor(dep.sha1);
    if (fs.existsSync(cacheDir) && fs.readdirSync(cacheDir).length > 0) {
      fs.mkdirSync(outputDir, { recursive: true });
      copyDirRecursive(cacheDir, outputDir);
      dep.decompiledSourceDir = relDir;
      logger.info(`${dep.jarName}: reused previously decompiled+AI-cleaned output from cache (same jar bytes seen before) — skipped re-decompiling.`);
      onProgress?.(`[${jarIndex}/${unresolved.length}] ${dep.jarName}: reused cached decompile (identical jar seen before).`);
      continue;
    }

    const tempDir = path.join(workspaceDir, 'tmp-lib-decompile', dep.artifactId!);
    fs.mkdirSync(tempDir, { recursive: true });

    const { jarPath: sanitizedJarPath, strippedEntries } = await stripNestedArchives(jarPath, tempDir);
    if (strippedEntries.length) {
      logger.warn(`${dep.jarName} contains ${strippedEntries.length} nested archive(s) (${strippedEntries.slice(0, 5).join(', ')}${strippedEntries.length > 5 ? ', ...' : ''}) — this looks like an accidentally-bundled project export rather than a real dependency. Stripped them before decompiling so no single engine gets an uncontested view of their contents.`);
      onProgress?.(`[${jarIndex}/${unresolved.length}] ${dep.jarName}: stripped ${strippedEntries.length} nested archive(s) before decompiling.`);
    }

    logger.info(`Decompiling unresolved dependency ${dep.jarName} across all installed engines...`);
    onProgress?.(`[${jarIndex}/${unresolved.length}] Decompiling ${dep.jarName}...`);
    const winnerByFqcn = await runAllEnginesAndPickWinners(sanitizedJarPath, tempDir, outputDir, engineStatuses, Config.decompilerTimeoutMs, onProgress);
    fs.rmSync(tempDir, { recursive: true, force: true });

    if (!winnerByFqcn.size) {
      logger.warn(`Every installed engine failed on ${dep.jarName} — leaving it as an unresolved placeholder.`);
      onProgress?.(`[${jarIndex}/${unresolved.length}] ${dep.jarName}: every engine failed, left as placeholder.`);
      continue;
    }
    dep.decompiledSourceDir = relDir;

    const enginesUsed = new Set(winnerByFqcn.values());
    logger.info(`${dep.jarName}: decompiled ${winnerByFqcn.size} class(es), winning engine(s): ${Array.from(enginesUsed).join(', ')}.`);

    const { reconstructed, flagged } = await aiCleanFlaggedFiles(outputDir, winnerByFqcn, dependencies, (done, total) => {
      onProgress?.(`[${jarIndex}/${unresolved.length}] ${dep.jarName}: AI-cleaning flagged class(es) — batch ${done}/${total}...`);
    });
    if (flagged > 0) {
      logger.info(`${dep.jarName}: AI cleaned up ${reconstructed}/${flagged} flagged class(es).`);
    }
    onProgress?.(`[${jarIndex}/${unresolved.length}] ${dep.jarName}: decompiled ${winnerByFqcn.size} class(es) (${Array.from(enginesUsed).join(', ')})${flagged > 0 ? `, AI cleaned ${reconstructed}/${flagged}` : ''}.`);

    // Best-effort — a cache write failure (e.g. disk full) never fails the job, it just means
    // the next job with this same jar redoes the full pipeline instead of reusing it.
    try {
      fs.mkdirSync(cacheDir, { recursive: true });
      copyDirRecursive(outputDir, cacheDir);
    } catch (err: any) {
      logger.warn(`Could not persist decompiled-lib cache for ${dep.jarName}: ${err.message}`);
    }
  }

  // Runs against the FULL decompiled-libs/ tree on disk, not just this call's `unresolved`
  // subset — a retry call only re-decompiling a handful of previously-failed dependencies still
  // needs to be checked against everything already decompiled by an earlier call, since the
  // conflict can be between a dependency from THIS call and one from an earlier call.
  const { conflicts } = await dedupeAcrossDependencies(workspaceDir);
  if (conflicts.length) {
    logger.warn(`${conflicts.length} class(es) existed in more than one decompiled dependency (duplicate content bundled across separate legacy jars) — kept one copy of each, removed the rest: ${conflicts.slice(0, 5).map(c => c.fqcn).join(', ')}${conflicts.length > 5 ? ', ...' : ''}`);
    onProgress?.(`Removed ${conflicts.length} duplicate class(es) found across multiple decompiled dependencies.`);
  }
}
