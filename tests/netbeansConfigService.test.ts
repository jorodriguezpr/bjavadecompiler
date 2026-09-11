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
import { detectMainClass } from '../src/services/netbeansConfigService';
import { generateProject, ProjectGenerationInput } from '../src/services/projectGeneratorService';

describe('detectMainClass', () => {
  function makeSrcTree(files: Record<string, string>): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bjd-mainclass-'));
    for (const [rel, content] of Object.entries(files)) {
      const full = path.join(dir, rel);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content, 'utf8');
    }
    return dir;
  }

  it('finds the unique main class', () => {
    const src = makeSrcTree({
      'com/example/Main.java': 'public class Main { public static void main(String[] args) {} }',
      'com/example/Util.java': 'public class Util { void helper() {} }',
    });
    expect(detectMainClass(src)).toBe('com.example.Main');
  });

  it('returns null for zero main classes', () => {
    const src = makeSrcTree({
      'com/example/Util.java': 'public class Util { void helper() {} }',
    });
    expect(detectMainClass(src)).toBeNull();
  });

  it('returns null for multiple main classes (ambiguous)', () => {
    const src = makeSrcTree({
      'com/example/Main.java': 'public class Main { public static void main(String[] args) {} }',
      'com/example/Other.java': 'public class Other { public static void main(String[] argv) {} }',
    });
    expect(detectMainClass(src)).toBeNull();
  });

  it('returns null for a nonexistent dir', () => {
    expect(detectMainClass(path.join(os.tmpdir(), 'bjd-does-not-exist-' + Date.now()))).toBeNull();
  });
});

describe('generateProject — NetBeans integration', () => {
  function minimalInput(overrides: Partial<ProjectGenerationInput>): ProjectGenerationInput {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bjd-nb-'));
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
      hasEmptyClasses: false,
      extractionWarnings: [],
      ...overrides,
    };
  }

  it('writes nbactions.xml with build/clean actions', () => {
    const input = minimalInput({});
    generateProject(input);
    const nbactions = fs.readFileSync(path.join(input.projectDir, 'nbactions.xml'), 'utf8');
    expect(nbactions).toContain('<actionName>build</actionName>');
    expect(nbactions).toContain('<actionName>clean</actionName>');
    expect(nbactions).toContain('<goal>install</goal>');
  });

  it('writes nbproject/project.xml with the artifact name', () => {
    const input = minimalInput({ artifactId: 'myapp' });
    generateProject(input);
    const projectXml = fs.readFileSync(path.join(input.projectDir, 'nbproject', 'project.xml'), 'utf8');
    expect(projectXml).toContain('org.netbeans.modules.maven');
    expect(projectXml).toContain('<name>myapp</name>');
  });

  it('adds spring-boot:run action for spring-boot apps', () => {
    const input = minimalInput({ appType: 'spring-boot' });
    generateProject(input);
    const nbactions = fs.readFileSync(path.join(input.projectDir, 'nbactions.xml'), 'utf8');
    expect(nbactions).toContain('spring-boot:run');
  });

  it('adds exec:java run action for plain-jar with a main class', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bjd-nb-main-'));
    const reconstructedDir = path.join(dir, 'reconstructed');
    fs.mkdirSync(path.join(reconstructedDir, 'com/example'), { recursive: true });
    fs.writeFileSync(
      path.join(reconstructedDir, 'com/example/Main.java'),
      'public class Main { public static void main(String[] args) {} }',
      'utf8',
    );

    const input = minimalInput({ reconstructedSourcesDir: reconstructedDir });
    generateProject(input);

    const nbactions = fs.readFileSync(path.join(input.projectDir, 'nbactions.xml'), 'utf8');
    expect(nbactions).toContain('exec:java');
    expect(nbactions).toContain('com.example.Main');
  });

  it('includes framework info in NOTES.md', () => {
    const input = minimalInput({
      detectedFrameworks: [
        { id: 'spring-boot', label: 'Spring Boot', confidence: 'confirmed', evidence: 'Dependency org.springframework.boot:spring-boot:3.2.0' },
        { id: 'lombok', label: 'Project Lombok', confidence: 'confirmed', evidence: 'Dependency org.projectlombok:lombok:1.18.30' },
      ],
      detectedPrimaryFramework: 'spring-boot',
    });
    generateProject(input);
    const notes = fs.readFileSync(path.join(input.projectDir, 'BJAVADECOMPILER-NOTES.md'), 'utf8');
    expect(notes).toContain('Detected frameworks and libraries');
    expect(notes).toContain('Spring Boot');
    expect(notes).toContain('Project Lombok');
    expect(notes).toContain('NetBeans');
  });

  it('omits framework section from NOTES.md when none detected', () => {
    const input = minimalInput({});
    generateProject(input);
    const notes = fs.readFileSync(path.join(input.projectDir, 'BJAVADECOMPILER-NOTES.md'), 'utf8');
    expect(notes).not.toContain('Detected frameworks and libraries');
  });
});