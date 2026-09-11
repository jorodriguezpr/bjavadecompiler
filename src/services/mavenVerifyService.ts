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
 * BJavaDecompiler - Stage 7 (part 1): recompilation verification.
 *
 * Runs `mvn -q -DskipTests compile` against the generated project — compile is enough to prove
 * "recompilable" per the fidelity goal; packaging isn't required. Before compiling, any
 * dependency marked 'unresolved' gets `mvn install:install-file`'d into the local repo under
 * its placeholder coordinate (using the original jar, copied alongside the generated project)
 * so the build can actually resolve it. Parses `[ERROR] .../Foo.java:[12,34] ...` lines and
 * groups them by file for aiRemediationService.ts to act on.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Logger } from '../core/logger';
import { Config } from '../config/config';
import { DependencyResolution } from '../models/job';

const logger = Logger.getLogger('MavenVerifyService');

/** Every mvn invocation in this file must use this — see Config.mavenLocalRepoPath for why. */
function withLocalRepo(args: string[]): string[] {
  return [...args, `-Dmaven.repo.local=${Config.mavenLocalRepoPath}`];
}

export interface BrokenArtifact {
  groupId: string;
  artifactId: string;
}

/** Fired right before `mvn` is spawned, with the exact command line — wired to the job log / a
 * "current activity" UI field so a developer watching the dashboard sees the real command
 * instead of just "verifying build...". */
export type CommandStartCallback = (line: string) => void;

export interface MavenRunResult {
  success: boolean;
  stdout: string;
  stderr: string;
  command: string;
  durationMs: number;
  errorsByFile: Record<string, string[]>;
  errorCount: number;
  /** A resolved dependency whose OWN pom.xml (or a POM in its parent chain) fails to resolve
   * on Central — confirmed real case: an old jar matched to a real, existing artifact whose
   * declared parent POM was a since-deleted SNAPSHOT. This is a project-wide dependency-
   * resolution failure, not a per-file compile error, so it never matches ERROR_LINE_RE — kept
   * separate so callers can tell "some class has a bug" from "a dependency itself is broken
   * upstream" and react differently (the latter can't be fixed by editing source). */
  brokenArtifacts: BrokenArtifact[];
  /** True when Maven failed for a reason that produced neither a per-file error nor a
   * recognized broken-artifact message — e.g. a plugin/reactor-level failure. errorCount stays
   * honest (not silently 0) even when nothing more specific could be extracted. */
  hasUnclassifiedFailure: boolean;
  /** Unique package names javac reported as not existing at all (`package X does not exist`) —
   * unlike brokenArtifacts (a dependency this job already knows about that fails to resolve),
   * these are classes the decompiled source references that were never bundled in the WAR's own
   * WEB-INF/lib to begin with, so there's no existing job.dependency entry to fix. Already
   * counted once each in errorCount (it's a normal per-file ERROR_LINE_RE match, present in
   * errorsByFile too) — this field just pulls the package name back out for
   * sharedLibraryPackageSearchService.ts to act on. */
  missingPackages: string[];
}

/** When a job targets a Java release with a Config.jdkHomeOverrides entry, `mvn` needs to actually
 * run under THAT JDK rather than whatever satisfies toolchainCheck.ts's own floor — overriding
 * JAVA_HOME and prepending its bin/ to PATH on the child process achieves that without needing
 * Maven's own toolchains.xml mechanism. Undefined/null (the default, no override configured for
 * this version) inherits process.env exactly as before this feature existed. */
function envForJavaHome(javaHome?: string | null): NodeJS.ProcessEnv {
  if (!javaHome) return process.env;
  return { ...process.env, JAVA_HOME: javaHome, PATH: `${path.join(javaHome, 'bin')}${path.delimiter}${process.env.PATH || ''}` };
}

function runMaven(args: string[], cwd: string, onCommandStart?: CommandStartCallback, javaHome?: string | null): Promise<{ stdout: string; stderr: string; code: number | null; command: string; durationMs: number }> {
  const command = `mvn ${args.join(' ')}`;
  logger.info(`running: ${command} (cwd: ${cwd}${javaHome ? `, JAVA_HOME=${javaHome}` : ''})`);
  onCommandStart?.(command);
  const startedAt = Date.now();
  return new Promise((resolve) => {
    // mvn resolves to mvn.cmd on Windows — shell:true matches what a real terminal would find.
    const child = spawn('mvn', args, { cwd, shell: true, windowsHide: true, env: envForJavaHome(javaHome) });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => resolve({ stdout, stderr: err.message, code: -1, command, durationMs: Date.now() - startedAt }));
    child.on('close', (code) => resolve({ stdout, stderr, code, command, durationMs: Date.now() - startedAt }));
  });
}

/** `[ERROR] /path/to/Foo.java:[12,34] cannot find symbol` — group by file. */
const ERROR_LINE_RE = /^\[ERROR\]\s+(.+\.java):\[(\d+),(\d+)\]\s*(.*)$/;

/** `[ERROR] Failed to read artifact descriptor for org.foo:bar:jar:1.2.3` — the dependency
 * itself (or something in its parent-POM chain) doesn't resolve on Central. Distinct from a
 * per-file compile error and from the generic "Could not resolve dependencies" summary line
 * that always precedes it (that one names the top-level project, not the actual broken jar,
 * so it's not useful to extract from). */
const BROKEN_ARTIFACT_RE = /^\[ERROR\]\s+Failed to read artifact descriptor for ([^:\s]+):([^:\s]+):jar:\S+/;

/** `[ERROR] 	org.foo:bar:jar:1.2.3 was not found in https://repo.maven.apache.org/maven2 ...`
 * — a different failure shape from the one above: here the artifact's own descriptor is fine,
 * it just plain doesn't exist at that coordinate at all. Confirmed live: this hit even a
 * SHA-1-matched dependency (Maven Central's search index returned a version for a jar's hash
 * that turned out not to actually be downloadable) — so this isn't limited to low-confidence
 * 'guess' matches; any resolved coordinate can turn out to be dead. */
const ARTIFACT_NOT_FOUND_RE = /^\[ERROR\]\s+([^:\s]+):([^:\s]+):jar:\S+\s+was not found in/;

/** `[ERROR] 	Could not find artifact org.foo:bar:jar:1.2.3 in central (https://...), try
 * downloading from ...` — a THIRD failure shape, distinct from both of the above: Maven's own
 * default "no matching artifact anywhere" message, most often seen on an old pre-Central-era
 * coordinate that carries a relocation/manual-download hint in its metadata (confirmed real case:
 * javax.mail:mail:1.3.3 and javax.activation:activation:1.0.2, pulled in transitively by an
 * ancient commons-email:1.0 — Maven appends "try downloading from
 * http://java.sun.com/products/javamail/downloads/..." for exactly these). Without this pattern,
 * such a failure fell into hasUnclassifiedFailure instead of brokenArtifacts — errorCount stayed
 * honestly non-zero, but toDemote/toExclude below never got a groupId:artifactId to act on, so a
 * transitive dependency that will NEVER resolve just silently burned every remaining build-fix
 * attempt with zero progress instead of being excluded after the first one. */
const ARTIFACT_COULD_NOT_FIND_RE = /^\[ERROR\]\s+Could not find artifact ([^:\s]+):([^:\s]+):jar:\S+/;

/** `[ERROR] Failed to execute goal on project X: Could not resolve dependencies for project
 * Y:war:1.0.0: The following artifacts could not be resolved: javax.mail:mail:jar:1.3.3 (absent),
 * javax.activation:activation:jar:1.0.2 (absent): javax.mail:mail:jar:1.3.3 was not found in
 * https://repo.maven.apache.org/maven2 during a previous attempt. This failure was cached in the
 * local repository and resolution is not reattempted until the update interval of central has
 * elapsed or updates are forced -> [Help 1]` — a FOURTH real-world shape, confirmed live via
 * NetBeans on this exact commons-email-transitive javax.mail/javax.activation case already
 * described above at ARTIFACT_COULD_NOT_FIND_RE. Unlike all three regexes above, this is
 * `mvn -q`'s (what runMaven() always passes) own condensed single-line rendering of a dependency-
 * resolution failure: the artifact coordinate is NOT at the start of the line (it's preceded by
 * "Failed to execute goal...Could not resolve dependencies..."), and — unlike the other three
 * shapes, which only ever name ONE artifact — this line can list SEVERAL broken artifacts at once,
 * comma-separated, each suffixed `(absent)`. Matched separately (via matchAll, not a single
 * per-line capture) so every artifact in the list is extracted, not just the first. Without this,
 * such a failure fell into hasUnclassifiedFailure (brokenArtifacts stayed empty), so the
 * toDemote/toExclude logic in decompileJobService.ts never got a groupId:artifactId to exclude —
 * every remaining build-fix attempt just re-ran the identical failing build with zero progress. */
const ARTIFACTS_ABSENT_RE = /([^\s:,]+):([^\s:,]+):jar:\S+?\s*\(absent\)/g;

/** Confirmed live on Windows: Maven reports compile-error paths as `/C:/PhpProjects/...` — a
 * leading slash before the drive letter. That's not a valid filesystem path on Windows (Node's
 * `fs.existsSync` on it returns false even though the real file exists one character later, at
 * `C:/PhpProjects/...`), so every downstream consumer (aiRemediationService.ts's
 * `fs.existsSync`/`readFileSync`/`writeFileSync`) silently failed to find real, on-disk files.
 * Strip that leading slash here, once, so `errorsByFile`'s keys are already real, usable paths. */
function normalizeMavenPath(file: string): string {
  return file.replace(/^\/([A-Za-z]:)/, '$1');
}

/** javac's own continuation lines for `cannot find symbol` (and similar diagnostics), e.g.:
 *   [ERROR] /path/Foo.java:[10,5] cannot find symbol
 *     symbol:   class Bar
 *     location: class Foo
 * Confirmed live via a real `mvn compile` against this project's own generated output that Maven
 * prints its full error list TWICE — once inline as errors are found (continuation lines with NO
 * `[ERROR]` prefix at all, just indented text) and again in the final build summary (continuation
 * lines WITH an `[ERROR]` prefix) — which also fully explains the long-observed "every error
 * appears duplicated in errorsByFile" pattern (now deduped at the end of `parseErrors()`, see
 * below). Neither shape ever matched ERROR_LINE_RE (no `[line,col]` on a continuation
 * line) and both were silently dropped entirely before this — meaning the symbol/location detail
 * javac ALWAYS emits for this error was invisible to every downstream consumer despite both being
 * built to expect it: deterministicRemediationService.ts's `CANNOT_FIND_SYMBOL_RE` looks for
 * exactly this `\n  symbol: class X` shape to identify a missing-import candidate, and
 * aiRemediationService.ts's prompt just silently lost the one piece of information ("class Bar" —
 * the actual missing type name) that would tell either a deterministic pass or an AI what import
 * to add. Appended to the error line it immediately follows, not treated as a new error of its
 * own — `last` resets on any other kind of line so a continuation is never attributed to a stale,
 * non-adjacent earlier error. */
const SYMBOL_DETAIL_RE = /^(?:\[ERROR\])?\s+(symbol|location):\s*(.+)$/;

/** javac's continuation line for a `cannot implement` error's most common cause — an overriding
 * method declaring a checked exception the interface/superclass method doesn't permit, e.g.:
 *   [ERROR] .../FFGhostActiveHook.java:[95,17] process(FileObj) in FFGhostActiveHook cannot
 *           implement process(FileObj) in PreMoverHookIntf
 *     overridden method does not throw com.wovenware.util.OperationException
 * Confirmed live (same duplicate-emission pattern as SYMBOL_DETAIL_RE above: with and without an
 * `[ERROR]` prefix). Was previously silently dropped the same way symbol/location lines used to
 * be — this is what deterministicRemediationService.ts's throws-clause fix needs to know exactly
 * which exception to remove, without independently re-deriving it by resolving and re-parsing the
 * interface's own source file. */
const OVERRIDDEN_THROWS_DETAIL_RE = /^(?:\[ERROR\])?\s+overridden method does not throw ([\w.$]+)\s*$/;

export function parseErrors(output: string): Record<string, string[]> {
  const byFile: Record<string, string[]> = {};
  let last: { file: string; index: number } | null = null;

  for (const line of output.split('\n')) {
    const m = line.match(ERROR_LINE_RE);
    if (m) {
      const [, rawFile, lineNo, col, message] = m;
      const file = normalizeMavenPath(rawFile);
      if (!byFile[file]) byFile[file] = [];
      byFile[file].push(`[${lineNo},${col}] ${message}`);
      last = { file, index: byFile[file].length - 1 };
      continue;
    }
    const detail = line.match(SYMBOL_DETAIL_RE);
    if (detail && last) {
      byFile[last.file][last.index] += `\n  ${detail[1]}: ${detail[2].trim()}`;
      continue;
    }
    const throwsDetail = line.match(OVERRIDDEN_THROWS_DETAIL_RE);
    if (throwsDetail && last) {
      byFile[last.file][last.index] += `\n  overridden method does not throw ${throwsDetail[1]}`;
      continue;
    }
    last = null; // any other line means we're no longer looking at that error's own continuation
  }

  // Maven prints its full error list twice per run (see SYMBOL_DETAIL_RE above) — so every
  // entry built above appears exactly twice per file with byte-identical text (main line plus
  // any continuation lines). Collapse to the first occurrence per file so errorCount, remediation
  // prompts, and per-file fix passes all see each real error once. Confirmed live: a 19MB WAR's
  // real build reported 564 errors this way when the true unique count was 282.
  for (const file of Object.keys(byFile)) {
    const seen = new Set<string>();
    byFile[file] = byFile[file].filter((entry) => (seen.has(entry) ? false : (seen.add(entry), true)));
  }

  return byFile;
}

/** `[ERROR] /path/Foo.java:[12,34] package com.foo.bar does not exist` — a normal per-file
 * compile error (already captured in errorsByFile via ERROR_LINE_RE), re-extracted here purely
 * for its package name so sharedLibraryPackageSearchService.ts has something to search on. */
const PACKAGE_NOT_EXIST_RE = /^\[ERROR\]\s+.+\.java:\[\d+,\d+\]\s*package ([\w.]+) does not exist\s*$/;

export function parseMissingPackages(output: string): string[] {
  const found = new Set<string>();
  for (const line of output.split('\n')) {
    const m = line.match(PACKAGE_NOT_EXIST_RE);
    if (m) found.add(m[1]);
  }
  return Array.from(found);
}

export function parseBrokenArtifacts(output: string): BrokenArtifact[] {
  const found: BrokenArtifact[] = [];
  const seen = new Set<string>();
  const add = (groupId: string, artifactId: string) => {
    const key = `${groupId}:${artifactId}`;
    if (seen.has(key)) return;
    seen.add(key);
    found.push({ groupId, artifactId });
  };
  for (const line of output.split('\n')) {
    // Checked first and independently of the single-artifact regexes below (not else-if) —
    // ARTIFACTS_ABSENT_RE's own line can also happen to satisfy ARTIFACT_NOT_FOUND_RE for its
    // FIRST-listed artifact only (Maven repeats it after the list, see the doc comment above), so
    // relying on `||` short-circuiting there would silently drop every OTHER artifact on the line.
    const absentMatches = [...line.matchAll(ARTIFACTS_ABSENT_RE)];
    if (absentMatches.length) {
      for (const m of absentMatches) add(m[1], m[2]);
      continue;
    }
    const m = line.match(BROKEN_ARTIFACT_RE) || line.match(ARTIFACT_NOT_FOUND_RE) || line.match(ARTIFACT_COULD_NOT_FIND_RE);
    if (!m) continue;
    add(m[1], m[2]);
  }
  return found;
}

export async function installUnresolvedDependencies(
  projectDir: string,
  unresolved: DependencyResolution[],
  jarPathByName: Map<string, string>,
  onCommandStart?: CommandStartCallback,
  javaHome?: string | null,
): Promise<void> {
  for (const dep of unresolved) {
    const jarPath = jarPathByName.get(dep.jarName);
    if (!jarPath || !fs.existsSync(jarPath)) {
      logger.warn(`Cannot install-file ${dep.jarName} — original jar not found on disk, leaving unresolved.`);
      continue;
    }
    const args = withLocalRepo([
      'install:install-file',
      `-Dfile=${jarPath}`,
      `-DgroupId=${dep.groupId}`,
      `-DartifactId=${dep.artifactId}`,
      `-Dversion=${dep.version}`,
      '-Dpackaging=jar',
      '-q',
    ]);
    const { code, stderr } = await runMaven(args, projectDir, onCommandStart, javaHome);
    if (code !== 0) {
      logger.warn(`install:install-file failed for ${dep.jarName}: ${stderr.slice(0, 300)}`);
    }
  }
}

export async function verifyBuild(projectDir: string, onCommandStart?: CommandStartCallback, javaHome?: string | null): Promise<MavenRunResult> {
  const { stdout, stderr, code, command, durationMs } = await runMaven(withLocalRepo(['-q', '-DskipTests', 'compile']), projectDir, onCommandStart, javaHome);
  // Confirmed live on Windows: Maven's output is CRLF-terminated, and a trailing \r survives
  // `.split('\n')` on each line. JS regex excludes \r from both `.` (unless the `s`/dotAll flag
  // is set) and from matching before a lone trailing `$` — so any $-anchored per-line regex
  // (ERROR_LINE_RE) silently matched nothing at all on this platform, while the two
  // BROKEN_ARTIFACT/ARTIFACT_NOT_FOUND regexes "worked" only by coincidence (neither anchors at
  // the line's end). Normalizing CRLF->LF once, here, fixes every regex in this file at once
  // rather than hardening each one individually.
  const combined = `${stdout}\n${stderr}`.replace(/\r\n/g, '\n');
  const errorsByFile = parseErrors(combined);
  const brokenArtifacts = parseBrokenArtifacts(combined);
  const missingPackages = parseMissingPackages(combined);
  const success = code === 0;
  // errorCount must never silently read 0 on a real failure just because it wasn't a per-file
  // compile error — confirmed live: a broken-artifact failure produced exactly that mismatch
  // (success:false, 0 parsed errors) and made the remediation loop a silent no-op every attempt.
  const fileErrorCount = Object.values(errorsByFile).reduce((sum, errs) => sum + errs.length, 0);
  const hasUnclassifiedFailure = !success && fileErrorCount === 0 && brokenArtifacts.length === 0;
  const errorCount = fileErrorCount + brokenArtifacts.length + (hasUnclassifiedFailure ? 1 : 0);
  return { success, stdout, stderr, command, durationMs, errorsByFile, errorCount, brokenArtifacts, hasUnclassifiedFailure, missingPackages };
}

/**
 * A coarse identity fingerprint for a build result — deliberately independent of `errorCount`,
 * since two genuinely DIFFERENT problems can produce the exact same count. Confirmed real case:
 * a broken DIRECT dependency (2 broken artifacts) gets demoted/auto-matched, which fixes it but
 * exposes a completely different broken TRANSITIVE dependency (also 2 broken artifacts, pulled in
 * by an unrelated jar) — decompileJobService.ts's "no net progress" bail-out compared only the
 * count, saw 2 -> 2, and stopped one attempt too early, permanently stranding the job on a fixable
 * problem it never got a second chance to look at. Used alongside errorCount so a same-count
 * result is only treated as a genuine stall when the underlying broken artifacts/files/missing
 * packages are ALSO unchanged — a different signature at the same count means real progress
 * happened and another attempt is worth it.
 */
export function buildResultSignature(build: MavenRunResult): string {
  const brokenKeys = build.brokenArtifacts.map(b => `${b.groupId}:${b.artifactId}`).sort();
  const fileKeys = Object.keys(build.errorsByFile).sort();
  const missingKeys = [...build.missingPackages].sort();
  return JSON.stringify({ brokenKeys, fileKeys, missingKeys, unclassified: build.hasUnclassifiedFailure });
}
