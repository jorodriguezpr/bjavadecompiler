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
 * BJavaDecompiler - Stage 6: NetBeans Maven project generation.
 *
 * Writes the standard Maven directory layout NetBeans imports natively (no nbproject/
 * scaffolding needed — a valid pom.xml is the entire requirement):
 *   pom.xml (packaging=war or jar)
 *   src/main/java/<packages>/*.java       (AI-reconstructed / decompiler-winner sources)
 *   src/main/resources/                   (non-class resources found alongside classes)
 *   src/main/webapp/                      (WAR only — JSPs, static assets, WEB-INF/web.xml,
 *                                           copied as-is, never decompiled or AI-touched)
 * Also emits BJAVADECOMPILER-NOTES.md — every unresolved/guessed dependency, AI-fallback
 * class, and low-confidence call, because this tool must stay honest about what it couldn't
 * do cleanly rather than silently produce something that only looks complete.
 */

import fs from 'fs';
import path from 'path';
import { ClassCandidate, DependencyResolution, MissingPackageEntry, ExcludedUnfixableFile } from '../models/job';
import { writeNetBeansConfig, detectMainClass } from './netbeansConfigService';
import { isProvided } from './dependencyResolutionService';

/** class file major version -> Java release, per the JVM spec's constant pool table. */
const BYTECODE_VERSION_TABLE: Record<number, number> = {
  49: 5, 50: 6, 51: 7, 52: 8, 53: 9, 54: 10, 55: 11, 56: 12,
  57: 13, 58: 14, 59: 15, 60: 16, 61: 17, 62: 18, 63: 19, 64: 20, 65: 21, 66: 22,
};

export function detectJavaVersionFromClassFile(classFilePath: string): number | null {
  const buf = fs.readFileSync(classFilePath);
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0xcafebabe) return null;
  const major = buf.readUInt16BE(6);
  return BYTECODE_VERSION_TABLE[major] || null;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
export { xmlEscape };

export function deriveGroupArtifact(originalFilename: string, rootPackage: string | null, manifestVendorId: string | null): { groupId: string; artifactId: string } {
  const artifactId = originalFilename.replace(/\.(war|jar)$/i, '').replace(/[^a-zA-Z0-9._-]/g, '-').toLowerCase();
  let groupId = manifestVendorId?.trim() || null;
  if (!groupId && rootPackage) {
    // reverse-DNS style package -> a reasonable groupId guess (e.g. com/example/app -> com.example)
    const parts = rootPackage.split('/').filter(Boolean);
    groupId = parts.slice(0, Math.min(2, parts.length)).join('.');
  }
  if (!groupId) groupId = 'com.bjavadecompiler.generated';
  return { groupId, artifactId };
}

function buildPomXml(opts: {
  groupId: string;
  artifactId: string;
  packaging: 'war' | 'jar';
  appType: 'spring-boot' | 'java-ee' | 'plain-jar';
  javaVersion: number;
  dependencies: DependencyResolution[];
  transitiveExclusions: { groupId: string; artifactId: string }[];
  mainClass?: string | null;
}): string {
  // A broken TRANSITIVE dependency (pulled in by something else, not one of the WAR's own
  // jars — no original jar to decompile) gets excluded from every top-level <dependency>
  // instead. Blunt (repeated on each dependency rather than targeted at whichever one actually
  // pulls it in, since that's not tracked), but safe: Maven ignores an exclusion that wasn't
  // actually going to be pulled in by a given dependency anyway.
  const exclusionsXml = opts.transitiveExclusions.length ? `
      <exclusions>
${opts.transitiveExclusions.map(e => `        <exclusion>
          <groupId>${xmlEscape(e.groupId)}</groupId>
          <artifactId>${xmlEscape(e.artifactId)}</artifactId>
        </exclusion>`).join('\n')}
      </exclusions>` : '';

  // Three buckets: real coordinates -> normal <dependency>; unresolved-but-decompiled -> no
  // <dependency> at all, its source is compiled directly into the project instead (see the
  // build-helper-maven-plugin block below); unresolved-and-not-decompiled (CFR unavailable or
  // failed on it) -> the original placeholder-install-file fallback.
  const deps = opts.dependencies
    .filter(d => d.confidence !== 'unresolved')
    .map(d => `    <dependency>
      <groupId>${xmlEscape(d.groupId!)}</groupId>
      <artifactId>${xmlEscape(d.artifactId!)}</artifactId>
      <version>${xmlEscape(d.version!)}</version>${d.classifier ? `\n      <classifier>${xmlEscape(d.classifier)}</classifier>` : ''}${d.scope !== 'compile' ? `\n      <scope>${d.scope}</scope>` : ''}${exclusionsXml}
    </dependency>`)
    .join('\n');

  // java-ee webapps compile against the servlet API, but it's almost never bundled in
  // WEB-INF/lib (a servlet container provides it at runtime, and bundling your own copy is a
  // classpath-conflict foot-gun most projects deliberately avoid) — confirmed live: a real WAR
  // with `javax.servlet`/`javax.servlet.http` imports throughout had ZERO matching dependency
  // after resolution, since there was genuinely no servlet-api jar in WEB-INF/lib to find.
  // Synthesize the standard `provided` dependency unless something already resolved to one (an
  // unusual case, but isProvided() is the same check dependencyResolutionService.ts itself uses
  // to mark a bundled servlet-api jar `provided` instead of `compile`).
  const hasServletApi = opts.dependencies.some(d => d.groupId && d.artifactId && isProvided(d.groupId, d.artifactId));
  const servletApiDep = opts.appType === 'java-ee' && !hasServletApi ? `    <dependency>
      <groupId>javax.servlet</groupId>
      <artifactId>javax.servlet-api</artifactId>
      <version>4.0.1</version>
      <scope>provided</scope>
      <!-- Not bundled in WEB-INF/lib (container-provided APIs almost never are) — added
           automatically because this is a java-ee webapp referencing javax.servlet.*. -->
    </dependency>` : '';

  const unresolvedNotDecompiled = opts.dependencies.filter(d => d.confidence === 'unresolved' && !d.decompiledSourceDir);
  const unresolvedDeps = unresolvedNotDecompiled
    .map(d => `    <dependency>
      <groupId>${xmlEscape(d.groupId!)}</groupId>
      <artifactId>${xmlEscape(d.artifactId!)}</artifactId>
      <version>${xmlEscape(d.version!)}</version>
      <!-- Could not identify this jar's real Maven coordinates (see BJAVADECOMPILER-NOTES.md).
           Install it locally first: mvn install:install-file -Dfile=<original-jar>
           -DgroupId=${xmlEscape(d.groupId!)} -DartifactId=${xmlEscape(d.artifactId!)} -Dversion=${xmlEscape(d.version!)} -Dpackaging=jar -->
    </dependency>`)
    .join('\n');

  const decompiledLibs = opts.dependencies.filter(d => d.confidence === 'unresolved' && d.decompiledSourceDir);
  const addSourcePlugin = decompiledLibs.length ? `
      <plugin>
        <groupId>org.codehaus.mojo</groupId>
        <artifactId>build-helper-maven-plugin</artifactId>
        <version>3.6.0</version>
        <executions>
          <execution>
            <id>add-decompiled-lib-sources</id>
            <phase>generate-sources</phase>
            <goals><goal>add-source</goal></goals>
            <configuration>
              <sources>
${decompiledLibs.map(d => `                <source>\${basedir}/lib-src/${xmlEscape(d.artifactId!)}</source>`).join('\n')}
              </sources>
            </configuration>
          </execution>
        </executions>
      </plugin>` : '';

  const warPlugin = opts.packaging === 'war' ? `
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-war-plugin</artifactId>
        <version>3.4.0</version>
        <configuration>
          <warSourceDirectory>src/main/webapp</warSourceDirectory>
          <failOnMissingWebXml>false</failOnMissingWebXml>
        </configuration>
      </plugin>` : '';

  // Version pulled from whatever org.springframework.boot coordinate actually got resolved as a
  // real dependency (highest confidence — matches what this specific app was really built
  // against) rather than guessing a recent default that could easily be a major version off.
  const springBootVersion = opts.dependencies.find(d => d.groupId === 'org.springframework.boot')?.version;
  const springBootPlugin = opts.appType === 'spring-boot' ? `
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>${springBootVersion ? `
        <version>${xmlEscape(springBootVersion)}</version>` : `
        <!-- No org.springframework.boot:* dependency resolved to a real version — set this to
             match the Spring Boot version this app actually used before repackaging. -->`}
      </plugin>` : '';

  // Plain-jar exec support: enables nbactions.xml's run action (exec:java) without any manual
  // configuration. mainClass is detected from a unique `public static void main` in the
  // decompiled sources — null (plugin omitted) when zero or multiple candidates exist.
  const mainClass = opts.mainClass || null;
  const execPlugin = opts.appType === 'plain-jar' && mainClass ? `
      <plugin>
        <groupId>org.codehaus.mojo</groupId>
        <artifactId>exec-maven-plugin</artifactId>
        <version>3.2.0</version>
        <configuration>
          <mainClass>${xmlEscape(mainClass)}</mainClass>
        </configuration>
      </plugin>` : '';

  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://maven.apache.org/POM/4.0.0"
         xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"
         xsi:schemaLocation="http://maven.apache.org/POM/4.0.0 http://maven.apache.org/xsd/maven-4.0.0.xsd">
  <modelVersion>4.0.0</modelVersion>

  <groupId>${xmlEscape(opts.groupId)}</groupId>
  <artifactId>${xmlEscape(opts.artifactId)}</artifactId>
  <version>1.0.0</version>
  <packaging>${opts.packaging}</packaging>

  <properties>
    <maven.compiler.source>${opts.javaVersion}</maven.compiler.source>
    <maven.compiler.target>${opts.javaVersion}</maven.compiler.target>
    <project.build.sourceEncoding>UTF-8</project.build.sourceEncoding>
  </properties>

  <dependencies>
${[deps, servletApiDep, unresolvedDeps].filter(Boolean).join('\n')}
  </dependencies>

  <build>
    <finalName>${xmlEscape(opts.artifactId)}</finalName>
    <plugins>
      <plugin>
        <groupId>org.apache.maven.plugins</groupId>
        <artifactId>maven-compiler-plugin</artifactId>
        <configuration>
          <source>${opts.javaVersion}</source>
          <target>${opts.javaVersion}</target>
          <!-- javac's own default (-Xmaxerrs 100) silently truncates error reporting on a large
               decompiled project — confirmed real case: 16 decompiled unresolved libraries full of
               ordinary decompiler-artifact syntax errors (e.g. "illegal start of expression") ate
               every one of the first 100 error slots on every single build-fix attempt, so a real,
               fixable error in the app's OWN code (further along in compile order) never appeared
               in errorsByFile at all, for any attempt, and neither remediateDeterministically.ts
               nor the AI remediation pass ever got a chance to see or fix it. Raised well above
               anything a real project should ever hit. -->
          <compilerArgs>
            <arg>-Xmaxerrs</arg>
            <arg>10000</arg>
          </compilerArgs>
        </configuration>
      </plugin>${addSourcePlugin}${warPlugin}${springBootPlugin}${execPlugin}
    </plugins>
  </build>
</project>
`;
}

function copyTree(files: string[], srcRoot: string, destRoot: string): void {
  for (const file of files) {
    const rel = path.relative(srcRoot, file);
    const dest = path.join(destRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(file, dest);
  }
}

export interface ProjectGenerationInput {
  projectDir: string;
  /** Absolute path to the job's workspace root — decompiledSourceDir on a dependency is
   * relative to this, not to projectDir. */
  workspaceDir: string;
  groupId: string;
  artifactId: string;
  packaging: 'war' | 'jar';
  appType: 'spring-boot' | 'java-ee' | 'plain-jar';
  javaVersion: number;
  dependencies: DependencyResolution[];
  transitiveExclusions: { groupId: string; artifactId: string }[];
  /** Packages `mvn compile` reported as entirely missing during this job's build-fix loop — see
   * sharedLibraryPackageSearchService.ts. Optional so callers/tests that predate this field don't
   * need updating; treated as empty when absent. */
  missingPackages?: MissingPackageEntry[];
  /** Decompiled dependency source files pruned by deadCodePruningService.ts. Optional for the
   * same reason as missingPackages above. */
  excludedUnfixableFiles?: ExcludedUnfixableFile[];
  reconstructedSourcesDir: string; // flat tree of <fqcn>.java already written by aiReconstructionService
  resourceFiles: string[];
  resourceFilesRoot: string;
  webappFiles: string[];
  webappFilesRoot: string;
  classes: ClassCandidate[];
  hasEmptyClasses: boolean;
  extractionWarnings: string[];
  /** Frameworks detected by frameworkDetectionService.ts — surfaced in NOTES.md and used to
   * generate the right nbactions.xml (e.g. spring-boot:run for Spring Boot). */
  detectedFrameworks?: { id: string; label: string; confidence: string; evidence: string }[];
  detectedPrimaryFramework?: string | null;
}

export function generateProject(input: ProjectGenerationInput): void {
  const { projectDir } = input;
  fs.mkdirSync(projectDir, { recursive: true });

  fs.writeFileSync(path.join(projectDir, 'pom.xml'), buildPomXml(input), 'utf8');

  // NetBeans integration: nbactions.xml (Build/Run/Debug wiring) + nbproject/project.xml.
  // Best-effort — written after pom.xml so a valid Maven project always exists first.
  const detectedMainClass = detectMainClass(input.reconstructedSourcesDir);
  writeNetBeansConfig({
    projectDir,
    artifactId: input.artifactId,
    packaging: input.packaging,
    appType: input.appType,
    primaryFramework: input.detectedPrimaryFramework || null,
    mainClass: detectedMainClass,
  });

  // Rebuild pom.xml with the detected main class so the exec-maven-plugin block lands in it.
  // (First write above keeps the project valid even if detection is slow/no-op.)
  if (detectedMainClass && input.appType === 'plain-jar') {
    fs.writeFileSync(path.join(projectDir, 'pom.xml'), buildPomXml({ ...input, mainClass: detectedMainClass }), 'utf8');
  }

  const javaDir = path.join(projectDir, 'src', 'main', 'java');
  fs.mkdirSync(javaDir, { recursive: true });
  if (fs.existsSync(input.reconstructedSourcesDir)) {
    const sourceFiles: string[] = [];
    (function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.java')) sourceFiles.push(full);
      }
    })(input.reconstructedSourcesDir);
    copyTree(sourceFiles, input.reconstructedSourcesDir, javaDir);
  }

  if (input.resourceFiles.length) {
    copyTree(input.resourceFiles, input.resourceFilesRoot, path.join(projectDir, 'src', 'main', 'resources'));
  }

  if (input.packaging === 'war' && input.webappFiles.length) {
    copyTree(input.webappFiles, input.webappFilesRoot, path.join(projectDir, 'src', 'main', 'webapp'));
  }

  // Unresolved dependencies CFR was able to decompile — real source compiled directly into
  // the project (via build-helper-maven-plugin in the pom, added above) instead of staying an
  // opaque binary placeholder. Kept in their own lib-src/<artifactId>/ subtree, not merged into
  // src/main/java, so a class-name collision between two independent libraries (or with the
  // app's own code) stays attributable to a specific jar rather than silently overwriting files.
  for (const dep of input.dependencies) {
    if (dep.confidence !== 'unresolved' || !dep.decompiledSourceDir) continue;
    const srcDir = path.join(input.workspaceDir, dep.decompiledSourceDir);
    if (!fs.existsSync(srcDir)) continue;
    const destDir = path.join(projectDir, 'lib-src', dep.artifactId!);
    const files: string[] = [];
    (function walk(dir: string) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.java')) files.push(full);
      }
    })(srcDir);
    copyTree(files, srcDir, destDir);
  }

  fs.writeFileSync(path.join(projectDir, 'BJAVADECOMPILER-NOTES.md'), buildNotes(input), 'utf8');
}

function buildNotes(input: ProjectGenerationInput): string {
  const lines: string[] = [
    `# BJavaDecompiler notes for ${input.artifactId}`,
    '',
    `Generated ${new Date().toISOString()}. This project was reconstructed from a compiled`,
    `${input.packaging.toUpperCase()} — read this file before assuming the output is 100% correct.`,
    '',
    `Detected Java bytecode version: ${input.javaVersion}`,
    `Detected application type: ${input.appType}${input.appType === 'spring-boot' ? ' (BOOT-INF/classes + BOOT-INF/lib layout — spring-boot-maven-plugin added to pom.xml)' : input.appType === 'java-ee' ? ' (WEB-INF/classes + WEB-INF/lib layout)' : ''}`,
    '',
  ];

  // Detected frameworks section (see frameworkDetectionService.ts)
  if (input.detectedFrameworks?.length) {
    lines.push('## Detected frameworks and libraries', '');
    lines.push('Identified from the dependency coordinates and deployment descriptors. When opening',
      'this project in NetBeans, this tells you which project facets to expect and which runtime',
      'to attach: Spring Boot apps run via `spring-boot:run` (already wired in nbactions.xml);',
      'traditional WARs need a Servlet container (Tomcat/Payara/WildFly) configured in NetBeans',
      'under Tools → Servers.', '');
    for (const f of input.detectedFrameworks) {
      lines.push(`- **${f.label}** (${f.confidence}) — ${f.evidence}`);
    }
    lines.push('');
  }

  if (input.hasEmptyClasses) {
    lines.push('## No application classes found', '', 'This looks like a pure JSP/static-content package — nothing to decompile.', '');
  }

  if (input.extractionWarnings.length) {
    lines.push('## Extraction warnings', '');
    for (const w of input.extractionWarnings) lines.push(`- ${w}`);
    lines.push('');
  }

  if (input.transitiveExclusions.length) {
    lines.push(`## Transitive dependencies excluded (${input.transitiveExclusions.length})`, '');
    lines.push('These aren\'t among the WAR\'s own WEB-INF/lib jars — Maven pulled them in as a', 'dependency of one of the *other* dependencies, and they turned out not to actually resolve', '(dead/renamed coordinate). Excluded from every top-level dependency rather than the one', 'specific parent that needed it (not tracked). If `mvn compile` still fails on a missing', 'class from one of these, it means the excluded jar\'s classes genuinely aren\'t provided by', 'anything else in this project and need a real replacement dependency added by hand — check', 'whether one of the `lib-src/` decompiled libraries above was supposed to provide it (a', 'common case: the WAR\'s own copy of `mail.jar`/`activation.jar` implements the same', '`javax.mail`/`javax.activation` packages this transitive dependency would have).', '');
    for (const e of input.transitiveExclusions) lines.push(`- \`${e.groupId}:${e.artifactId}\``);
    lines.push('');
  }

  const decompiledLibs = input.dependencies.filter(d => d.confidence === 'unresolved' && d.decompiledSourceDir);
  const unresolved = input.dependencies.filter(d => d.confidence === 'unresolved' && !d.decompiledSourceDir);
  const guessed = input.dependencies.filter(d => d.confidence === 'guess');
  const autoMatched = input.dependencies.filter(d => d.confidence === 'auto-class-match');
  const providedApi = input.dependencies.filter(d => d.confidence === 'provided-api');
  if (decompiledLibs.length || unresolved.length || guessed.length || autoMatched.length || providedApi.length) {
    lines.push('## Dependency resolution issues', '');
    if (providedApi.length) {
      lines.push(`### Recognized as container-provided Java EE APIs (${providedApi.length}) — added scope=provided`, '');
      lines.push('These were never bundled in WEB-INF/lib because a Java EE container (GlassFish/WildFly/', 'WebSphere/etc.) supplies them at runtime — added as normal Maven Central dependencies with', '`<scope>provided</scope>` so the project still compiles standalone, without needing a real', 'application server on this machine.', '');
      for (const d of providedApi) lines.push(`- ${d.groupId}:${d.artifactId}:${d.version}${d.sharedLibrarySource ? ` (identified from your configured Java EE container library folder, jar \`${d.sharedLibrarySource}\`)` : ' (from the built-in provided-API catalog, no local install needed)'}`);
      lines.push('');
    }
    if (decompiledLibs.length) {
      lines.push(`### Decompiled and compiled directly into this project (${decompiledLibs.length})`, '');
      lines.push('No public Maven coordinate could be found for these (almost always because they\'re', 'internal/proprietary libraries never published anywhere) — CFR decompiled them and their', 'source now lives under `lib-src/<name>/`, wired in via build-helper-maven-plugin instead of', 'a binary dependency. Review this source like any other decompiled output; if any of these', 'share a class/package name with another library or the app itself, that will surface as a', 'real `mvn compile` duplicate-class error, same as any genuine naming collision would.', '');
      for (const d of decompiledLibs) lines.push(`- \`${d.jarName}\` -> \`lib-src/${d.artifactId}/\`${d.sharedLibrarySource ? ` (identity matched against \`${d.sharedLibrarySource}\` in your shared-dependencies folder)` : ''}`);
      lines.push('');
    }
    if (unresolved.length) {
      lines.push(`### Still unresolved, not decompiled (${unresolved.length}) — build will need a local \`mvn install:install-file\` for each, see pom.xml comments`, '');
      lines.push('CFR either wasn\'t installed or failed on these specifically — install CFR from Tool Setup', 'and re-run to attempt decompiling them too.', '');
      for (const d of unresolved) lines.push(`- \`${d.jarName}\` (sha1 ${d.sha1})${d.sharedLibrarySource ? ` — identity matched against \`${d.sharedLibrarySource}\` in your shared-dependencies folder` : ''}`);
      lines.push('');
    }
    if (guessed.length) {
      lines.push(`### Guessed by artifact-id search, not SHA-1-confirmed (${guessed.length}) — double check these versions`, '');
      for (const d of guessed) lines.push(`- \`${d.jarName}\` -> ${d.groupId}:${d.artifactId}:${d.version}`);
      lines.push('');
    }
    if (autoMatched.length) {
      lines.push(`### Auto-matched by class-name search (${autoMatched.length}) — verify these, not human-confirmed`, '');
      lines.push('pom.properties, SHA-1, and filename-guess all failed to identify these — matched instead by', 'searching Maven Central for several of the jar\'s own classes and picking whichever real', 'artifact showed up most consistently (see the Dependencies panel to re-run the search', 'manually and pick a different match if this looks wrong).', '');
      for (const d of autoMatched) lines.push(`- \`${d.jarName}\` -> ${d.groupId}:${d.artifactId}:${d.version}`);
      lines.push('');
    }
  }

  const missingPackages = input.missingPackages || [];
  if (missingPackages.length) {
    lines.push(`## Packages missing from this WAR entirely (${missingPackages.length})`, '');
    lines.push('These classes are referenced by the decompiled code but were never bundled in the WAR\'s', 'own WEB-INF/lib at all — a plain dependency-resolution fix can\'t help, since there\'s no jar', 'here to identify in the first place.', '');
    for (const p of missingPackages) {
      if (p.status === 'resolved' && p.resolvedVia?.startsWith('workspace:')) lines.push(`- \`${p.package}\` — resolved: reused already-decompiled source from another job's \`${p.resolvedVia.slice('workspace:'.length)}\`, copied into this project's lib-src/decompiled-libs`);
      else if (p.status === 'resolved' && p.resolvedVia?.startsWith('java-ee-provided-api:')) lines.push(`- \`${p.package}\` — resolved: recognized as a container-provided Java EE API (\`${p.resolvedVia.slice('java-ee-provided-api:'.length)}\`, scope=provided) — no application server needed, this is a real Maven Central artifact`);
      else if (p.status === 'resolved' && p.resolvedVia?.startsWith('java-ee-container-lib:')) lines.push(`- \`${p.package}\` — resolved: found in your configured Java EE container library folder (\`${p.resolvedVia.slice('java-ee-container-lib:'.length)}\`) — installed as scope=provided, not decompiled (it's the server's own code)`);
      else if (p.status === 'resolved' && p.resolvedVia) lines.push(`- \`${p.package}\` — resolved: found in shared-dependencies jar \`${p.resolvedVia}\`, installed and added as a new dependency`);
      else if (p.status === 'ambiguous') lines.push(`- \`${p.package}\` — ambiguous: supplied by ${p.candidateJars.length} different shared-dependencies jars (${p.candidateJars.map(j => `\`${j}\``).join(', ')}) — too ambiguous to auto-pick, needs manual resolution`);
      else if (p.status === 'not_found') lines.push(`- \`${p.package}\` — not found in your shared-dependencies folder; locate the jar that provides it and add it there, or add it as a normal dependency`);
      else lines.push(`- \`${p.package}\` — no shared-dependencies folder configured (set SHARED_DEPENDENCIES_DIRS in Tool Setup) to search for it`);
    }
    lines.push('');
  }

  const excludedFiles = input.excludedUnfixableFiles || [];
  if (excludedFiles.length) {
    lines.push(`## Decompiled classes pruned as unfixable (${excludedFiles.length})`, '');
    lines.push('These files reference a package no jar or previously-decompiled library could supply, and', 'nothing else in the project referenced them, so they were moved out of the compiled path rather', 'than leaving the build permanently broken by dead optional code. Relocated, not deleted — see', '`excluded-unfixable-classes/` under this job\'s workspace directory if you need to review or', 'restore any of them.', '');
    for (const f of excludedFiles) lines.push(`- \`${f.relativePath}\` — ${f.reason}`);
    lines.push('');
  }

  const fallback = input.classes.filter(c => c.aiStatus === 'failed_fallback');
  if (fallback.length) {
    lines.push(`## Classes where AI reconstruction fell back to raw decompiler output (${fallback.length})`, '');
    lines.push('These still contain the original decompiler failure markers and are more likely to need manual attention.', '');
    for (const c of fallback) lines.push(`- \`${c.fqcn}\` (engine: ${c.winningEngine})`);
    lines.push('');
  }

  const noWinner = input.classes.filter(c => !c.winningEngine);
  if (noWinner.length) {
    lines.push(`## Classes no decompiler could produce at all (${noWinner.length})`, '');
    for (const c of noWinner) lines.push(`- \`${c.fqcn}\``);
    lines.push('');
  }

  return lines.join('\n');
}
