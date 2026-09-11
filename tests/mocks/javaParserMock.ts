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

/**
 * Test-only stand-in for the real `java-parser` package (see jest.config.js's moduleNameMapper
 * for why: chevrotain, one of java-parser's own dependencies, has no CommonJS export condition
 * at all, so Jest's module system can never load the real grammar, transformed or not). This
 * mock exists to exercise javaSyntaxCheck.ts's/javaAnalyzer.ts's own wrapping/analysis logic and
 * candidateScoringService.ts's use of the valid/invalid result — not to reimplement the Java
 * grammar. Tests that need a specific outcome mark it explicitly with the SYNTAX_ERROR_MARKER (or
 * NO_TOP_LEVEL_TYPE_MARKER) comment rather than relying on this mock to actually understand Java
 * syntax.
 */

import { fakeClass, fakeCompilationUnit, fakePackageDecl } from '../helpers/fakeJavaCst';

export const SYNTAX_ERROR_MARKER = '/* MOCK_SYNTAX_ERROR */';

/** Simulates java-parser's real (confirmed live) leniency: its `compilationUnit` grammar accepts
 * a JEP 445 "implicitly declared class" — bare top-level method/field declarations with no
 * wrapping class/interface — as a strict grammar superset. javaAnalyzer.ts's structural checks
 * exist specifically to reject that case, so this marker gives tests a way to simulate "parser
 * succeeded, but there's no real top-level type" without needing the real grammar. */
export const NO_TOP_LEVEL_TYPE_MARKER = '/* MOCK_NO_TOP_LEVEL_TYPE */';

/** Every non-marked call returns a CST for exactly this string — a single non-public, empty,
 * name-mismatch-free class, which javaAnalyzer.ts's checks can never flag (no diagnostic code in
 * javaAnalyzer.ts fires for a lone non-public type with no members, regardless of what the real
 * caller's own source string was), so it's a safe universal "parses fine" stand-in for every
 * caller in the suite — none of which ever passes an AnalyzeContext (checkJavaSyntax() never
 * forwards one), so the filename/package/multi-public-type checks that DO depend on the real
 * source/path are simply unreachable through this mock either way. */
const REAL_CLASS_SOURCE = 'package com.example;\nclass Foo {}\n';
const REAL_CLASS_CST = fakeCompilationUnit({
  packageDecl: fakePackageDecl(REAL_CLASS_SOURCE, 'com.example'),
  classDecls: [fakeClass(REAL_CLASS_SOURCE, { name: 'Foo' })],
});

const BARE_FRAGMENT_CST = {
  children: {
    ordinaryCompilationUnit: [{
      children: { typeDeclaration: [{ children: { methodDeclaration: [{}] } }] },
    }],
  },
};

export function parse(source: string): unknown {
  if (source.includes(SYNTAX_ERROR_MARKER)) {
    throw new Error('Mock parser: SYNTAX_ERROR_MARKER present — simulated parse failure.');
  }
  if (source.includes(NO_TOP_LEVEL_TYPE_MARKER)) {
    return BARE_FRAGMENT_CST;
  }
  return REAL_CLASS_CST;
}
