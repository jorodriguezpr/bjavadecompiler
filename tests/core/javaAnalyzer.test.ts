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
import { analyzeJavaFile } from '../../src/core/javaAnalyzer';
import { __resetParseCacheForTests } from '../../src/core/javaParser';
import { fakeClass, fakeCompilationUnit, fakePackageDecl } from '../helpers/fakeJavaCst';
import { NO_TOP_LEVEL_TYPE_MARKER, SYNTAX_ERROR_MARKER } from '../mocks/javaParserMock';

// Real java-parser can't load inside Jest (see jest.config.js's moduleNameMapper comment) — these
// tests exercise analyzeJavaFile()'s OWN diagnostic-selection logic against hand-built CST
// fixtures whose offsets are derived from the real source string (tests/helpers/fakeJavaCst.ts),
// not against the real grammar. The grammar shapes those fixtures mimic (classDeclaration,
// methodHeader.result, constructorDeclarator.simpleTypeName, etc.) were verified directly against
// node_modules/java-parser's own grammar source while building javaAnalyzer.ts, and the specific
// JEP-445/bare-fragment leniency this module guards against was additionally confirmed live
// against the real package outside Jest (see javaSyntaxCheck.ts's own history).
//
// jest.config.js's moduleNameMapper redirects `java-parser` to tests/mocks/javaParserMock.ts for
// every test file — parseJava() (src/core/javaParser.ts) calls straight into that mock here, so
// these tests drive analyzeJavaFile() by monkey-patching the mock's `parse` export per case
// rather than by relying on its fixed default fixture.

import * as javaParserMock from '../mocks/javaParserMock';

async function analyzeWithCst(cst: unknown, source: string, ctx?: Parameters<typeof analyzeJavaFile>[1]) {
  __resetParseCacheForTests();
  const spy = jest.spyOn(javaParserMock, 'parse').mockReturnValue(cst);
  try {
    return await analyzeJavaFile(source, ctx);
  } finally {
    spy.mockRestore();
  }
}

describe('analyzeJavaFile', () => {
  beforeEach(() => __resetParseCacheForTests());


  it('reports no diagnostics for a single non-public class with no members', async () => {
    const source = 'package com.example;\nclass Foo {}\n';
    const cst = fakeCompilationUnit({ packageDecl: fakePackageDecl(source, 'com.example'), classDecls: [fakeClass(source, { name: 'Foo' })] });
    const analysis = await analyzeWithCst(cst, source);
    expect(analysis.valid).toBe(true);
    expect(analysis.diagnostics).toEqual([]);
    expect(analysis.packageName).toBe('com.example');
    expect(analysis.types).toHaveLength(1);
    expect(analysis.types[0]).toMatchObject({ name: 'Foo', kind: 'class', isPublic: false });
  });

  it('reports JP1000_PARSE_ERROR and valid:false when the parser throws', async () => {
    const spy = jest.spyOn(javaParserMock, 'parse').mockImplementation(() => {
      throw new Error('boom');
    });
    try {
      const analysis = await analyzeJavaFile(`class Foo {} ${SYNTAX_ERROR_MARKER}`);
      expect(analysis.valid).toBe(false);
      expect(analysis.diagnostics).toHaveLength(1);
      expect(analysis.diagnostics[0].code).toBe('JP1000_PARSE_ERROR');
    } finally {
      spy.mockRestore();
    }
  });

  it('reports JST2001_MISSING_TOP_LEVEL_TYPE for a bare top-level declaration (JEP 445 leniency)', async () => {
    const analysis = await analyzeJavaFile(NO_TOP_LEVEL_TYPE_MARKER);
    expect(analysis.valid).toBe(false);
    expect(analysis.diagnostics.map(d => d.code)).toEqual(['JST2001_MISSING_TOP_LEVEL_TYPE']);
  });

  it('reports JST2002_PUBLIC_TYPE_FILENAME_MISMATCH when the sole public type does not match the filename', async () => {
    const source = 'package com.example;\npublic class Bar {\n  public Bar() {\n  }\n}\n';
    const cst = fakeCompilationUnit({
      packageDecl: fakePackageDecl(source, 'com.example'),
      classDecls: [fakeClass(source, { name: 'Bar', isPublic: true, members: [{ kind: 'constructor', name: 'Bar' }] })],
    });
    const filePath = path.join('project', 'com', 'example', 'Foo.java');
    const analysis = await analyzeWithCst(cst, source, { filePath });
    expect(analysis.valid).toBe(false);
    const diag = analysis.diagnostics.find(d => d.code === 'JST2002_PUBLIC_TYPE_FILENAME_MISMATCH');
    expect(diag).toBeDefined();
    expect(diag!.data?.expectedName).toBe('Foo');
    expect((diag!.data?.type as any).name).toBe('Bar');
  });

  it('does not report JST2002 when no filePath is given (old checkJavaSyntax()-style call)', async () => {
    const source = 'package com.example;\npublic class Bar {}\n';
    const cst = fakeCompilationUnit({ packageDecl: fakePackageDecl(source, 'com.example'), classDecls: [fakeClass(source, { name: 'Bar', isPublic: true })] });
    const analysis = await analyzeWithCst(cst, source);
    expect(analysis.valid).toBe(true);
    expect(analysis.diagnostics).toEqual([]);
  });

  it('reports JST2004_MULTIPLE_PUBLIC_TOP_LEVEL_TYPES for every extra public top-level type, keeping the one matching the filename', async () => {
    const source = 'package com.example;\npublic class Foo {}\npublic class Bar {}\n';
    const cst = fakeCompilationUnit({
      packageDecl: fakePackageDecl(source, 'com.example'),
      classDecls: [
        fakeClass(source, { name: 'Foo', isPublic: true }),
        fakeClass(source, { name: 'Bar', isPublic: true }, source.indexOf('public class Bar')),
      ],
    });
    const filePath = path.join('project', 'com', 'example', 'Foo.java');
    const analysis = await analyzeWithCst(cst, source, { filePath });
    expect(analysis.valid).toBe(false);
    const flagged = analysis.diagnostics.filter(d => d.code === 'JST2004_MULTIPLE_PUBLIC_TOP_LEVEL_TYPES');
    expect(flagged).toHaveLength(1);
    expect((flagged[0].data?.type as any).name).toBe('Bar');
    // JST2002 must NOT also fire for Bar here — de-publicizing, not renaming, is the right fix
    // once there's more than one public top-level type (see javaFixer.ts's own module comment).
    expect(analysis.diagnostics.some(d => d.code === 'JST2002_PUBLIC_TYPE_FILENAME_MISMATCH')).toBe(false);
  });

  it('reports JST2003_PACKAGE_DIR_MISMATCH when the package statement does not match the directory', async () => {
    const source = 'package com.wrong;\nclass Foo {}\n';
    const cst = fakeCompilationUnit({ packageDecl: fakePackageDecl(source, 'com.wrong'), classDecls: [fakeClass(source, { name: 'Foo' })] });
    const filePath = path.join('root', 'com', 'example', 'Foo.java');
    const projectSourceRoot = 'root';
    const analysis = await analyzeWithCst(cst, source, { filePath, projectSourceRoot });
    expect(analysis.valid).toBe(false);
    const diag = analysis.diagnostics.find(d => d.code === 'JST2003_PACKAGE_DIR_MISMATCH');
    expect(diag).toBeDefined();
    expect(diag!.data).toMatchObject({ actual: 'com.wrong', expected: 'com.example' });
  });

  it('reports JMB3003_METHOD_LOOKS_LIKE_CTOR (warning-only — file stays valid) for a same-named method with a return type', async () => {
    const source = 'package com.example;\nclass Foo {\n  void Foo() {\n  }\n}\n';
    const cst = fakeCompilationUnit({
      packageDecl: fakePackageDecl(source, 'com.example'),
      classDecls: [fakeClass(source, { name: 'Foo', members: [{ kind: 'method', name: 'Foo', returnTypeText: 'void' }] })],
    });
    const analysis = await analyzeWithCst(cst, source);
    expect(analysis.valid).toBe(true); // warning severity — doesn't block "valid"
    const diag = analysis.diagnostics.find(d => d.code === 'JMB3003_METHOD_LOOKS_LIKE_CTOR');
    expect(diag).toBeDefined();
    expect(diag!.severity).toBe('warning');
    expect((diag!.data?.member as any).name).toBe('Foo');
  });

  it('does not report JMB3003 for a real constructor (no result/return type)', async () => {
    const source = 'package com.example;\nclass Foo {\n  Foo() {\n  }\n}\n';
    const cst = fakeCompilationUnit({
      packageDecl: fakePackageDecl(source, 'com.example'),
      classDecls: [fakeClass(source, { name: 'Foo', members: [{ kind: 'constructor', name: 'Foo' }] })],
    });
    const analysis = await analyzeWithCst(cst, source);
    expect(analysis.valid).toBe(true);
    expect(analysis.diagnostics).toEqual([]);
  });
});
