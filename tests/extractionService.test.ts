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
import AdmZip from 'adm-zip';
import { extract } from '../src/services/extractionService';

function buildZip(entries: Record<string, string>): string {
  const zip = new AdmZip();
  for (const [name, content] of Object.entries(entries)) {
    zip.addFile(name, Buffer.from(content));
  }
  const file = path.join(os.tmpdir(), `bjd-extract-test-${Date.now()}-${Math.random().toString(36).slice(2)}.jar`);
  zip.writeZip(file);
  return file;
}

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'bjd-extract-ws-'));
}

describe('extract', () => {
  it('detects a Spring Boot fat jar (BOOT-INF layout) and scopes classesDir/libJars correctly', () => {
    const zipPath = buildZip({
      'BOOT-INF/classes/com/example/App.class': 'fake-class-bytes',
      'BOOT-INF/classes/application.properties': 'server.port=8080',
      'BOOT-INF/lib/spring-core-6.1.0.jar': 'fake-jar-bytes',
      'org/springframework/boot/loader/JarLauncher.class': 'fake-loader-bytes',
    });

    const result = extract(zipPath, 'myapp.jar', tmpWorkspace());

    expect(result.appType).toBe('spring-boot');
    expect(result.inputType).toBe('jar');
    expect(result.classesDir.endsWith(path.join('BOOT-INF', 'classes'))).toBe(true);
    expect(result.libJars).toHaveLength(1);
    expect(result.libJars[0]).toContain('spring-core-6.1.0.jar');
    // JarLauncher.class sits at the archive root, outside BOOT-INF/classes — never a real
    // app class, so it must not be picked up as one.
    expect(result.classesDir.includes('org')).toBe(false);
  });

  it('detects a traditional Java EE WAR (WEB-INF layout)', () => {
    const zipPath = buildZip({
      'WEB-INF/classes/com/example/Servlet.class': 'fake-class-bytes',
      'WEB-INF/lib/commons-lang3-3.14.0.jar': 'fake-jar-bytes',
      'WEB-INF/web.xml': '<web-app></web-app>',
      'index.jsp': '<html></html>',
    });

    const result = extract(zipPath, 'myapp.war', tmpWorkspace());

    expect(result.appType).toBe('java-ee');
    expect(result.inputType).toBe('war');
    expect(result.libJars).toHaveLength(1);
    expect(result.webappFiles.some(f => f.endsWith('web.xml'))).toBe(true);
    expect(result.webappFiles.some(f => f.endsWith('index.jsp'))).toBe(true);
  });

  it('treats a flat jar with neither BOOT-INF nor WEB-INF as a plain jar', () => {
    const zipPath = buildZip({
      'com/example/Util.class': 'fake-class-bytes',
    });

    const result = extract(zipPath, 'utils.jar', tmpWorkspace());

    expect(result.appType).toBe('plain-jar');
    expect(result.inputType).toBe('jar');
    expect(result.libJars).toHaveLength(0);
  });
});
