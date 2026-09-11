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
import { commonPackagePrefix, listJarClasses } from '../src/services/mavenSearchService';

describe('commonPackagePrefix', () => {
  it('finds the shared namespace even when classes fan out into sub-packages (javax.mail case)', () => {
    const classes = [
      'javax.mail.Session', 'javax.mail.Message', 'javax.mail.Transport', 'javax.mail.Folder',
      'javax.mail.internet.MimeMessage', 'javax.mail.internet.InternetAddress',
      'javax.mail.util.ByteArrayDataSource', 'javax.mail.search.SearchTerm',
    ];
    expect(commonPackagePrefix(classes)).toBe('javax.mail');
  });

  it('goes one level deeper when the whole jar sits under a longer shared namespace (net.sf.json case)', () => {
    const classes = [
      'net.sf.json.JSONObject', 'net.sf.json.JSONArray', 'net.sf.json.JSONNull',
      'net.sf.json.util.JSONUtils', 'net.sf.json.xml.XMLSerializer',
    ];
    expect(commonPackagePrefix(classes)).toBe('net.sf.json');
  });

  it('returns null for an empty class list', () => {
    expect(commonPackagePrefix([])).toBeNull();
  });

  it('returns null for classes with no package at all', () => {
    expect(commonPackagePrefix(['Foo', 'Bar'])).toBeNull();
  });

  it('does not extend past the point where no prefix holds a majority', () => {
    // Three totally unrelated single-class packages — no shared prefix beats 50%.
    const classes = ['com.alpha.Foo', 'org.beta.Bar', 'net.gamma.Baz'];
    expect(commonPackagePrefix(classes)).toBeNull();
  });
});

describe('listJarClasses', () => {
  function makeJar(entries: string[]): string {
    const zip = new AdmZip();
    for (const e of entries) zip.addFile(e, Buffer.from(''));
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'bjd-mavensearch-')), 'test.jar');
    zip.writeZip(file);
    return file;
  }

  it('extracts fully-qualified class names, excluding inner classes and module/package-info', () => {
    const jar = makeJar([
      'com/example/Foo.class',
      'com/example/Foo$Inner.class',
      'com/example/util/Bar.class',
      'module-info.class',
      'com/example/package-info.class',
      'META-INF/MANIFEST.MF',
    ]);
    const classes = listJarClasses(jar);
    expect(classes).toContain('com.example.Foo');
    expect(classes).toContain('com.example.util.Bar');
    expect(classes).not.toContain('com.example.Foo$Inner');
    expect(classes).not.toContain('module-info');
    expect(classes).not.toContain('com.example.package-info');
  });

  it('sorts shallower (more likely public-API) classes first', () => {
    const jar = makeJar([
      'com/example/deep/nested/pkg/Deep.class',
      'com/example/Shallow.class',
    ]);
    const classes = listJarClasses(jar);
    expect(classes[0]).toBe('com.example.Shallow');
  });

  it('returns an empty array for a nonexistent jar', () => {
    expect(listJarClasses(path.join(os.tmpdir(), 'bjd-does-not-exist-' + Date.now() + '.jar'))).toEqual([]);
  });
});
