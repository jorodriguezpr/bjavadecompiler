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
 * BJavaDecompiler - single cached `java-parser` loader, shared by javaSyntaxCheck.ts and
 * javaAnalyzer.ts.
 *
 * java-parser is ESM-only (no CJS build), and one of ITS OWN dependencies (chevrotain) has no
 * CommonJS export condition at all — Jest's CJS-oriented module system can never load it, even
 * transformed (see jest.config.js's moduleNameMapper, which swaps in
 * tests/mocks/javaParserMock.ts instead). Outside Jest, a cached dynamic `import()` works fine
 * from this CJS codebase under both ts-node and compiled Node, unlike a static `import`.
 *
 * deterministicRemediationService.ts keeps its own separate copy of this same loader — left as
 * its own private copy for now rather than migrated to this one, to avoid touching an already-
 * tested, unrelated file as a side effect of this change.
 */

let parseFn: ((source: string) => any) | null = null;

export async function parseJava(source: string): Promise<any> {
  if (!parseFn) {
    const mod = await import('java-parser');
    parseFn = mod.parse;
  }
  return parseFn(source);
}

/** Test-only escape hatch: forces the next parseJava() call to re-import (and hence re-capture
 * whatever `java-parser`'s mocked `parse` export currently is) instead of reusing the cached
 * function reference from an earlier test in the same file — jest.spyOn()/mockRestore() on the
 * mock's `parse` export only take effect for tests that run BEFORE the first real capture unless
 * this is called between them. Never used outside tests/. */
export function __resetParseCacheForTests(): void {
  parseFn = null;
}
