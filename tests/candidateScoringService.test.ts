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
import { scoreAllCandidates, findFailureMarkers } from '../src/services/candidateScoringService';
import { DecompileRunResult } from '../src/services/decompilerRunner';
import { SYNTAX_ERROR_MARKER } from './mocks/javaParserMock';

function makeTree(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bjd-scoring-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

function fakeRunResult(engine: 'cfr' | 'vineflower' | 'jdcli', outputDir: string): DecompileRunResult {
  return { engine, ran: true, outputDir, stdout: '', stderr: '', exitCode: 0 };
}

describe('findFailureMarkers', () => {
  it('matches real JADX output ("JADX WARN:", not "JADX WARNING")', () => {
    // Confirmed live against a real decompiled file: JADX's actual comment text is the short
    // form with a colon, e.g. "/* JADX WARN: Type inference failed for: r0v58, ... */" — the
    // marker regex previously required literal "JADX WARNING" and never matched this at all.
    const source = '/* JADX WARN: Type inference failed for: r0v58, types: [java.lang.String] */\nclass A {}';
    expect(findFailureMarkers('jadx', source).length).toBeGreaterThan(0);
  });
});

describe('scoreAllCandidates', () => {
  it('picks the engine with no failure markers over one with them', async () => {
    const cfrDir = makeTree({
      'com/example/Foo.java': '/* WARNING: unable to fully decompile */\npackage com.example;\nclass Foo {}\n',
    });
    const vfDir = makeTree({
      'com/example/Foo.java': 'package com.example;\nclass Foo { void bar() {} }\n',
    });

    const results = await scoreAllCandidates([fakeRunResult('cfr', cfrDir), fakeRunResult('vineflower', vfDir)]);

    expect(results).toHaveLength(1);
    expect(results[0].fqcn).toBe('com/example/Foo');
    expect(results[0].winningEngine).toBe('vineflower');
    expect(results[0].failureMarkers.cfr).toBeDefined();
    expect(results[0].failureMarkers.vineflower).toBeUndefined();
  });

  it('penalizes brace imbalance even without an explicit failure marker', async () => {
    const cfrDir = makeTree({ 'A.java': 'class A { void x() {\n' }); // unclosed brace
    const vfDir = makeTree({ 'A.java': 'class A { void x() {} }\n' });

    const results = await scoreAllCandidates([fakeRunResult('cfr', cfrDir), fakeRunResult('vineflower', vfDir)]);

    expect(results[0].winningEngine).toBe('vineflower');
  });

  it('excludes inner/anonymous classes ($ in the name) from the top-level class list', async () => {
    const dir = makeTree({
      'Outer.java': 'class Outer {}\n',
      'Outer$Inner.java': 'class Inner {}\n',
    });

    const results = await scoreAllCandidates([fakeRunResult('cfr', dir)]);

    expect(results.map(r => r.fqcn)).toEqual(['Outer']);
  });

  it('still records a candidate with only one engine having output', async () => {
    const dir = makeTree({ 'Solo.java': 'class Solo {}\n' });
    const results = await scoreAllCandidates([fakeRunResult('jdcli', dir)]);
    expect(results[0].winningEngine).toBe('jdcli');
    expect(results[0].scores.jdcli).toBeDefined();
    expect(results[0].winnerSyntaxValid).toBe(true);
  });

  it('picks a candidate that parses over one with balanced braces, no markers, but a real syntax problem', async () => {
    // Confirmed live this exact shape happens for real: CFR 0.152 can mangle a try/catch/finally
    // into something with perfectly balanced braces and no failure-marker comment — 'catch'
    // without 'try' is a real javac error, but neither brace-counting nor marker-matching alone
    // can see it, only an actual parse attempt (SYNTAX_ERROR_MARKER stands in for that failure
    // here — see tests/mocks/javaParserMock.ts for why this suite doesn't use the real grammar).
    const cfrDir = makeTree({
      'Hook.java': `class Hook { void run() { try {} catch (Exception e) {} } catch (Exception e2) {} } ${SYNTAX_ERROR_MARKER}`,
    });
    const jdcliDir = makeTree({
      'Hook.java': 'class Hook { void run() { try {} catch (Exception e) {} } }',
    });

    const results = await scoreAllCandidates([fakeRunResult('cfr', cfrDir), fakeRunResult('jdcli', jdcliDir)]);

    expect(results[0].winningEngine).toBe('jdcli');
    expect(results[0].winnerSyntaxValid).toBe(true);
  });

  it('reports winnerSyntaxValid: false when every candidate fails to parse (best-of-a-bad-lot fallback)', async () => {
    const cfrDir = makeTree({ 'Broken.java': `class Broken {} ${SYNTAX_ERROR_MARKER}` });
    const vfDir = makeTree({ 'Broken.java': `class Broken {} ${SYNTAX_ERROR_MARKER}` });

    const results = await scoreAllCandidates([fakeRunResult('cfr', cfrDir), fakeRunResult('vineflower', vfDir)]);

    expect(results[0].winningEngine).not.toBeNull();
    expect(results[0].winnerSyntaxValid).toBe(false);
  });

  it('penalizes candidates with more unresolved type references', async () => {
    // Both candidates parse (no SYNTAX_ERROR_MARKER), but one references types we know about
    // and the other references types we don't. The one with fewer unresolved refs should win.
    // Uses `new` keyword so the type-reference extractor catches the references.
    const cfrDir = makeTree({
      'Foo.java': 'class Foo { void bar() { UnknownA a = new UnknownA(); UnknownB b = new UnknownB(); } }',
    });
    const vfDir = makeTree({
      'Foo.java': 'class Foo { void bar() { KnownType a = new KnownType(); } }',
    });

    // Pass a knownTypes set that includes KnownType but not UnknownA/UnknownB
    const knownTypes = new Set(['KnownType', 'Foo']);
    const results = await scoreAllCandidates(
      [fakeRunResult('cfr', cfrDir), fakeRunResult('vineflower', vfDir)],
      knownTypes,
    );

    expect(results[0].winningEngine).toBe('vineflower');
  });

  it('type-reference penalty does not override syntax validity', async () => {
    // A candidate that doesn't parse should still lose to one that does, even if the parsing
    // one has many unresolved type references.
    const cfrDir = makeTree({
      'Foo.java': `class Foo { void bar() { UnknownA a = null; UnknownB b = null; } } ${SYNTAX_ERROR_MARKER}`,
    });
    const vfDir = makeTree({
      'Foo.java': 'class Foo { void bar() { UnknownA a = null; UnknownB b = null; UnknownC c = null; } }',
    });

    const knownTypes = new Set<string>(); // nothing known — all refs are unresolved
    const results = await scoreAllCandidates(
      [fakeRunResult('cfr', cfrDir), fakeRunResult('vineflower', vfDir)],
      knownTypes,
    );

    // vineflower parses (no marker), cfr doesn't — vineflower wins despite more unresolved refs
    expect(results[0].winningEngine).toBe('vineflower');
    expect(results[0].winnerSyntaxValid).toBe(true);
  });
});
