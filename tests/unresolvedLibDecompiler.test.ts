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
import { stripNestedArchives, dedupeAcrossDependencies } from '../src/services/unresolvedLibDecompiler';
import { SYNTAX_ERROR_MARKER } from './mocks/javaParserMock';

function tempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe('stripNestedArchives', () => {
  it('leaves an ordinary dependency jar untouched (no round-trip) when nothing needs stripping', async () => {
    const zip = new AdmZip();
    zip.addFile('com/example/Foo.class', Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
    const src = tempDir('bjd-nested-clean-');
    const jarPath = path.join(src, 'clean.jar');
    zip.writeZip(jarPath);

    const work = tempDir('bjd-nested-clean-work-');
    const result = await stripNestedArchives(jarPath, work);

    expect(result.strippedEntries).toEqual([]);
    expect(result.jarPath).toBe(jarPath); // same path returned — no sanitize round-trip
  });

  it('strips nested jar/war/zip entries and rewrites a clean jar with everything else intact', async () => {
    const zip = new AdmZip();
    zip.addFile('com/example/Foo.class', Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
    zip.addFile('WebRoot/WEB-INF/lib/embedded-lib.jar', Buffer.from('not a real jar, just bytes'));
    zip.addFile('WebRoot/WEB-INF/lib/another.war', Buffer.from('also not real'));
    zip.addFile('README.txt', Buffer.from('hello'));
    const src = tempDir('bjd-nested-dirty-');
    const jarPath = path.join(src, 'dirty.jar');
    zip.writeZip(jarPath);

    const work = tempDir('bjd-nested-dirty-work-');
    const result = await stripNestedArchives(jarPath, work);

    expect(result.strippedEntries.sort()).toEqual([
      'WebRoot/WEB-INF/lib/another.war',
      'WebRoot/WEB-INF/lib/embedded-lib.jar',
    ]);
    expect(result.jarPath).not.toBe(jarPath);
    expect(fs.existsSync(result.jarPath)).toBe(true);

    const sanitized = new AdmZip(result.jarPath);
    const names = sanitized.getEntries().map(e => e.entryName);
    expect(names).toContain('com/example/Foo.class');
    expect(names).toContain('README.txt');
    expect(names.some(n => n.endsWith('.jar'))).toBe(false);
    expect(names.some(n => n.endsWith('.war'))).toBe(false);
  });

  it('strips a nested archive by content even when its name does not end in .jar/.war/.zip (SVN pristine-copy shape)', async () => {
    const nested = new AdmZip();
    nested.addFile('com/example/Nested.class', Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
    const nestedBytes = nested.toBuffer();

    const outer = new AdmZip();
    outer.addFile('com/example/Foo.class', Buffer.from([0xca, 0xfe, 0xba, 0xbe]));
    // Real-world shape: an SVN working copy's pristine binary copy keeps the original jar's bytes
    // but under a name ending in ".svn-base", not ".jar" — a name-only filter would miss this.
    outer.addFile('lib/.svn/text-base/embedded.jar.svn-base', nestedBytes);
    const src = tempDir('bjd-nested-svnbase-');
    const jarPath = path.join(src, 'outer.jar');
    outer.writeZip(jarPath);

    const work = tempDir('bjd-nested-svnbase-work-');
    const result = await stripNestedArchives(jarPath, work);

    expect(result.strippedEntries).toEqual(['lib/.svn/text-base/embedded.jar.svn-base']);
    const sanitized = new AdmZip(result.jarPath);
    const names = sanitized.getEntries().map(e => e.entryName);
    expect(names).toContain('com/example/Foo.class');
    expect(names).not.toContain('lib/.svn/text-base/embedded.jar.svn-base');
  });

  it('returns the original path unchanged for an unreadable/corrupt jar', async () => {
    const src = tempDir('bjd-nested-corrupt-');
    const jarPath = path.join(src, 'corrupt.jar');
    fs.writeFileSync(jarPath, 'this is not a zip file at all');

    const work = tempDir('bjd-nested-corrupt-work-');
    const result = await stripNestedArchives(jarPath, work);

    expect(result.jarPath).toBe(jarPath);
    expect(result.strippedEntries).toEqual([]);
  });
});

function writeLibsRoot(workspaceDir: string, layout: Record<string, Record<string, string>>): void {
  for (const [artifactId, files] of Object.entries(layout)) {
    for (const [relPath, content] of Object.entries(files)) {
      const dest = path.join(workspaceDir, 'decompiled-libs', artifactId, relPath);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, content, 'utf8');
    }
  }
}

describe('dedupeAcrossDependencies', () => {
  it('does nothing when there is no decompiled-libs directory at all', async () => {
    const work = tempDir('bjd-dedupe-none-');
    const result = await dedupeAcrossDependencies(work);
    expect(result.conflicts).toEqual([]);
  });

  it('does nothing when no class is duplicated across dependencies', async () => {
    const work = tempDir('bjd-dedupe-clean-');
    writeLibsRoot(work, {
      depA: { 'com/example/A.java': 'package com.example; class A {}' },
      depB: { 'com/example/B.java': 'package com.example; class B {}' },
    });
    const result = await dedupeAcrossDependencies(work);
    expect(result.conflicts).toEqual([]);
    expect(fs.existsSync(path.join(work, 'decompiled-libs/depA/com/example/A.java'))).toBe(true);
    expect(fs.existsSync(path.join(work, 'decompiled-libs/depB/com/example/B.java'))).toBe(true);
  });

  it('keeps one copy of a class duplicated across two dependencies and removes the rest', async () => {
    const work = tempDir('bjd-dedupe-dup-');
    writeLibsRoot(work, {
      depA: { 'com/example/Shared.java': 'package com.example; class Shared { int a; }' },
      depB: { 'com/example/Shared.java': 'package com.example; class Shared { int b; }' },
    });
    const result = await dedupeAcrossDependencies(work);
    expect(result.conflicts).toEqual([{ fqcn: 'com/example/Shared.java', kept: 'depA', removedFrom: ['depB'] }]);
    expect(fs.existsSync(path.join(work, 'decompiled-libs/depA/com/example/Shared.java'))).toBe(true);
    expect(fs.existsSync(path.join(work, 'decompiled-libs/depB/com/example/Shared.java'))).toBe(false);
  });

  it('prefers the copy that actually parses when one duplicate is broken', async () => {
    const work = tempDir('bjd-dedupe-broken-');
    writeLibsRoot(work, {
      depA: { 'com/example/Shared.java': `package com.example; class Shared { ${SYNTAX_ERROR_MARKER} }` },
      depB: { 'com/example/Shared.java': 'package com.example; class Shared { int b; }' },
    });
    const result = await dedupeAcrossDependencies(work);
    expect(result.conflicts).toEqual([{ fqcn: 'com/example/Shared.java', kept: 'depB', removedFrom: ['depA'] }]);
    expect(fs.existsSync(path.join(work, 'decompiled-libs/depA/com/example/Shared.java'))).toBe(false);
    expect(fs.existsSync(path.join(work, 'decompiled-libs/depB/com/example/Shared.java'))).toBe(true);
  });
});
