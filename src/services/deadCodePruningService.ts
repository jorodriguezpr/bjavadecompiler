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
 * BJavaDecompiler - last-resort remediation for a missing package that
 * sharedLibraryPackageSearchService.ts confirmed NO jar or previously-decompiled workspace
 * library anywhere supplies (e.g. `com.sun.jdmk.comm` — a Sun JVM extension from the Java 1.4 era
 * that was never redistributable and has no Maven Central artifact under any coordinate; a real
 * dependency simply doesn't exist to find). Left alone, a single such reference permanently blocks
 * `mvn compile` no matter how many build-fix attempts run.
 *
 * Confirmed real case: FhcIntfSolProj.war's bundled (and decompiled) log4j.jar includes its own
 * optional JMS-based remote-logging appender (`JMSAppender`/`JMSSink`) and JMX management console
 * agent (`jmx/Agent.java`, which needs `com.sun.jdmk.comm`) — neither is ever instantiated by the
 * actual application (nothing else in the whole decompiled project references either class), so
 * the fix isn't a dependency at all, it's recognizing these particular decompiled classes are dead
 * optional code this project never uses and excluding them from compilation, the same conclusion a
 * human reaches by checking "does anything actually call this" before deleting it.
 *
 * Opt-in (Config.pruneUnfixableDecompiledClasses, default off) since this is meaningfully more
 * aggressive than every other remediation step in this app — it moves source files (never the
 * app's own primary classes, only files inside a decompiled-and-inlined dependency's own
 * lib-src/<artifactId>/ tree) out of the compiled path entirely. Files are relocated to
 * data/workspaces/<jobId>/excluded-unfixable-classes/, never deleted, so the decision is always
 * inspectable and reversible.
 */

import fs from 'fs';
import path from 'path';
import { Logger } from '../core/logger';

const logger = Logger.getLogger('DeadCodePruning');

export interface PrunedFile {
  /** Path relative to the generated project root (e.g. lib-src/log4j/org/apache/log4j/jmx/Agent.java). */
  relativePath: string;
  reason: string;
}

/** `[12,34] package com.foo.bar does not exist` — same shape mavenVerifyService.ts's per-file
 * error strings always take, re-matched here rather than imported since this only needs the
 * package name, not the full parsing machinery. */
const PACKAGE_NOT_EXIST_RE = /^\[\d+,\d+\]\s*package ([\w.]+) does not exist/;

/**
 * Scans `errorsByFile` for "package X does not exist" errors naming a package already confirmed
 * unresolvable everywhere (`notFoundPackages`), restricted to files under `projectDir/lib-src/`
 * (a decompiled-and-inlined dependency's own best-effort reconstruction — the app's own
 * `src/main/java` is never a candidate). For each such file, checks whether ANY other `.java` file
 * anywhere in the project (`src/main/java` + every other `lib-src/` module) still mentions that
 * file's own simple class name; only when nothing does is the file relocated out of the compiled
 * path. Deliberately conservative: a same-named class existing anywhere else in the project is
 * treated as "still referenced" even if it's actually unrelated, since the cost of wrongly leaving
 * a genuinely-dead file in place (one still-broken compile error) is far lower than the cost of
 * wrongly pruning a file something else actually needed.
 */
export function pruneUnfixableFiles(
  projectDir: string,
  workspaceDir: string,
  notFoundPackages: Set<string>,
  errorsByFile: Record<string, string[]>,
): PrunedFile[] {
  const pruned: PrunedFile[] = [];
  const libSrcRoot = path.join(projectDir, 'lib-src') + path.sep;
  if (notFoundPackages.size === 0) return pruned;

  const packagesByFile = new Map<string, Set<string>>();
  for (const [file, errors] of Object.entries(errorsByFile)) {
    if (!file.startsWith(libSrcRoot)) continue; // never touch the app's own src/main/java
    for (const err of errors) {
      const m = err.match(PACKAGE_NOT_EXIST_RE);
      if (m && notFoundPackages.has(m[1])) {
        if (!packagesByFile.has(file)) packagesByFile.set(file, new Set());
        packagesByFile.get(file)!.add(m[1]);
      }
    }
  }
  if (!packagesByFile.size) return pruned;

  // Every .java file in the project (src/main/java + all of lib-src together) — walking
  // projectDir once covers both, since lib-src lives directly under it.
  const allJavaFiles: string[] = [];
  (function walk(dir: string) {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith('.java')) allJavaFiles.push(full);
    }
  })(projectDir);

  for (const [file, pkgs] of packagesByFile) {
    const simpleName = path.basename(file, '.java');
    const referencedElsewhere = allJavaFiles.some(other => {
      if (other === file) return false;
      let content: string;
      try {
        content = fs.readFileSync(other, 'utf8');
      } catch {
        return false;
      }
      return new RegExp(`\\b${simpleName}\\b`).test(content);
    });
    if (referencedElsewhere) {
      logger.info(`${path.relative(projectDir, file)} references unresolvable package(s) (${[...pkgs].join(', ')}) but is still referenced elsewhere in the project — leaving it in place rather than pruning.`);
      continue;
    }

    const relFromProject = path.relative(projectDir, file);
    const destPath = path.join(workspaceDir, 'excluded-unfixable-classes', relFromProject);
    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.renameSync(file, destPath);
      const reason = `references a package no jar or previously-decompiled library supplies (${[...pkgs].join(', ')}), and nothing else in the project references this class`;
      pruned.push({ relativePath: relFromProject, reason });
      logger.info(`Pruned ${relFromProject}: ${reason}. Moved to workspace excluded-unfixable-classes/ (not deleted).`);
    } catch (err: any) {
      logger.warn(`Could not prune ${relFromProject}: ${err.message}`);
    }
  }

  return pruned;
}
