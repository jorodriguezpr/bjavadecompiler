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
 * BJavaDecompiler - Stage 3: decompilation.
 *
 * Runs CFR, Vineflower, jd-cli, and JADX as four independent child_process invocations against
 * the scoped class tree (see extractionService.ts — application classes only). None support
 * true per-class invocation, so each produces one candidate source tree; per-class winner
 * selection happens afterward in candidateScoringService.ts. An engine that crashes on
 * pathological bytecode (jd-core in particular has been known to abort mid-run) never fails
 * the whole job — only the absence of ALL FIVE outputs does.
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import yazl from 'yazl';
import { Config } from '../config/config';
import { Logger } from '../core/logger';
import { DecompilerEngine } from '../models/job';
import { EngineStatus } from '../core/externalTools';

const logger = Logger.getLogger('DecompilerRunner');

/** CFR (unlike Vineflower/jd-cli) refuses a bare directory of .class files as input — confirmed
 * live: `CannotLoadClassException: ... (Is a directory)`. It documents/expects a jar/zip. Zip
 * the scoped class tree into a temp jar just for CFR's benefit rather than changing what the
 * other two engines (which handle a directory fine) are given. */
export function zipDirectoryToJar(sourceDir: string, destJarPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const zipfile = new yazl.ZipFile();
    (function walk(dir: string, rel: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(full, relPath);
        else zipfile.addFile(full, relPath);
      }
    })(sourceDir, '');
    const writeStream = fs.createWriteStream(destJarPath);
    writeStream.on('close', resolve);
    writeStream.on('error', reject);
    zipfile.outputStream.pipe(writeStream);
    zipfile.end();
  });
}

/** jd-cli's `-ods` structured output nests everything under a top-level folder matching the
 * INPUT's own basename (confirmed live: given .../extracted as input, output lands at
 * outputDir/extracted/... instead of outputDir/... directly) — unlike CFR/Vineflower, which
 * both write straight into outputDir. Flatten it so downstream candidate scoring can treat all
 * engines' output trees uniformly. Tries every candidate basename (a directory input's exact
 * name; a jar input's name both with and without the .jar extension — unconfirmed which one
 * jd-cli actually nests under for jar input, so covering both is cheap and safe) — at most one
 * will ever exist, the rest are harmless no-ops. */
function flattenIfNested(outputDir: string, ...candidateBasenames: string[]): void {
  for (const basename of candidateBasenames) {
    const nested = path.join(outputDir, basename);
    if (!fs.existsSync(nested) || !fs.statSync(nested).isDirectory()) continue;
    for (const entry of fs.readdirSync(nested)) {
      fs.renameSync(path.join(nested, entry), path.join(outputDir, entry));
    }
    fs.rmdirSync(nested);
    return;
  }
}

export interface DecompileRunResult {
  engine: DecompilerEngine;
  ran: boolean;
  outputDir: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  error?: string;
  /** The exact `java ...` invocation, for surfacing in the job log — set even on failure/timeout
   * so a developer watching the dashboard can copy-paste and re-run it themselves. */
  command?: string;
  durationMs?: number;
}

/** Fired once, right before each subprocess is spawned, with the exact command line — callers
 * wire this to the job log / a "current activity" UI field so a developer watching the dashboard
 * can see what's actually running instead of just a generic per-stage message. */
export type CommandStartCallback = (line: string) => void;

function runJava(args: string[], timeoutMs: number): Promise<{ stdout: string; stderr: string; code: number | null; timedOut: boolean }> {
  return new Promise((resolve) => {
    const child = spawn('java', args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill();
    }, timeoutMs);

    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => {
      clearTimeout(timer);
      resolve({ stdout, stderr: err.message, code: -1, timedOut });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ stdout, stderr, code, timedOut });
    });
  });
}

async function runEngine(engine: DecompilerEngine, jarPath: string, classesDir: string, outputDir: string, workDir: string, onCommandStart?: CommandStartCallback): Promise<DecompileRunResult> {
  fs.mkdirSync(outputDir, { recursive: true });
  const timeoutMs = Config.decompilerTimeoutMs;

  let cfrInputJar: string | null = null;
  let input = classesDir;
  if (engine === 'cfr' || engine === 'procyon') {
    // Both CFR and Procyon require a jar/zip input rather than a bare directory of .class files.
    // Procyon's CLI (com.strobel.decompiler.DecompilerDriver) accepts a jar but not a directory.
    cfrInputJar = path.join(workDir, 'decompiled', `${engine}-input.jar`);
    await zipDirectoryToJar(classesDir, cfrInputJar);
    input = cfrInputJar;
  }

  let args: string[];
  switch (engine) {
    case 'cfr':
      args = ['-jar', jarPath, input, '--outputdir', outputDir];
      break;
    case 'vineflower':
      args = ['-jar', jarPath, input, outputDir];
      break;
    case 'jdcli':
      args = ['-jar', jarPath, '-ods', outputDir, input];
      break;
    case 'jadx':
      // NOT `-jar` — confirmed live: the fat jar's own manifest launches the Swing GUI by
      // default and crashes headless. The real bin/jadx launcher script explicitly runs
      // `-cp <jar> jadx.cli.JadxCLI`, so that's what gets replicated here.
      args = ['-cp', jarPath, 'jadx.cli.JadxCLI', '--no-res', '-ds', outputDir, input];
      break;
    case 'procyon':
      // Procyon CLI: `java -jar procyon-decompiler.jar -jar input.jar -o outputDir`
      // The -jar flag tells it to decompile a jar (not a single .class), -o sets output.
      args = ['-jar', jarPath, '-jar', input, '-o', outputDir];
      break;
  }

  const command = `java ${args.join(' ')}`;
  logger.info(`[${engine}] running: ${command}`);
  onCommandStart?.(`[${engine}] ${command}`);
  const startedAt = Date.now();
  const { stdout, stderr, code, timedOut } = await runJava(args, timeoutMs);
  const durationMs = Date.now() - startedAt;

  if (cfrInputJar) await fs.promises.unlink(cfrInputJar).catch(() => {});
  if (engine === 'jdcli') flattenIfNested(outputDir, path.basename(classesDir));

  return finishEngineResult(engine, outputDir, stdout, stderr, code, timedOut, timeoutMs, command, durationMs);
}

function finishEngineResult(
  engine: DecompilerEngine,
  outputDir: string,
  stdout: string,
  stderr: string,
  code: number | null,
  timedOut: boolean,
  timeoutMs: number,
  command: string,
  durationMs: number,
): DecompileRunResult {
  if (timedOut) {
    return { engine, ran: false, outputDir, stdout, stderr, exitCode: code, error: `Timed out after ${timeoutMs}ms`, command, durationMs };
  }
  // Non-zero exit doesn't necessarily mean total failure — these tools can exit non-zero
  // while still having emitted most of the tree. Only treat it as a hard failure if nothing
  // at all was written.
  const producedAnything = fs.existsSync(outputDir) && fs.readdirSync(outputDir).length > 0;
  if (!producedAnything) {
    return { engine, ran: false, outputDir, stdout, stderr, exitCode: code, error: `Produced no output (exit code ${code})`, command, durationMs };
  }
  if (code !== 0) {
    logger.warn(`[${engine}] exited ${code} but did produce output — keeping it, individual classes may still be broken (handled by scoring/verification).`);
  }
  return { engine, ran: true, outputDir, stdout, stderr, exitCode: code, command, durationMs };
}

/** Same per-engine invocation as runEngine(), but for a single already-built jar (an unresolved
 * dependency, not the app's own loose .class tree) — so CFR doesn't need the zip-from-directory
 * step, every engine just takes `inputJarPath` directly. Used by unresolvedLibDecompiler.ts to
 * run every available engine against a dependency jar and pick the best output per class, same
 * "run everything, score, pick a winner" approach Stage 3/4 already uses for the app's own
 * classes — confirmed live: JD-Core (jd-cli) produces genuinely compilable output on a
 * try/catch-reconstruction shape CFR 0.152 reliably mangles into 'catch' without 'try'/illegal-
 * start-of-expression syntax errors with no failure-marker comment CFR's own detection can catch. */
export async function runEngineAgainstJar(
  engine: DecompilerEngine,
  engineJarPath: string,
  inputJarPath: string,
  outputDir: string,
  timeoutMs: number,
  onCommandStart?: CommandStartCallback,
): Promise<DecompileRunResult> {
  fs.mkdirSync(outputDir, { recursive: true });

  let args: string[];
  switch (engine) {
    case 'cfr':
      args = ['-jar', engineJarPath, inputJarPath, '--outputdir', outputDir];
      break;
    case 'vineflower':
      args = ['-jar', engineJarPath, inputJarPath, outputDir];
      break;
    case 'jdcli':
      args = ['-jar', engineJarPath, '-ods', outputDir, inputJarPath];
      break;
    case 'jadx':
      args = ['-cp', engineJarPath, 'jadx.cli.JadxCLI', '--no-res', '-ds', outputDir, inputJarPath];
      break;
    case 'procyon':
      args = ['-jar', engineJarPath, '-jar', inputJarPath, '-o', outputDir];
      break;
  }

  const command = `java ${args.join(' ')}`;
  logger.info(`[${engine}] running against ${path.basename(inputJarPath)}: ${command}`);
  onCommandStart?.(`[${engine}] ${command}`);
  const startedAt = Date.now();
  const { stdout, stderr, code, timedOut } = await runJava(args, timeoutMs);
  const durationMs = Date.now() - startedAt;

  if (engine === 'jdcli') {
    flattenIfNested(outputDir, path.basename(inputJarPath), path.basename(inputJarPath, '.jar'));
  }

  return finishEngineResult(engine, outputDir, stdout, stderr, code, timedOut, timeoutMs, command, durationMs);
}

async function runOneOrSkip(
  engine: DecompilerEngine,
  engineJars: Record<DecompilerEngine, EngineStatus>,
  classesDir: string,
  workDir: string,
  onCommandStart?: CommandStartCallback,
): Promise<DecompileRunResult> {
  const status = engineJars[engine];
  const outputDir = path.join(workDir, 'decompiled', engine);
  if (!status?.installed || !status.jarPath) {
    logger.warn(`[${engine}] not installed — skipping.`);
    return { engine, ran: false, outputDir, stdout: '', stderr: '', exitCode: null, error: 'Engine jar not installed' };
  }
  try {
    return await runEngine(engine, status.jarPath, classesDir, outputDir, workDir, onCommandStart);
  } catch (err: any) {
    logger.error(`[${engine}] crashed: ${err.message}`);
    return { engine, ran: false, outputDir, stdout: '', stderr: '', exitCode: null, error: err.message };
  }
}

/** Which engines actually run is Config.enabledEngines (DECOMPILE_ENGINES) — dropping an engine
 * for speed skips it here entirely, not just at install time. Config.decompileParallel controls
 * whether the selected engines run one-after-another (default, lower peak memory) or all at
 * once (each is an independent child process writing to its own output dir, so this is safe —
 * just costs proportionally more RAM for the concurrent JVMs). */
export async function runAllDecompilers(
  classesDir: string,
  workDir: string,
  engineJars: Record<DecompilerEngine, EngineStatus>,
  onCommandStart?: CommandStartCallback,
): Promise<DecompileRunResult[]> {
  const engines = Config.enabledEngines;
  const results: DecompileRunResult[] = Config.decompileParallel
    ? await Promise.all(engines.map(engine => runOneOrSkip(engine, engineJars, classesDir, workDir, onCommandStart)))
    : await (async () => {
        const out: DecompileRunResult[] = [];
        for (const engine of engines) out.push(await runOneOrSkip(engine, engineJars, classesDir, workDir, onCommandStart));
        return out;
      })();

  if (results.every(r => !r.ran)) {
    throw new Error(`All ${engines.length} enabled decompiler engine(s) (${engines.join(', ')}) failed to produce any output — see per-engine errors in the job log.`);
  }

  return results;
}
