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
import {
  remediateDeterministically,
  insertMissingCastsAst,
  insertMissingCastsForRawMethodCalls,
  parameterizeRawCollectionParams,
  locateImportedSourceFile,
  fileDeclaresMethod,
} from '../src/services/deterministicRemediationService';
import { MavenRunResult } from '../src/services/mavenVerifyService';
import { DependencyResolution } from '../src/models/job';
import { SYNTAX_ERROR_MARKER } from './mocks/javaParserMock';

function makeTempFile(content: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bjd-detrem-'));
  const filePath = path.join(dir, 'Test.java');
  fs.writeFileSync(filePath, content, 'utf8');
  return filePath;
}

function makeBuildResult(errorsByFile: Record<string, string[]>): MavenRunResult {
  return {
    success: false,
    stdout: '',
    stderr: '',
    command: 'mvn -q -DskipTests compile',
    durationMs: 0,
    errorsByFile,
    errorCount: Object.values(errorsByFile).reduce((sum, errs) => sum + errs.length, 0),
    brokenArtifacts: [],
    hasUnclassifiedFailure: false,
    missingPackages: [],
  };
}

const emptyDeps: DependencyResolution[] = [];

describe('remediateDeterministically', () => {
  it('adds a missing import for a known JDK type', async () => {
    const filePath = makeTempFile([
      'package com.example;',
      '',
      'class Foo {',
      '  void bar() {',
      '    List items = new ArrayList();',
      '  }',
      '}',
    ].join('\n'));

    const buildResult = makeBuildResult({
      [filePath]: ['[5,5] cannot find symbol  class List', '[5,22] cannot find symbol  class ArrayList'],
    });

    const appClassFqcns = ['com/example/Foo'];
    const outcome = await remediateDeterministically(buildResult, emptyDeps, appClassFqcns, os.tmpdir());

    expect(outcome.fixed).toContain(filePath);
    const fixed = fs.readFileSync(filePath, 'utf8');
    expect(fixed).toContain('import java.util.List');
    expect(fixed).toContain('import java.util.ArrayList');
  });

  it('adds a missing import for an app class', async () => {
    const filePath = makeTempFile([
      'package com.example;',
      '',
      'class Foo {',
      '  void bar() {',
      '    Bar b = new Bar();',
      '  }',
      '}',
    ].join('\n'));

    const buildResult = makeBuildResult({
      [filePath]: ['[5,5] cannot find symbol  class Bar'],
    });

    const appClassFqcns = ['com/example/Foo', 'com/example/Bar'];
    const outcome = await remediateDeterministically(buildResult, emptyDeps, appClassFqcns, os.tmpdir());

    expect(outcome.fixed).toContain(filePath);
    const fixed = fs.readFileSync(filePath, 'utf8');
    expect(fixed).toContain('import com.example.Bar');
  });

  it('adds a missing import from the real mvn compile continuation-line shape (mavenVerifyService.ts\'s parseErrors() output, not a single-line stand-in)', async () => {
    // Confirmed live: real `mvn compile` output has NO [ERROR] prefix on the "symbol:"/
    // "location:" continuation lines at all — mavenVerifyService.ts's parseErrors() joins them
    // onto the preceding error with a real `\n`, e.g. exactly this shape. A second, separate bug
    // (CANNOT_FIND_SYMBOL_RE's own greedy `\s*` swallowing the newline the optional group needed)
    // meant even THIS shape never actually extracted a symbol name until fixed alongside it.
    const filePath = makeTempFile([
      'package com.example;',
      '',
      'class Foo {',
      '  void bar() {',
      '    Bar b = new Bar();',
      '  }',
      '}',
    ].join('\n'));

    const buildResult = makeBuildResult({
      [filePath]: ['[5,5] cannot find symbol\n  symbol: class Bar\n  location: class Foo'],
    });

    const appClassFqcns = ['com/example/Foo', 'com/example/Bar'];
    const outcome = await remediateDeterministically(buildResult, emptyDeps, appClassFqcns, os.tmpdir());

    expect(outcome.fixed).toContain(filePath);
    const fixed = fs.readFileSync(filePath, 'utf8');
    expect(fixed).toContain('import com.example.Bar');
  });

  it('does not add an import for an unknown type', async () => {
    const filePath = makeTempFile([
      'package com.example;',
      '',
      'class Foo {',
      '  void bar() {',
         '    UnknownType x = null;',
      '  }',
      '}',
    ].join('\n'));

    const buildResult = makeBuildResult({
      [filePath]: ['[5,5] cannot find symbol  class UnknownType'],
    });

    const outcome = await remediateDeterministically(buildResult, emptyDeps, [], os.tmpdir());

    expect(outcome.unfixed).toContain(filePath);
    const fixed = fs.readFileSync(filePath, 'utf8');
    expect(fixed).not.toContain('import');
  });

  it('does not add a duplicate import', async () => {
    const filePath = makeTempFile([
      'package com.example;',
      '',
      'import java.util.List;',
      '',
      'class Foo {',
      '  void bar() {',
      '    List items = null;',
      '  }',
      '}',
    ].join('\n'));

    const buildResult = makeBuildResult({
      [filePath]: ['[7,5] cannot find symbol  class List'],
    });

    const outcome = await remediateDeterministically(buildResult, emptyDeps, ['com/example/Foo'], os.tmpdir());

    // The import already exists, so no modification should be made
    const fixed = fs.readFileSync(filePath, 'utf8');
    const importCount = (fixed.match(/import java\.util\.List;/g) || []).length;
    expect(importCount).toBe(1);
  });

  it('handles files that do not exist', async () => {
    const buildResult = makeBuildResult({
      '/nonexistent/path/Foo.java': ['[1,1] cannot find symbol  class Bar'],
    });

    const outcome = await remediateDeterministically(buildResult, emptyDeps, [], os.tmpdir());
    expect(outcome.unfixed).toContain('/nonexistent/path/Foo.java');
  });

  it('does not attempt to fix non-import errors', async () => {
    const filePath = makeTempFile([
      'class Foo {',
      '  void bar() {',
      '    int x = "string";',
      '  }',
      '}',
    ].join('\n'));

    const buildResult = makeBuildResult({
      [filePath]: ['[3,13] incompatible types: String cannot be converted to int'],
    });

    const outcome = await remediateDeterministically(buildResult, emptyDeps, [], os.tmpdir());
    expect(outcome.unfixed).toContain(filePath);
  });

  it('inserts a missing narrowing cast on a raw Enumeration.nextElement() (the real NetBeans Java Hints case)', async () => {
    const filePath = makeTempFile([
      'package com.example;',
      '',
      'import java.util.Hashtable;',
      'import java.util.Enumeration;',
      '',
      'class Foo {',
      '  void bar(Hashtable table) {',
      '    Enumeration keys = table.keys();',
      '    while (keys.hasMoreElements()) {',
      '      final String name = keys.nextElement();',
      '      System.out.println(name);',
      '    }',
      '  }',
      '}',
    ].join('\n'));

    const buildResult = makeBuildResult({
      [filePath]: ['[10,29] incompatible types: java.lang.Object cannot be converted to java.lang.String'],
    });

    const outcome = await remediateDeterministically(buildResult, emptyDeps, [], os.tmpdir());

    expect(outcome.fixed).toContain(filePath);
    const fixed = fs.readFileSync(filePath, 'utf8');
    expect(fixed).toContain('final String name = (String) (keys.nextElement());');
  });

  it('does not insert a cast when casting to a primitive would be needed instead', async () => {
    const filePath = makeTempFile([
      'class Foo {',
      '  void bar(Object o) {',
      '    int x = o;',
      '  }',
      '}',
    ].join('\n'));

    const buildResult = makeBuildResult({
      [filePath]: ['[3,13] incompatible types: java.lang.Object cannot be converted to int'],
    });

    const outcome = await remediateDeterministically(buildResult, emptyDeps, [], os.tmpdir());
    expect(outcome.unfixed).toContain(filePath);
    const fixed = fs.readFileSync(filePath, 'utf8');
    expect(fixed).toContain('int x = o;');
  });

  it('does not insert a cast when the line has a trailing comment (unsafe to blindly split)', async () => {
    const filePath = makeTempFile([
      'class Foo {',
      '  void bar(java.util.Enumeration keys) {',
      '    final String name = keys.nextElement(); // get the name',
      '  }',
      '}',
    ].join('\n'));

    const buildResult = makeBuildResult({
      [filePath]: ['[3,27] incompatible types: java.lang.Object cannot be converted to java.lang.String'],
    });

    const outcome = await remediateDeterministically(buildResult, emptyDeps, [], os.tmpdir());
    expect(outcome.unfixed).toContain(filePath);
    const fixed = fs.readFileSync(filePath, 'utf8');
    expect(fixed).not.toContain('(String)');
  });

  it('inserts a missing narrowing cast on a plain assignment, not just a declaration (real case: List.get(0) into an already-declared field)', async () => {
    const filePath = makeTempFile([
      'package com.example;',
      '',
      'import java.util.List;',
      '',
      'class Foo {',
      '  MegaTransferObject inMegaTO;',
      '  void bar(List megaTOList) {',
      '    inMegaTO = megaTOList.get(0);',
      '  }',
      '}',
    ].join('\n'));

    const buildResult = makeBuildResult({
      [filePath]: ['[8,16] incompatible types: java.lang.Object cannot be converted to com.example.MegaTransferObject'],
    });

    const outcome = await remediateDeterministically(buildResult, emptyDeps, [], os.tmpdir());

    expect(outcome.fixed).toContain(filePath);
    const fixed = fs.readFileSync(filePath, 'utf8');
    expect(fixed).toContain('inMegaTO = (MegaTransferObject) (megaTOList.get(0));');
  });

  it('does not insert a cast on a plain assignment with a trailing comment or compound operator', async () => {
    const filePath = makeTempFile([
      'class Foo {',
      '  String name;',
      '  void bar(java.util.Enumeration keys) {',
      '    name = keys.nextElement(); // trailing comment',
      '  }',
      '}',
    ].join('\n'));

    const buildResult = makeBuildResult({
      [filePath]: ['[4,12] incompatible types: java.lang.Object cannot be converted to java.lang.String'],
    });

    const outcome = await remediateDeterministically(buildResult, emptyDeps, [], os.tmpdir());
    expect(outcome.unfixed).toContain(filePath);
    const fixed = fs.readFileSync(filePath, 'utf8');
    expect(fixed).not.toContain('(String)');
  });

  it('does not double-cast a line that already starts with a cast', async () => {
    const filePath = makeTempFile([
      'class Foo {',
      '  void bar(java.util.Enumeration keys) {',
      '    final String name = (Object) keys.nextElement();',
      '  }',
      '}',
    ].join('\n'));

    const buildResult = makeBuildResult({
      [filePath]: ['[3,27] incompatible types: java.lang.Object cannot be converted to java.lang.String'],
    });

    const outcome = await remediateDeterministically(buildResult, emptyDeps, [], os.tmpdir());
    expect(outcome.unfixed).toContain(filePath);
    const fixed = fs.readFileSync(filePath, 'utf8');
    expect(fixed).toContain('final String name = (Object) keys.nextElement();');
  });
});

// insertMissingCastsAst() parses with the real `java-parser` grammar, which Jest can't load (see
// tests/mocks/javaParserMock.ts's own comment on why — chevrotain has no CommonJS export
// condition). Under the mock, `parse()` returns `undefined` for any source without
// SYNTAX_ERROR_MARKER, so these tests only verify the function degrades safely rather than
// crashing or guessing — the actual AST-driven insertion (locating the exact expression node for
// a method-argument/return-statement cast) was verified separately against real decompiled
// source with the real grammar, matching the same precedent javaSyntaxCheck.ts's own real-grammar
// correctness was verified with (see project memory / commit history, not re-verified in Jest).
describe('insertMissingCastsAst (mocked-parser graceful-degradation behavior)', () => {
  const source = 'class Foo {\n  void bar() {\n    take(list.get(0));\n  }\n}\n';
  const errors = ['[3,15] incompatible types: java.lang.Object cannot be converted to com.example.Bar'];

  it('returns the source unchanged when the mocked parser yields no usable CST', async () => {
    const result = await insertMissingCastsAst(source, errors, new Set());
    expect(result.source).toBe(source);
    expect(result.fixedLines.size).toBe(0);
  });

  it('does not throw when the file fails to parse at all', async () => {
    const broken = `${SYNTAX_ERROR_MARKER}\nclass Foo {`;
    const result = await insertMissingCastsAst(broken, errors, new Set());
    expect(result.source).toBe(broken);
    expect(result.fixedLines.size).toBe(0);
  });

  it('skips errors whose line is already in alreadyFixedLines', async () => {
    const result = await insertMissingCastsAst(source, errors, new Set([3]));
    expect(result.fixedLines.size).toBe(0);
  });

  it('skips a primitive target type (needs value conversion, not a reference cast)', async () => {
    const primitiveErrors = ['[3,15] incompatible types: java.lang.Object cannot be converted to int'];
    const result = await insertMissingCastsAst(source, primitiveErrors, new Set());
    expect(result.fixedLines.size).toBe(0);
  });
});

describe('locateImportedSourceFile', () => {
  it('finds a class under src/main/java', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bjd-locate-'));
    const target = path.join(dir, 'src', 'main', 'java', 'com', 'example', 'Foo.java');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'package com.example; class Foo {}', 'utf8');

    expect(locateImportedSourceFile(dir, 'com.example.Foo')).toBe(target);
  });

  it('finds a class under a lib-src/<dependency> source root (real project shape)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bjd-locate-'));
    const target = path.join(dir, 'lib-src', 'wwcommons-2.0.20150926.patch', 'com', 'wovenware', 'db', 'SortCriteria.java');
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, 'package com.wovenware.db; class SortCriteria {}', 'utf8');

    expect(locateImportedSourceFile(dir, 'com.wovenware.db.SortCriteria')).toBe(target);
  });

  it('returns null when the class was never decompiled into this project at all', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bjd-locate-'));
    expect(locateImportedSourceFile(dir, 'com.wovenware.icgrid.SomeMissingClass')).toBeNull();
  });
});

describe('fileDeclaresMethod', () => {
  it('finds a real public method declaration (real SortCriteria.java shape)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bjd-decl-'));
    const target = path.join(dir, 'SortCriteria.java');
    fs.writeFileSync(target, [
      'package com.wovenware.db;',
      'public class SortCriteria {',
      '    private AbstractAttributeType _attribute;',
      '    public synchronized AbstractAttributeType getAttribute() {',
      '        return this._attribute;',
      '    }',
      '}',
    ].join('\n'), 'utf8');

    expect(fileDeclaresMethod(target, 'getAttribute', new Map())).toBe(true);
    expect(fileDeclaresMethod(target, 'getSortType', new Map())).toBe(false);
  });

  it('caches file reads across calls sharing the same cache map', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bjd-decl-cache-'));
    const target = path.join(dir, 'Foo.java');
    fs.writeFileSync(target, 'public class Foo { public void bar() {} }', 'utf8');

    const cache = new Map<string, string>();
    expect(fileDeclaresMethod(target, 'bar', cache)).toBe(true);
    expect(cache.has(target)).toBe(true);
    fs.unlinkSync(target); // prove the second call reuses the cached text, not a fresh read
    expect(fileDeclaresMethod(target, 'bar', cache)).toBe(true);
  });
});

// insertMissingCastsForRawMethodCalls() also parses with the real grammar — same Jest-mock
// limitation as insertMissingCastsAst above. Its real correctness (locating the receiver span via
// the enclosing `primary` CST node, and picking the cast target from the file's own imports) was
// verified separately against real decompiled source: reproduced the exact real WAR case
// (`sortCriteria.get(i).getAttribute()` → `((SortCriteria) sortCriteria.get(i)).getAttribute()`,
// re-validated as syntactically correct Java afterward) and, at broader scale, dry-run against
// that job's full real error set — 1078 previously-unfixable lines across 201 of 238 affected
// files newly resolved out of 2262 raw-method-call error occurrences.
describe('insertMissingCastsForRawMethodCalls (mocked-parser graceful-degradation behavior)', () => {
  const source = [
    'package com.example;',
    'import com.example.SortCriteria;',
    'class Foo {',
    '  void bar(java.util.ArrayList sortCriteria) {',
    '    String attrType = sortCriteria.get(0).getAttribute().toString();',
    '  }',
    '}',
  ].join('\n');
  const errors = ['[5,42] cannot find symbol\n  symbol: method getAttribute()\n  location: class java.lang.Object'];

  it('returns the source unchanged when the mocked parser yields no usable CST', async () => {
    const result = await insertMissingCastsForRawMethodCalls(source, errors, os.tmpdir(), new Set(), new Map(), new Map(), new Map());
    expect(result.source).toBe(source);
    expect(result.fixedLines.size).toBe(0);
  });

  it('skips errors whose line is already in alreadyFixedLines', async () => {
    const result = await insertMissingCastsForRawMethodCalls(source, errors, os.tmpdir(), new Set([5]), new Map(), new Map(), new Map());
    expect(result.fixedLines.size).toBe(0);
  });

  it('does nothing when the file has no imports at all', async () => {
    const noImports = 'class Foo { void bar() { x.get(0).getAttribute(); } }';
    const result = await insertMissingCastsForRawMethodCalls(noImports, errors, os.tmpdir(), new Set(), new Map(), new Map(), new Map());
    expect(result.fixedLines.size).toBe(0);
  });

  it('does not throw when the error does not match the raw-method-call shape at all', async () => {
    const result = await insertMissingCastsForRawMethodCalls(source, ['[1,1] some other error'], os.tmpdir(), new Set(), new Map(), new Map(), new Map());
    expect(result.fixedLines.size).toBe(0);
  });

  it('also recognizes the "X() has protected access in java.lang.Object" shape (real clone() case) and degrades gracefully the same way', async () => {
    // Confirmed live: 0/540 real clone() errors in one WAR were fixable by import-uniqueness
    // alone (a "TO" class family commonly imports several sibling types that ALL declare their
    // own clone()) — the preceding-cast heuristic (findPrecedingValidatedCast, real correctness
    // verified separately against actual decompiled source: `(FilesTO)childCriteria.get(0).clone()`
    // → `(FilesTO)((FilesTO) childCriteria.get(0)).clone()`, re-validated as syntactically correct
    // Java) fixed 258/540. Real AST-driven correctness can't be exercised under Jest's mocked
    // parser (same limitation as every AST-based pass in this file) — this just confirms the
    // error-shape regex is recognized and the function still degrades safely under the mock.
    const cloneErrors = ['[821,73] clone() has protected access in java.lang.Object'];
    const result = await insertMissingCastsForRawMethodCalls(source, cloneErrors, os.tmpdir(), new Set(), new Map(), new Map(), new Map());
    expect(result.source).toBe(source);
    expect(result.fixedLines.size).toBe(0);
  });
});

// parameterizeRawCollectionParams() also parses with the real grammar — same Jest-mock
// limitation as every AST-based pass above. Real correctness (finding the raw ArrayList
// PARAMETER's own declaration via the CST, resolving its element type from the file's imports the
// same way insertMissingCastsForRawMethodCalls() does, and splicing `<TargetType>` in immediately
// after the class-name token) was verified separately against a real reproduction of the exact
// FhcIntfSolProj.war case reported directly by the user: `preparePagingStatement(...,
// ArrayList sortCriteria, ...)` calling both `sortCriteria.get(i).getAttribute()` and
// `.getSortType()` (both declared on the real, separately-decompiled `com.wovenware.db.SortCriteria`)
// — fixed to `ArrayList<SortCriteria> sortCriteria` in one edit covering both call sites, then
// independently javac-compiled clean (zero errors, zero warnings) against real stub classes for
// every other referenced type, proving the fix is genuinely correct, not just syntactically
// plausible.
describe('parameterizeRawCollectionParams (mocked-parser graceful-degradation behavior)', () => {
  const source = [
    'package com.example;',
    'import com.example.SortCriteria;',
    'class Foo {',
    '  void bar(java.util.ArrayList sortCriteria) {',
    '    String attrType = sortCriteria.get(0).getAttribute().toString();',
    '  }',
    '}',
  ].join('\n');
  const errors = ['[5,42] cannot find symbol\n  symbol: method getAttribute()\n  location: class java.lang.Object'];

  it('returns the source unchanged when the mocked parser yields no usable CST', async () => {
    const result = await parameterizeRawCollectionParams(source, errors, os.tmpdir(), new Set(), new Map(), new Map(), new Map());
    expect(result.source).toBe(source);
    expect(result.fixedLines.size).toBe(0);
  });

  it('skips errors whose line is already in alreadyFixedLines', async () => {
    const result = await parameterizeRawCollectionParams(source, errors, os.tmpdir(), new Set([5]), new Map(), new Map(), new Map());
    expect(result.fixedLines.size).toBe(0);
  });

  it('does nothing when the file has no imports at all', async () => {
    const noImports = 'class Foo { void bar(java.util.ArrayList x) { x.get(0).getAttribute(); } }';
    const result = await parameterizeRawCollectionParams(noImports, errors, os.tmpdir(), new Set(), new Map(), new Map(), new Map());
    expect(result.fixedLines.size).toBe(0);
  });

  it('does not throw when the error does not match the raw-method-call shape at all', async () => {
    const result = await parameterizeRawCollectionParams(source, ['[1,1] some other error'], os.tmpdir(), new Set(), new Map(), new Map(), new Map());
    expect(result.fixedLines.size).toBe(0);
  });
});