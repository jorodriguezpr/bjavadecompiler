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

import { checkJavaSyntax } from '../src/core/javaSyntaxCheck';
import { SYNTAX_ERROR_MARKER, NO_TOP_LEVEL_TYPE_MARKER } from './mocks/javaParserMock';

// Uses tests/mocks/javaParserMock.ts (see jest.config.js) in place of the real java-parser
// package — this suite verifies checkJavaSyntax's own try/catch/result-shape logic, not the
// real Java grammar (which was verified live, outside Jest, against a real broken decompiled
// file from this session — see project memory).
describe('checkJavaSyntax', () => {
  it('reports valid: true and no error for source the parser accepts', async () => {
    const result = await checkJavaSyntax('package com.example;\nclass Foo {}\n');
    expect(result.valid).toBe(true);
    expect(result.error).toBeUndefined();
  });

  it('reports valid: false with a truncated error message when the parser throws', async () => {
    const result = await checkJavaSyntax(`class Foo {} ${SYNTAX_ERROR_MARKER}`);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
    expect(result.error!.length).toBeLessThanOrEqual(400);
  });

  // Regression: java-parser's real grammar accepts a JEP 445 "implicitly declared class" — bare
  // top-level method/field declarations with no wrapping class — as a strict superset of normal
  // Java (confirmed live: `parse("public ArrayList<String> find() { return null; }")` throws no
  // error). Before this check existed, an AI reconstruction call that returned just the one
  // method it "fixed" instead of the whole file would pass checkJavaSyntax and get written to
  // disk, producing real javac "class, interface, or enum expected" errors downstream.
  it('reports valid: false for a parse that only succeeded via a bare top-level declaration (no class/interface)', async () => {
    const result = await checkJavaSyntax(`public void find() {} ${NO_TOP_LEVEL_TYPE_MARKER}`);
    expect(result.valid).toBe(false);
    expect(result.error).toBeDefined();
  });
});
