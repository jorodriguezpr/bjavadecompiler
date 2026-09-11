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

import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectJavaVersionFromClassFile, deriveGroupArtifact, generateProject, ProjectGenerationInput } from '../src/services/projectGeneratorService';

function writeMinimalClassFile(majorVersion: number): string {
  const buf = Buffer.alloc(10);
  buf.writeUInt32BE(0xcafebabe, 0);
  buf.writeUInt16BE(0, 4); // minor
  buf.writeUInt16BE(majorVersion, 6);
  const file = path.join(os.tmpdir(), `bjd-test-${majorVersion}-${Date.now()}.class`);
  fs.writeFileSync(file, buf);
  return file;
}

describe('detectJavaVersionFromClassFile', () => {
  it('maps known bytecode major versions to the correct Java release', () => {
    const cases: [number, number][] = [[52, 8], [55, 11], [61, 17], [65, 21]];
    for (const [major, expectedJava] of cases) {
      const file = writeMinimalClassFile(major);
      try {
        expect(detectJavaVersionFromClassFile(file)).toBe(expectedJava);
      } finally {
        fs.unlinkSync(file);
      }
    }
  });

  it('returns null for a file that is not a valid class file', () => {
    const file = path.join(os.tmpdir(), `bjd-test-invalid-${Date.now()}.class`);
    fs.writeFileSync(file, Buffer.from('not a class file'));
    try {
      expect(detectJavaVersionFromClassFile(file)).toBeNull();
    } finally {
      fs.unlinkSync(file);
    }
  });
});

describe('deriveGroupArtifact', () => {
  it('prefers the manifest vendor id when present', () => {
    const { groupId, artifactId } = deriveGroupArtifact('MyApp.war', 'com/example/app', 'com.acme');
    expect(groupId).toBe('com.acme');
    expect(artifactId).toBe('myapp');
  });

  it('falls back to a package-derived groupId when no manifest vendor id exists', () => {
    const { groupId } = deriveGroupArtifact('MyApp.war', 'com/example/app', null);
    expect(groupId).toBe('com.example');
  });

  it('falls back to a generic placeholder groupId when nothing else is available', () => {
    const { groupId } = deriveGroupArtifact('mystery.jar', null, null);
    expect(groupId).toBe('com.bjavadecompiler.generated');
  });

  it('sanitizes the filename into a safe artifactId', () => {
    const { artifactId } = deriveGroupArtifact('My Weird App v2!.war', null, null);
    expect(artifactId).toMatch(/^[a-z0-9._-]+$/);
  });
});

function minimalInput(overrides: Partial<ProjectGenerationInput>): ProjectGenerationInput {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bjd-gen-'));
  return {
    projectDir: path.join(dir, 'project'),
    workspaceDir: dir,
    groupId: 'com.example',
    artifactId: 'myapp',
    packaging: 'jar',
    appType: 'plain-jar',
    javaVersion: 17,
    dependencies: [],
    transitiveExclusions: [],
    reconstructedSourcesDir: path.join(dir, 'reconstructed'),
    resourceFiles: [],
    resourceFilesRoot: dir,
    webappFiles: [],
    webappFilesRoot: dir,
    classes: [],
    hasEmptyClasses: true,
    extractionWarnings: [],
    ...overrides,
  };
}

describe('generateProject pom.xml plugin selection', () => {
  it('adds spring-boot-maven-plugin for a detected Spring Boot app, using the resolved spring-boot version', () => {
    const input = minimalInput({
      appType: 'spring-boot',
      packaging: 'jar',
      dependencies: [{
        jarName: 'spring-core-6.1.0.jar', sha1: 'deadbeef', groupId: 'org.springframework.boot',
        artifactId: 'spring-boot', version: '3.3.4', classifier: null, scope: 'compile', confidence: 'sha1-match',
        decompiledSourceDir: null, sharedLibrarySource: null,
      }],
    });

    generateProject(input);
    const pom = fs.readFileSync(path.join(input.projectDir, 'pom.xml'), 'utf8');

    expect(pom).toContain('spring-boot-maven-plugin');
    expect(pom).toContain('<version>3.3.4</version>');
    expect(pom).not.toContain('maven-war-plugin');
  });

  it('adds maven-war-plugin for a detected Java EE WAR, not spring-boot-maven-plugin', () => {
    const input = minimalInput({ appType: 'java-ee', packaging: 'war' });

    generateProject(input);
    const pom = fs.readFileSync(path.join(input.projectDir, 'pom.xml'), 'utf8');

    expect(pom).toContain('maven-war-plugin');
    expect(pom).not.toContain('spring-boot-maven-plugin');
  });

  it('adds neither plugin for a plain jar', () => {
    const input = minimalInput({ appType: 'plain-jar', packaging: 'jar' });

    generateProject(input);
    const pom = fs.readFileSync(path.join(input.projectDir, 'pom.xml'), 'utf8');

    expect(pom).not.toContain('maven-war-plugin');
    expect(pom).not.toContain('spring-boot-maven-plugin');
  });

  it('surfaces the detected app type in BJAVADECOMPILER-NOTES.md', () => {
    const input = minimalInput({ appType: 'spring-boot', packaging: 'jar' });

    generateProject(input);
    const notes = fs.readFileSync(path.join(input.projectDir, 'BJAVADECOMPILER-NOTES.md'), 'utf8');

    expect(notes).toContain('spring-boot');
  });
});

describe('generateProject servlet-api synthesis', () => {
  it('adds a provided javax.servlet-api dependency for a java-ee app with no bundled servlet-api jar', () => {
    // Confirmed real gap: a genuine WAR with javax.servlet/javax.servlet.http imports throughout
    // had zero matching dependency after resolution, since servlet-api is essentially never
    // bundled in WEB-INF/lib (a container provides it) — nothing added it, so every file
    // referencing the servlet API failed to compile.
    const input = minimalInput({ appType: 'java-ee', packaging: 'war' });

    generateProject(input);
    const pom = fs.readFileSync(path.join(input.projectDir, 'pom.xml'), 'utf8');

    expect(pom).toContain('<artifactId>javax.servlet-api</artifactId>');
    expect(pom).toContain('<scope>provided</scope>');
  });

  it('does not add a second servlet-api dependency when one is already bundled and resolved', () => {
    const input = minimalInput({
      appType: 'java-ee',
      packaging: 'war',
      dependencies: [{
        jarName: 'javax.servlet-api-3.1.0.jar', sha1: 'deadbeef', groupId: 'javax.servlet',
        artifactId: 'javax.servlet-api', version: '3.1.0', classifier: null, scope: 'provided', confidence: 'sha1-match',
        decompiledSourceDir: null, sharedLibrarySource: null,
      }],
    });

    generateProject(input);
    const pom = fs.readFileSync(path.join(input.projectDir, 'pom.xml'), 'utf8');

    expect(pom.match(/<artifactId>javax\.servlet-api<\/artifactId>/g)?.length).toBe(1);
  });

  it('does not add servlet-api for a non-java-ee app', () => {
    const input = minimalInput({ appType: 'plain-jar', packaging: 'jar' });

    generateProject(input);
    const pom = fs.readFileSync(path.join(input.projectDir, 'pom.xml'), 'utf8');

    expect(pom).not.toContain('javax.servlet-api');
  });
});
