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
import { extractMethods, patchBrokenMethods } from '../src/services/methodPatcherService';
import { DecompilerEngine } from '../src/models/job';
import { SYNTAX_ERROR_MARKER } from './mocks/javaParserMock';

function makeFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bjd-patcher-'));
  const filePath = path.join(dir, 'Test.java');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

describe('extractMethods', () => {
  it('extracts a simple method', () => {
    const source = [
      'class Foo {',
      '  void bar() {',
      '    int x = 1;',
      '  }',
      '}',
    ].join('\n');

    const methods = extractMethods(source);
    expect(methods).toHaveLength(1);
    expect(methods[0].key).toBe('bar()');
  });

  it('extracts a method with parameters', () => {
    const source = [
      'class Foo {',
      '  int bar(String s, int n) {',
      '    return n;',
      '  }',
      '}',
    ].join('\n');

    const methods = extractMethods(source);
    expect(methods).toHaveLength(1);
    expect(methods[0].key).toBe('bar(String,int)');
  });

  it('extracts multiple methods', () => {
    const source = [
      'class Foo {',
      '  void bar() { }',
      '  void baz() { }',
      '  int qux(int n) { return n; }',
      '}',
    ].join('\n');

    const methods = extractMethods(source);
    expect(methods).toHaveLength(3);
    expect(methods.map(m => m.key)).toEqual(['bar()', 'baz()', 'qux(int)']);
  });

  it('does not extract class declarations as methods', () => {
    const source = [
      'class Foo {',
      '  void bar() { }',
      '}',
    ].join('\n');

    const methods = extractMethods(source);
    expect(methods).toHaveLength(1);
    expect(methods[0].key).toBe('bar()');
  });

  it('handles methods with annotations', () => {
    const source = [
      'class Foo {',
      '  @Override',
      '  public String toString() {',
      '    return "Foo";',
      '  }',
      '}',
    ].join('\n');

    const methods = extractMethods(source);
    expect(methods).toHaveLength(1);
    expect(methods[0].key).toBe('toString()');
  });
});

describe('patchBrokenMethods', () => {
  it('patches a broken method from a donor engine', async () => {
    // Winner has a syntax error in bar(), donor has a clean bar()
    const winnerSource = [
      'class Foo {',
      '  void bar() {',
      `    ${SYNTAX_ERROR_MARKER}`,
      '    int x = 1;',
      '  }',
      '  void baz() {',
      '    int y = 2;',
      '  }',
      '}',
    ].join('\n');

    const donorSource = [
      'class Foo {',
      '  void bar() {',
      '    int x = 1;',
      '  }',
      '  void baz() {',
      '    int y = 2;',
      '  }',
      '}',
    ].join('\n');

    const donors = new Map<DecompilerEngine, string>([['vineflower', donorSource]]);
    const { fixed, patchedCount } = await patchBrokenMethods(winnerSource, 'cfr', donors);

    expect(patchedCount).toBe(1);
    // The patched source should not contain the syntax error marker
    expect(fixed).not.toContain(SYNTAX_ERROR_MARKER);
  });

  it('does not patch when no donor has the same method', async () => {
    const winnerSource = [
      'class Foo {',
      '  void bar() {',
      `    ${SYNTAX_ERROR_MARKER}`,
      '  }',
      '}',
    ].join('\n');

    const donorSource = [
      'class Foo {',
      '  void differentMethod() {',
      '    int x = 1;',
      '  }',
      '}',
    ].join('\n');

    const donors = new Map<DecompilerEngine, string>([['vineflower', donorSource]]);
    const { patchedCount } = await patchBrokenMethods(winnerSource, 'cfr', donors);
    expect(patchedCount).toBe(0);
  });

  it('does not patch when the donor method is also broken', async () => {
    const winnerSource = [
      'class Foo {',
      '  void bar() {',
      `    ${SYNTAX_ERROR_MARKER}`,
      '  }',
      '}',
    ].join('\n');

    const donorSource = [
      'class Foo {',
      '  void bar() {',
      `    ${SYNTAX_ERROR_MARKER}`,
      '  }',
      '}',
    ].join('\n');

    const donors = new Map<DecompilerEngine, string>([['vineflower', donorSource]]);
    const { patchedCount } = await patchBrokenMethods(winnerSource, 'cfr', donors);
    expect(patchedCount).toBe(0);
  });

  it('leaves clean methods untouched', async () => {
    const winnerSource = [
      'class Foo {',
      '  void bar() {',
      '    int x = 1;',
      '  }',
      '}',
    ].join('\n');

    const donorSource = [
      'class Foo {',
      '  void bar() {',
      '    int x = 2;',
      '  }',
      '}',
    ].join('\n');

    const donors = new Map<DecompilerEngine, string>([['vineflower', donorSource]]);
    const { fixed, patchedCount } = await patchBrokenMethods(winnerSource, 'cfr', donors);
    expect(patchedCount).toBe(0);
    // Winner's bar() should be unchanged
    expect(fixed).toContain('int x = 1');
  });
});