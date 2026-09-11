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
 * BJavaDecompiler - Stage 1: extraction.
 *
 * Unzips the WAR/JAR and scopes what actually needs decompiling to the application's OWN
 * classes only. Layout is detected from the archive's internal structure, not just its file
 * extension — a `.jar` can be a Spring Boot executable fat jar (BOOT-INF/classes +
 * BOOT-INF/lib), which is a genuinely different internal shape from a plain library jar (flat
 * .class tree at the root) even though both end in `.jar`. Confirmed live this matters: without
 * this check, a Spring Boot fat jar's BOOT-INF/lib/*.jar dependencies never get resolved as
 * real Maven <dependency> entries at all — they'd just sit as inert non-.class blobs under
 * src/main/resources, and BOOT-INF/classes' actual app code would go undecompiled entirely
 * (the tool would try to decompile the jar's root, which for a fat jar holds none of the real
 * app .class files, only the Spring Boot loader's own bootstrap classes).
 *
 * WEB-INF/lib/*.jar (traditional WAR) and BOOT-INF/lib/*.jar (Spring Boot fat jar) are both
 * never decompiled directly; they become real Maven <dependency> entries via
 * dependencyResolutionService.ts instead. This is the single decision that keeps the generated
 * project looking like a normal Maven project instead of a pile of vendored third-party source.
 */

import fs from 'fs';
import path from 'path';
import AdmZip from 'adm-zip';
import { Logger } from '../core/logger';
import { ApiError } from '../core/apiError';

const logger = Logger.getLogger('ExtractionService');

export interface ExtractionResult {
  inputType: 'war' | 'jar';
  extractedDir: string;
  /** Absolute path to the directory tree of .class files that should be decompiled. */
  classesDir: string;
  /** WEB-INF/lib/*.jar or BOOT-INF/lib/*.jar absolute paths — resolved to Maven deps, never decompiled. */
  libJars: string[];
  /** Non-class resources sitting alongside classes (WEB-INF/classes or BOOT-INF/classes for a
   * WAR/fat-jar, jar root otherwise) — copied into src/main/resources. For a Spring Boot fat
   * jar this correctly captures BOOT-INF/classes/static and /templates too, since those live
   * inside classesDir already — no separate handling needed. */
  resourceFiles: string[];
  /** Everything else under the WAR root (JSPs, static assets, WEB-INF/web.xml, etc.) — copied
   * as-is into src/main/webapp. Empty for a plain JAR or a Spring Boot fat jar (neither has an
   * equivalent "webapp root" — everything meaningful is already classesDir or libDir). */
  webappFiles: string[];
  hasEmptyClasses: boolean;
  warnings: string[];
  /** Detected purely from the archive's internal layout (BOOT-INF vs WEB-INF vs flat), not by
   * scanning class content — the layout alone is unambiguous. Drives pom.xml plugin selection
   * (spring-boot-maven-plugin vs maven-war-plugin) and gets surfaced in BJAVADECOMPILER-NOTES.md. */
  appType: 'spring-boot' | 'java-ee' | 'plain-jar';
}

function walk(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...walk(full));
    else out.push(full);
  }
  return out;
}

export function extract(inputFilePath: string, originalFilename: string, workspaceDir: string): ExtractionResult {
  const extractedDir = path.join(workspaceDir, 'extracted');
  fs.mkdirSync(extractedDir, { recursive: true });

  const warnings: string[] = [];

  let zip: AdmZip;
  try {
    zip = new AdmZip(inputFilePath);
  } catch (err: any) {
    // Corrupt/unreadable archive — nothing downstream can self-heal this, fail fast.
    throw ApiError.badRequest(`Could not read "${originalFilename}" as a zip archive: ${err.message}`);
  }

  const entries = zip.getEntries();

  // Multi-release jars carry duplicate class entries under META-INF/versions/<N>/ — keep only
  // the base version for decompilation; the versioned overrides are an edge case v1 doesn't
  // attempt to reconcile.
  for (const entry of entries) {
    if (entry.entryName.startsWith('META-INF/versions/')) continue;
    // Signature files are meaningless once decompiled/repackaged — drop them, but not the
    // whole META-INF, so MANIFEST.MF (used for groupId/version hints) survives.
    if (/^META-INF\/[^/]+\.(SF|RSA|DSA)$/i.test(entry.entryName)) {
      warnings.push(`Dropped signature file ${entry.entryName} (meaningless post-decompile).`);
      continue;
    }
    const dest = path.join(extractedDir, entry.entryName);
    if (entry.isDirectory) {
      fs.mkdirSync(dest, { recursive: true });
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, entry.getData());
  }

  const isWar = fs.existsSync(path.join(extractedDir, 'WEB-INF'));
  const isSpringBootFatJar = fs.existsSync(path.join(extractedDir, 'BOOT-INF'));
  const inputType: 'war' | 'jar' = isWar ? 'war' : 'jar';

  let appType: 'spring-boot' | 'java-ee' | 'plain-jar';
  let classesDir: string;
  let libDir: string | null;
  if (isSpringBootFatJar) {
    appType = 'spring-boot';
    classesDir = path.join(extractedDir, 'BOOT-INF', 'classes');
    libDir = path.join(extractedDir, 'BOOT-INF', 'lib');
  } else if (isWar) {
    appType = 'java-ee';
    classesDir = path.join(extractedDir, 'WEB-INF', 'classes');
    libDir = path.join(extractedDir, 'WEB-INF', 'lib');
  } else {
    appType = 'plain-jar';
    classesDir = extractedDir;
    libDir = null;
  }

  const hasEmptyClasses = !fs.existsSync(classesDir) ||
    walk(classesDir).filter(f => f.endsWith('.class')).length === 0;
  if (hasEmptyClasses) {
    warnings.push(appType === 'java-ee'
      ? 'WEB-INF/classes has no .class files — this looks like a pure JSP/static-content WAR. Skipping decompilation, still generating a project.'
      : appType === 'spring-boot'
        ? 'BOOT-INF/classes has no .class files.'
        : 'This jar has no .class files at all.');
  }

  const libJars = libDir && fs.existsSync(libDir)
    ? walk(libDir).filter(f => f.endsWith('.jar'))
    : [];

  const resourceFiles = fs.existsSync(classesDir)
    ? walk(classesDir).filter(f => !f.endsWith('.class'))
    : [];

  // Only a traditional WAR has a meaningful "webapp root" to preserve (JSPs, static assets,
  // WEB-INF/web.xml) — a Spring Boot fat jar's equivalent content (static/, templates/) already
  // lives inside BOOT-INF/classes and is captured by resourceFiles above; its other BOOT-INF
  // siblings (classpath.idx, layers.idx) are Spring Boot loader bookkeeping, not source.
  let webappFiles: string[] = [];
  if (isWar) {
    webappFiles = walk(extractedDir).filter(f => {
      const rel = path.relative(extractedDir, f);
      if (rel.startsWith(`WEB-INF${path.sep}classes`)) return false;
      if (rel.startsWith(`WEB-INF${path.sep}lib`)) return false;
      return true;
    });
  }

  logger.info(`Extracted ${originalFilename} as ${inputType} (${appType}): ${walk(classesDir).filter(f => f.endsWith('.class')).length} class files, ${libJars.length} lib jars, ${webappFiles.length} webapp files.`);

  return { inputType, extractedDir, classesDir, libJars, resourceFiles, webappFiles, hasEmptyClasses, warnings, appType };
}
