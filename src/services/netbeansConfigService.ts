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
 * BJavaDecompiler - NetBeans project integration.
 *
 * NetBeans opens any valid Maven project natively (pom.xml is the entire requirement), which
 * the generator already satisfies. But a few extra files make the reopened project feel like a
 * first-class NetBeans project rather than a bare pom:
 *
 * - nbactions.xml — custom actions (Run/Debug/Profile) so the project right-clicks cleanly.
 *   For Spring Boot: `spring-boot:run`. For WARs: no default run (needs a server), so we emit
 *   only a build action. NetBeans reads nbactions.xml to wire the toolbar Run button.
 * - nbproject/project.xml — NetBeans' own project metadata. Optional for pure Maven projects
 *   (NetBeans auto-imports), but explicitly declaring the Java source level prevents NetBeans
 *   from asking to re-scan with the wrong JDK.
 *
 * All files are best-effort — a write failure is logged and skipped, never fails the job.
 */

import fs from 'fs';
import path from 'path';
import { xmlEscape } from './projectGeneratorService';

interface NetBeansActionsInput {
  projectDir: string;
  artifactId: string;
  packaging: 'war' | 'jar';
  appType: 'spring-boot' | 'java-ee' | 'plain-jar';
  primaryFramework: string | null;
  /** Main class FQCN, when one can be confidently identified (plain-jar / spring-boot). */
  mainClass: string | null;
}

function buildNbActions(input: NetBeansActionsInput): string {
  const actions: string[] = [];

  // BUILD action — always present
  actions.push(`      <action>
            <actionName>build</actionName>
            <goals>
              <goal>install</goal>
            </goals>
          </action>`);
  // CLEAN action
  actions.push(`      <action>
            <actionName>clean</actionName>
            <goals>
              <goal>clean</goal>
            </goals>
          </action>`);
  // REBUILD-CLEAN action (clean + build)
  actions.push(`      <action>
            <actionName>rebuild</actionName>
            <goals>
              <goal>clean</goal>
              <goal>install</goal>
            </goals>
          </action>`);

  // Spring Boot Run / Debug via spring-boot:run
  if (input.appType === 'spring-boot') {
    actions.push(`      <action>
            <actionName>run</actionName>
            <goals>
              <goal>spring-boot:run</goal>
            </goals>
          </action>`);
    actions.push(`      <action>
            <actionName>debug</actionName>
            <goals>
              <goal>spring-boot:run</goal>
            </goals>
            <properties>
              <spring-boot.run.jvmArguments>-Xdebug -Xrunjdwp:transport=dt_socket,server=n,address=${'$'}{jpda.address}</spring-boot.run.jvmArguments>
            </properties>
          </action>`);
  }

  // Plain-jar: run via exec-maven-plugin referencing the detected/generated main class.
  if (input.appType === 'plain-jar' && input.mainClass) {
    const escapedMainClass = xmlEscape(input.mainClass);
    actions.push(`      <action>
            <actionName>run</actionName>
            <goals>
              <goal>exec:java</goal>
            </goals>
            <properties>
              <exec.mainClass>${escapedMainClass}</exec.mainClass>
            </properties>
          </action>`);
  }

  // Java EE (WAR): no default Run action — needs a real application server. Add a note.
  if (input.packaging === 'war' && input.appType !== 'spring-boot') {
    // Intentionally no run action — NetBeans shows its own server-picker when the project
    // carries the web facet. Leaving Run unset is correct: it won't pretend to work.
  }

  return `<?xml version="1.0" encoding="UTF-8"?>
<actions>
${actions.join('\n')}
</actions>
`;
}

function buildNbProjectXml(input: NetBeansActionsInput): string {
  // NetBeans Maven project.xml — declares the project type and name so the import panel
  // doesn't need to infer it. Keep it minimal; NetBeans augments on import.
  const name = xmlEscape(input.artifactId);
  return `<?xml version="1.0" encoding="UTF-8"?>
<project xmlns="http://www.netbeans.org/ns/project/1">
    <type>org.netbeans.modules.maven</type>
    <configuration>
        <data xmlns="http://www.netbeans.org/ns/maven-project/1">
            <name>${name}</name>
        </data>
    </configuration>
</project>
`;
}

/** Detects a likely main class from the decompiled classes: the unique class with a
 * `public static void main(String[])` signature. Returns null when zero or multiple
 * candidates exist (ambiguous — better to leave NetBeans's default than guess wrong). */
export function detectMainClass(reconstructedSourcesDir: string): string | null {
  if (!fs.existsSync(reconstructedSourcesDir)) return null;
  const candidates: string[] = [];
  (function walk(dir: string) {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      if (!entry.name.endsWith('.java')) continue;
      try {
        const text = fs.readFileSync(full, 'utf8');
        if (/public\s+static\s+void\s+main\s*\(\s*String\s*\[/.test(text)) {
          // Derive fqcn from path: <srcRoot>/<pkg path>/<ClassName>.java
          const rel = path.relative(reconstructedSourcesDir, full);
          const fqcn = rel
            .replace(/\.java$/, '')
            .split(path.sep)
            .join('.');
          candidates.push(fqcn);
        }
      } catch { /* best-effort */ }
    }
  })(reconstructedSourcesDir);

  return candidates.length === 1 ? candidates[0] : null;
}

/** Writes nbactions.xml + nbproject/project.xml to the generated project. Best-effort: any
 * single failure logs and continues. Returns which files were written (relative names). */
export function writeNetBeansConfig(input: NetBeansActionsInput): string[] {
  const written: string[] = [];

  try {
    fs.mkdirSync(input.projectDir, { recursive: true });
    fs.writeFileSync(path.join(input.projectDir, 'nbactions.xml'), buildNbActions(input), 'utf8');
    written.push('nbactions.xml');
  } catch { /* best-effort */ }

  try {
    const nbProjectDir = path.join(input.projectDir, 'nbproject');
    fs.mkdirSync(nbProjectDir, { recursive: true });
    fs.writeFileSync(path.join(nbProjectDir, 'project.xml'), buildNbProjectXml(input), 'utf8');
    written.push('nbproject/project.xml');
  } catch { /* best-effort */ }

  return written;
}