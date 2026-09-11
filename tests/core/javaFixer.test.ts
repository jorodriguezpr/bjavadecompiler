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

import path from 'path';
import { fixJavaFile } from '../../src/core/javaFixer';
import { __resetParseCacheForTests } from '../../src/core/javaParser';
import { fakeClass, fakeCompilationUnit, fakePackageDecl } from '../helpers/fakeJavaCst';
import * as javaParserMock from '../mocks/javaParserMock';

// fixJavaFile() re-analyzes its OWN edited output before accepting a fix, i.e. it calls
// parseJava() a second time with the ALREADY-FIXED text. Since the mock can't run the real
// grammar (see javaAnalyzer.test.ts's header comment for why), each test below dispatches the
// mock's `parse` on the CURRENT source text: a `when(source)` predicate checks whether the
// original broken substring is still present, so the first call (unedited) resolves to the
// "before" fixture and the second call (post-edit) resolves to the "after" one — a real signal
// derived from applyEdits()'s actual, deterministic text surgery, not an artificial marker.
function mockParseSequence(pairs: Array<{ when: (source: string) => boolean; cst: unknown }>) {
  __resetParseCacheForTests();
  const spy = jest.spyOn(javaParserMock, 'parse').mockImplementation((source: string) => {
    const hit = pairs.find(p => p.when(source));
    if (!hit) throw new Error(`test fixture gap: no matching mock CST for source:\n${source}`);
    return hit.cst;
  });
  return () => spy.mockRestore();
}

describe('fixJavaFile', () => {
  afterEach(() => jest.restoreAllMocks());

  it('returns the source unchanged when there is nothing fixable', async () => {
    const source = 'package com.example;\nclass Foo {}\n';
    mockParseSequence([{ when: () => true, cst: fakeCompilationUnit({ packageDecl: fakePackageDecl(source, 'com.example'), classDecls: [fakeClass(source, { name: 'Foo' })] }) }]);
    const result = await fixJavaFile(source, { filePath: path.join('p', 'Foo.java') });
    expect(result.changed).toBe(false);
    expect(result.source).toBe(source);
    expect(result.applied).toEqual([]);
  });

  it('JST2002: renames the mismatched public type and its constructor to match the filename', async () => {
    const before = 'package com.example;\npublic class Bar {\n  public Bar() {\n  }\n}\n';
    const after = 'package com.example;\npublic class Foo {\n  public Foo() {\n  }\n}\n';
    const beforeCst = fakeCompilationUnit({
      packageDecl: fakePackageDecl(before, 'com.example'),
      classDecls: [fakeClass(before, { name: 'Bar', isPublic: true, members: [{ kind: 'constructor', name: 'Bar' }] })],
    });
    const afterCst = fakeCompilationUnit({
      packageDecl: fakePackageDecl(after, 'com.example'),
      classDecls: [fakeClass(after, { name: 'Foo', isPublic: true, members: [{ kind: 'constructor', name: 'Foo' }] })],
    });
    mockParseSequence([
      { when: s => s.includes('class Bar'), cst: beforeCst },
      { when: s => s.includes('class Foo'), cst: afterCst },
    ]);

    const result = await fixJavaFile(before, { filePath: path.join('p', 'com', 'example', 'Foo.java') });
    expect(result.changed).toBe(true);
    expect(result.applied).toEqual(['JST2002_PUBLIC_TYPE_FILENAME_MISMATCH']);
    expect(result.source).not.toMatch(/\bBar\b/);
    expect(result.source).toContain('public class Foo');
    expect(result.source).toContain('public Foo()');
    expect(result.analysis.valid).toBe(true);
  });

  it('JST2004: strips public from the extra top-level type, keeping the one matching the filename', async () => {
    const before = 'package com.example;\npublic class Foo {}\npublic class Bar {}\n';
    const after = 'package com.example;\npublic class Foo {}\nclass Bar {}\n';
    const beforeCst = fakeCompilationUnit({
      packageDecl: fakePackageDecl(before, 'com.example'),
      classDecls: [
        fakeClass(before, { name: 'Foo', isPublic: true }),
        fakeClass(before, { name: 'Bar', isPublic: true }, before.indexOf('public class Bar')),
      ],
    });
    const afterCst = fakeCompilationUnit({
      packageDecl: fakePackageDecl(after, 'com.example'),
      classDecls: [
        fakeClass(after, { name: 'Foo', isPublic: true }),
        fakeClass(after, { name: 'Bar', isPublic: false }, after.indexOf('class Bar')),
      ],
    });
    mockParseSequence([
      { when: s => s.includes('public class Bar'), cst: beforeCst },
      { when: s => !s.includes('public class Bar'), cst: afterCst },
    ]);

    const result = await fixJavaFile(before, { filePath: path.join('p', 'com', 'example', 'Foo.java') });
    expect(result.changed).toBe(true);
    expect(result.applied).toEqual(['JST2004_MULTIPLE_PUBLIC_TOP_LEVEL_TYPES']);
    expect(result.source).toContain('public class Foo');
    expect(result.source).toContain('\nclass Bar {}');
    expect(result.analysis.valid).toBe(true);
  });

  it('JST2003: rewrites the package statement to match the directory', async () => {
    const before = 'package com.wrong;\nclass Foo {}\n';
    const after = 'package com.example;\nclass Foo {}\n';
    const beforeCst = fakeCompilationUnit({ packageDecl: fakePackageDecl(before, 'com.wrong'), classDecls: [fakeClass(before, { name: 'Foo' })] });
    const afterCst = fakeCompilationUnit({ packageDecl: fakePackageDecl(after, 'com.example'), classDecls: [fakeClass(after, { name: 'Foo' })] });
    mockParseSequence([
      { when: s => s.includes('com.wrong'), cst: beforeCst },
      { when: s => s.includes('com.example'), cst: afterCst },
    ]);

    const filePath = path.join('root', 'com', 'example', 'Foo.java');
    const result = await fixJavaFile(before, { filePath, projectSourceRoot: 'root' });
    expect(result.changed).toBe(true);
    expect(result.applied).toEqual(['JST2003_PACKAGE_DIR_MISMATCH']);
    expect(result.source).toBe(after);
    expect(result.analysis.valid).toBe(true);
  });

  it('JMB3003: deletes the return type, turning a mis-decompiled method back into a real constructor', async () => {
    const before = 'package com.example;\nclass Foo {\n  void Foo() {\n  }\n}\n';
    const after = 'package com.example;\nclass Foo {\n  Foo() {\n  }\n}\n';
    const beforeCst = fakeCompilationUnit({
      packageDecl: fakePackageDecl(before, 'com.example'),
      classDecls: [fakeClass(before, { name: 'Foo', members: [{ kind: 'method', name: 'Foo', returnTypeText: 'void' }] })],
    });
    const afterCst = fakeCompilationUnit({
      packageDecl: fakePackageDecl(after, 'com.example'),
      classDecls: [fakeClass(after, { name: 'Foo', members: [{ kind: 'constructor', name: 'Foo' }] })],
    });
    mockParseSequence([
      { when: s => s.includes('void Foo'), cst: beforeCst },
      { when: s => !s.includes('void Foo'), cst: afterCst },
    ]);

    const result = await fixJavaFile(before);
    expect(result.changed).toBe(true);
    expect(result.applied).toEqual(['JMB3003_METHOD_LOOKS_LIKE_CTOR']);
    expect(result.source).toBe(after);
    expect(result.analysis.valid).toBe(true);
  });

  it('JMB3003: leaves the file unchanged when converting would collide with an existing constructor of the same signature', async () => {
    const source = 'package com.example;\nclass Foo {\n  Foo() {\n  }\n  void Foo() {\n  }\n}\n';
    const cst = fakeCompilationUnit({
      packageDecl: fakePackageDecl(source, 'com.example'),
      classDecls: [fakeClass(source, {
        name: 'Foo',
        members: [
          { kind: 'constructor', name: 'Foo' },
          { kind: 'method', name: 'Foo', returnTypeText: 'void' },
        ],
      })],
    });
    mockParseSequence([{ when: () => true, cst }]);

    const result = await fixJavaFile(source);
    expect(result.changed).toBe(false);
    expect(result.source).toBe(source);
    expect(result.applied).toEqual([]);
  });

  it('JST2001: wraps a bare top-level declaration in a class named after the file', async () => {
    const before = 'package com.example;\n\npublic void find() {\n}\n';
    const beforeCst = {
      children: {
        ordinaryCompilationUnit: [{
          children: {
            packageDeclaration: [fakePackageDecl(before, 'com.example')],
            typeDeclaration: [{ children: { methodDeclaration: [{}] } }],
          },
        }],
      },
    };
    const after = fixJavaFileExpectedWrap(before, 'com.example', 'Foo');
    const afterCst = fakeCompilationUnit({
      packageDecl: fakePackageDecl(after, 'com.example'),
      classDecls: [fakeClass(after, { name: 'Foo', isPublic: true })],
    });
    mockParseSequence([
      { when: s => s.includes('public class Foo'), cst: afterCst },
      { when: () => true, cst: beforeCst },
    ]);

    const result = await fixJavaFile(before, { filePath: path.join('p', 'com', 'example', 'Foo.java') });
    expect(result.changed).toBe(true);
    expect(result.applied).toEqual(['JST2001_MISSING_TOP_LEVEL_TYPE']);
    expect(result.source).toContain('public class Foo {');
    expect(result.source).toContain('public void find() {');
    expect(result.analysis.valid).toBe(true);
  });
});

/** Mirrors javaFixer.ts's own wrapBareDeclarationsInClass() text shape exactly, so the JST2001
 * test's "after" fixture is built from the SAME text the real fixer will actually produce. */
function fixJavaFileExpectedWrap(source: string, _pkg: string, className: string): string {
  const insertFrom = source.indexOf(';') + 1; // right after "package com.example;"
  const head = source.slice(0, insertFrom);
  const body = source.slice(insertFrom);
  return `${head}\npublic class ${className} {\n${body}\n}\n`;
}
