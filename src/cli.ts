#!/usr/bin/env node
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
 * BJavaDecompiler CLI — same pipeline as the web UI, driven from the command line.
 * Usage: bjavadecompiler <file.war|file.jar>
 */

import 'dotenv/config'; // must run before anything reads Config/process.env
import path from 'path';
import fs from 'fs';
import { Config } from './config/config';
import { Logger } from './core/logger';
import { checkToolchain } from './core/toolchainCheck';
import { JobStore } from './services/jobStore';
import { DecompileJobService } from './services/decompileJobService';
import { JobStatus } from './models/job';
import { verifyBuild } from './services/mavenVerifyService';
import { remediateDeterministically } from './services/deterministicRemediationService';
import { remediate as remediateWithAi } from './services/aiRemediationService';
import { AIProvider } from './core/aiProvider';

const logger = Logger.getLogger('CLI');

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const TERMINAL: JobStatus[] = ['completed', 'completed_with_errors', 'failed', 'cancelled'];

/** `--java=8` (or 11/17/21/...) anywhere after the input path — overrides the bytecode-detected
 * Java release for this one job, same as the web UI's per-upload Target Java Version selector
 * (see routes/api/jobs.ts). Deliberately not positional (argv[2]/[3] stay the file path /
 * fix-project's dir) so it can be added or dropped without disturbing existing invocations. */
function parseJavaVersionFlag(argv: string[]): number | null {
  for (const arg of argv) {
    const m = /^--java=(\d+)$/.exec(arg);
    if (m) return parseInt(m[1], 10);
  }
  return null;
}

/** Every .java file under `root`, as a `pkg.pkg.ClassName` FQCN derived from its path relative to
 * `root` — used to seed remediateDeterministically()'s "known types" set the same way a real
 * job's job.classes does, since a standalone project has no job to read that list from. */
function collectJavaFqcns(root: string): string[] {
  const fqcns: string[] = [];
  if (!fs.existsSync(root)) return fqcns;
  (function walk(dir: string, relSegments: string[]) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full, [...relSegments, entry.name]);
      } else if (entry.name.endsWith('.java')) {
        fqcns.push([...relSegments, entry.name.replace(/\.java$/, '')].join('/'));
      }
    }
  })(root, []);
  return fqcns;
}

/**
 * `fix-project <projectDir>` — runs the SAME deterministic + AI remediation loop
 * decompileJobService.ts's build-fix stage uses, directly against an already-generated Maven
 * project that isn't (or is no longer) tracked as a job — e.g. a project exported before a later
 * BJavaDecompiler version's fixes existed, or one that just needs another remediation pass without
 * re-running decompilation from scratch. Confirmed real case: a project exported before the
 * missing-package-search/dead-code-pruning features existed still had real dependency gaps fixed
 * by hand; once those were resolved, thousands of leftover `incompatible types: Object cannot be
 * converted` decompiler-artifact errors remained — exactly what this loop exists to chew through
 * without requiring a full re-decompile.
 *
 * Known, honest limitation vs. the real pipeline: there's no tracked DependencyResolution[] for an
 * arbitrary project (no job to read it from), so remediateDeterministically() runs with an empty
 * dependency list — the app-class-FQCN half of its "known types" set (derived here straight from
 * src/main/java + lib-src) still works fully; only the "is this simple name one of my resolved
 * dependencies' own classes" half is unavailable.
 */
async function fixProject(projectDir: string) {
  if (!projectDir) {
    console.error('Usage: bjavadecompiler fix-project <projectDir>');
    process.exit(1);
  }
  const absProjectDir = path.resolve(projectDir);
  if (!fs.existsSync(path.join(absProjectDir, 'pom.xml'))) {
    console.error(`No pom.xml found under ${absProjectDir} — is this a generated Maven project?`);
    process.exit(1);
  }

  const toolchain = await checkToolchain();
  if (!toolchain.ready) {
    console.error('JDK 17+ and/or Maven were not detected on PATH — cannot proceed.');
    console.error(JSON.stringify(toolchain, null, 2));
    process.exit(1);
  }

  const appClassFqcns = [
    ...collectJavaFqcns(path.join(absProjectDir, 'src', 'main', 'java')),
    ...collectJavaFqcns(path.join(absProjectDir, 'lib-src')),
  ];
  console.log(`Indexed ${appClassFqcns.length} .java file(s) under src/main/java and lib-src for known-type resolution.`);

  const onCommandStart = (line: string) => console.log(`  $ ${line}`);
  let build = await verifyBuild(absProjectDir, onCommandStart);
  console.log(`Attempt 1: ${build.success ? 'SUCCESS' : `${build.errorCount} error(s)`}`);

  const aiAvailable = Config.aiEnabled && AIProvider.isConfigured();
  const aiTouchedFiles = new Set<string>();
  let attempt = 1;
  while (!build.success && attempt < Config.maxBuildFixAttempts) {
    const errorCountAtStart = build.errorCount;

    const detOutcome = await remediateDeterministically(build, [], appClassFqcns, absProjectDir);
    if (detOutcome.fixed.length || detOutcome.partiallyFixed.length) {
      console.log(`Deterministic remediation: ${detOutcome.fixed.length} fixed, ${detOutcome.partiallyFixed.length} partially fixed, ${detOutcome.unfixed.length} unfixed.`);
      build = await verifyBuild(absProjectDir, onCommandStart);
      attempt++;
      console.log(`Attempt ${attempt}: ${build.success ? 'SUCCESS' : `${build.errorCount} error(s)`}`);
      if (build.success) break;
    }

    if (aiAvailable) {
      const aiOutcome = await remediateWithAi(build, aiTouchedFiles, undefined, absProjectDir);
      console.log(`AI remediation: ${aiOutcome.fixed.length} fixed, ${aiOutcome.likelyDependencyIssue.length} flagged as dependency issues, ${aiOutcome.unfixed.length} unfixed.`);
      build = await verifyBuild(absProjectDir, onCommandStart);
      attempt++;
      console.log(`Attempt ${attempt}: ${build.success ? 'SUCCESS' : `${build.errorCount} error(s)`}`);
      if (build.success) break;
    } else if (!detOutcome.fixed.length && !detOutcome.partiallyFixed.length) {
      // Neither deterministic nor AI remediation is available/applicable this round — no other
      // fixer left to try, and looping again would just re-verify the identical unchanged project.
      console.log('No AI provider configured and deterministic remediation made no changes this round — stopping.');
      break;
    }

    if (build.errorCount >= errorCountAtStart) {
      console.log(`No net progress this attempt (${errorCountAtStart} -> ${build.errorCount} errors) — stopping instead of burning the rest of the attempt budget.`);
      break;
    }
  }

  console.log('');
  console.log(`Final: ${build.success ? 'SUCCESS' : `${build.errorCount} error(s) remaining`} after ${attempt} attempt(s).`);
  if (!build.success) {
    const files = Object.keys(build.errorsByFile);
    console.log(`${files.length} file(s) still have errors. First few:`);
    for (const f of files.slice(0, 10)) console.log(`  ${f}`);
  }
  process.exit(build.success ? 0 : 1);
}

async function main() {
  if (process.argv[2] === 'fix-project') {
    await fixProject(process.argv[3]);
    return;
  }

  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: bjavadecompiler <file.war|file.jar> [--java=8|11|17|21]');
    console.error('       bjavadecompiler fix-project <projectDir>');
    process.exit(1);
  }
  if (!fs.existsSync(inputPath)) {
    console.error(`File not found: ${inputPath}`);
    process.exit(1);
  }
  if (!/\.(war|jar)$/i.test(inputPath)) {
    console.error('Input must be a .war or .jar file.');
    process.exit(1);
  }

  JobStore.loadAll();

  const toolchain = await checkToolchain();
  if (!toolchain.ready) {
    console.error('JDK 17+ and/or Maven were not detected on PATH — cannot proceed.');
    console.error(JSON.stringify(toolchain, null, 2));
    process.exit(1);
  }

  const targetJavaVersion = parseJavaVersionFlag(process.argv.slice(3));
  const originalFilename = path.basename(inputPath);
  console.log(`Starting job for ${originalFilename}...${targetJavaVersion ? ` (targeting Java ${targetJavaVersion})` : ''}`);
  const job = await DecompileJobService.startJob(inputPath, originalFilename, { targetJavaVersion });
  console.log(`Job ${job.id} started.`);

  let lastStatus = '';
  while (true) {
    const current = DecompileJobService.get(job.id);
    if (!current) break;
    if (current.status !== lastStatus) {
      console.log(`[${current.status}]`);
      lastStatus = current.status;
    }
    if (TERMINAL.includes(current.status)) {
      console.log('');
      console.log(`Final status: ${current.status}`);
      if (current.errorMessage) console.log(`Error: ${current.errorMessage}`);
      if (current.generatedProjectDir) {
        const projectDir = path.join(Config.workspacesPath, current.workspaceDir, current.generatedProjectDir);
        console.log(`Generated project: ${projectDir}`);
      }
      process.exit(current.status === 'failed' ? 1 : 0);
    }
    await sleep(2000);
  }
}

main().catch(err => {
  logger.error(`CLI failed: ${err.message}`, { stack: err.stack });
  process.exit(1);
});
