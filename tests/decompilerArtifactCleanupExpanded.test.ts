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

import {
  stripDuplicateJumpStatements,
  stripSyntheticAccessors,
  stripUnreferencedLabels,
  stripRedundantCasts,
  stripTrailingWhitespace,
  cleanSource,
} from '../src/services/decompilerArtifactCleanup';

describe('stripSyntheticAccessors', () => {
  it('removes a simple field-get accessor method', () => {
    const source = [
      'class Foo {',
      '  private int x;',
      '  static int access$000(Foo obj) { return obj.x; }',
      '  void bar() {}',
      '}',
    ].join('\n');

    const { fixed, removed } = stripSyntheticAccessors(source);
    expect(removed).toBe(1);
    expect(fixed).not.toContain('access$000');
    expect(fixed).toContain('void bar() {}');
  });

  it('removes a field-set accessor method', () => {
    const source = [
      'class Foo {',
      '  private int x;',
      '  static void access$002(Foo obj, int val) { obj.x = val; }',
      '  void bar() {}',
      '}',
    ].join('\n');

    const { fixed, removed } = stripSyntheticAccessors(source);
    expect(removed).toBe(1);
    expect(fixed).not.toContain('access$002');
  });

  it('does not remove a method that just happens to match the naming pattern but is large', () => {
    const longBody = Array.from({ length: 10 }, (_, i) => `  int y${i} = ${i};`).join('\n');
    const source = [
      'class Foo {',
      '  static int access$999(Foo obj) {',
      longBody,
      '  return obj.x;',
      '  }',
      '}',
    ].join('\n');

    const { removed } = stripSyntheticAccessors(source);
    expect(removed).toBe(0);
  });

  it('removes multiple accessor methods', () => {
    const source = [
      'class Foo {',
      '  private int x;',
      '  private String y;',
      '  static int access$000(Foo obj) { return obj.x; }',
      '  static String access$001(Foo obj) { return obj.y; }',
      '}',
    ].join('\n');

    const { removed } = stripSyntheticAccessors(source);
    expect(removed).toBe(2);
  });
});

describe('stripUnreferencedLabels', () => {
  it('removes a label that is never referenced', () => {
    const source = [
      'class Foo {',
      '  void bar() {',
      '    label123: ;',
      '    int x = 1;',
      '  }',
      '}',
    ].join('\n');

    const { fixed, removed } = stripUnreferencedLabels(source);
    expect(removed).toBe(1);
    expect(fixed).not.toContain('label123:');
  });

  it('does not remove a label that is referenced by break', () => {
    const source = [
      'class Foo {',
      '  void bar() {',
      '    label123:',
      '    for (int i = 0; i < 10; i++) {',
      '      if (i == 5) break label123;',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const { removed } = stripUnreferencedLabels(source);
    expect(removed).toBe(0);
  });

  it('does not remove a label that is referenced by continue', () => {
    const source = [
      'class Foo {',
      '  void bar() {',
      '    label456:',
      '    for (int i = 0; i < 10; i++) {',
      '      for (int j = 0; j < 10; j++) {',
      '        if (j == 5) continue label456;',
      '      }',
      '    }',
      '  }',
      '}',
    ].join('\n');

    const { removed } = stripUnreferencedLabels(source);
    expect(removed).toBe(0);
  });

  it('handles source with no labels', () => {
    const source = 'class Foo { void bar() {} }';
    const { fixed, removed } = stripUnreferencedLabels(source);
    expect(removed).toBe(0);
    expect(fixed).toBe(source);
  });
});

describe('stripRedundantCasts', () => {
  it('removes a cast when the variable is declared as the same type', () => {
    const source = [
      'class Foo {',
      '  void bar() {',
      '    String str = "hello";',
      '    String s = (String) str;',
      '  }',
      '}',
    ].join('\n');

    const { fixed, removed } = stripRedundantCasts(source);
    expect(removed).toBe(1);
    expect(fixed).not.toContain('(String) str');
    expect(fixed).toContain('String s = str');
  });

  it('does not remove a cast when the variable is declared as a different type', () => {
    const source = [
      'class Foo {',
      '  void bar() {',
      '    Object obj = "hello";',
      '    String s = (String) obj;',
      '  }',
      '}',
    ].join('\n');

    const { removed } = stripRedundantCasts(source);
    expect(removed).toBe(0);
  });

  it('handles source with no casts', () => {
    const source = 'class Foo { void bar() { int x = 1; } }';
    const { removed } = stripRedundantCasts(source);
    expect(removed).toBe(0);
  });
});

describe('stripTrailingWhitespace', () => {
  it('removes trailing spaces from lines', () => {
    const source = 'class Foo {   \n  void bar() {  \n  }  \n}';
    const { fixed, removed } = stripTrailingWhitespace(source);
    // 3 lines have trailing whitespace (the last line `}` has none)
    expect(removed).toBe(3);
    expect(fixed).toBe('class Foo {\n  void bar() {\n  }\n}');
  });

  it('leaves clean source untouched', () => {
    const source = 'class Foo {\n  void bar() {\n  }\n}';
    const { removed } = stripTrailingWhitespace(source);
    expect(removed).toBe(0);
  });
});

describe('cleanSource', () => {
  it('applies multiple passes and reports total fixes', () => {
    const source = [
      'class Foo {   ',
      '  private int x;',
      '  static int access$000(Foo obj) { return obj.x; }',
      '  void bar() {',
      '    break;',
      '    break;',
      '    label999: ;',
      '  }',
      '}',
    ].join('\n');

    const { fixed, totalFixes } = cleanSource(source);
    expect(totalFixes).toBeGreaterThan(0);
    expect(fixed).not.toContain('access$000');
    expect(fixed).not.toContain('label999');
    // Duplicate break should be collapsed
    const breakCount = (fixed.match(/break;/g) || []).length;
    expect(breakCount).toBe(1);
  });

  it('leaves clean source untouched', () => {
    const source = 'class Foo {\n  void bar() {\n    int x = 1;\n  }\n}\n';
    const { totalFixes } = cleanSource(source);
    expect(totalFixes).toBe(0);
  });
});