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

import { parseErrors, parseBrokenArtifacts } from '../src/services/mavenVerifyService';

describe('parseErrors', () => {
  it('groups [ERROR] lines by file', () => {
    const output = [
      '[INFO] Compiling 3 source files',
      '[ERROR] /proj/src/main/java/com/example/Foo.java:[12,34] cannot find symbol',
      '[ERROR] /proj/src/main/java/com/example/Foo.java:[15,10] incompatible types',
      '[ERROR] /proj/src/main/java/com/example/Bar.java:[3,1] class, interface, or enum expected',
      '[INFO] BUILD FAILURE',
    ].join('\n');

    const result = parseErrors(output);

    expect(Object.keys(result)).toHaveLength(2);
    expect(result['/proj/src/main/java/com/example/Foo.java']).toHaveLength(2);
    expect(result['/proj/src/main/java/com/example/Foo.java'][0]).toContain('cannot find symbol');
    expect(result['/proj/src/main/java/com/example/Bar.java']).toHaveLength(1);
  });

  it('returns an empty object when there are no [ERROR] lines', () => {
    expect(parseErrors('[INFO] BUILD SUCCESS')).toEqual({});
  });

  it('ignores [ERROR] lines that are not the file:[line,col] shape', () => {
    const output = '[ERROR] Failed to execute goal org.apache.maven.plugins:maven-compiler-plugin';
    expect(parseErrors(output)).toEqual({});
  });

  it('strips a leading slash Maven prepends before a Windows drive letter', () => {
    const output = '[ERROR] /C:/PhpProjects/BJavaDecompiler/data/workspaces/abc/project/lib-src/Foo.java:[258,142] illegal start of expression';
    const result = parseErrors(output);
    expect(Object.keys(result)).toEqual(['C:/PhpProjects/BJavaDecompiler/data/workspaces/abc/project/lib-src/Foo.java']);
  });

  it('leaves a lowercase drive letter path\'s leading slash stripped too', () => {
    const output = '[ERROR] /c:/PhpProjects/BJavaDecompiler/data/workspaces/abc/project/lib-src/Foo.java:[1,1] error';
    const result = parseErrors(output);
    expect(Object.keys(result)).toEqual(['c:/PhpProjects/BJavaDecompiler/data/workspaces/abc/project/lib-src/Foo.java']);
  });

  it('appends javac\'s symbol/location continuation lines to the error they follow (real mvn compile shape, no [ERROR] prefix)', () => {
    // Confirmed live via a real `mvn compile` against a genuine missing-symbol case: javac's
    // continuation lines have NO [ERROR] prefix at all, just plain indented text — these were
    // previously silently dropped, meaning the actual missing type name never reached
    // deterministicRemediationService.ts's or aiRemediationService.ts's error text.
    const output = [
      '[ERROR] COMPILATION ERROR : ',
      '[ERROR] /proj/src/main/java/Test2.java:[3,9] cannot find symbol',
      '  symbol:   class Foo',
      '  location: class Test2',
      '[ERROR] /proj/src/main/java/Test2.java:[3,21] cannot find symbol',
      '  symbol:   class Foo',
      '  location: class Test2',
    ].join('\n');

    const result = parseErrors(output);

    expect(result['/proj/src/main/java/Test2.java']).toEqual([
      '[3,9] cannot find symbol\n  symbol: class Foo\n  location: class Test2',
      '[3,21] cannot find symbol\n  symbol: class Foo\n  location: class Test2',
    ]);
  });

  it('does not attribute a continuation-shaped line to a non-adjacent earlier error', () => {
    const output = [
      '[ERROR] /proj/src/main/java/Foo.java:[1,1] cannot find symbol',
      '[INFO] some unrelated line in between',
      '  symbol:   class Bar',
    ].join('\n');

    const result = parseErrors(output);

    expect(result['/proj/src/main/java/Foo.java']).toEqual(['[1,1] cannot find symbol']);
  });

  it('does not choke on a continuation-shaped line with no preceding error at all', () => {
    const output = '  symbol:   class Foo';
    expect(parseErrors(output)).toEqual({});
  });

  it('also handles the final-build-summary shape, where continuation lines DO carry an [ERROR] prefix', () => {
    // Confirmed live: a real `mvn compile` prints its full error list twice — once inline (no
    // [ERROR] prefix on continuations, covered by the test above) and again in the final build
    // summary, where continuations DO get an [ERROR] prefix. Both shapes occur in real output.
    const output = [
      '[ERROR] /proj/src/main/java/Foo.java:[422,43] cannot find symbol',
      '[ERROR]   symbol:   method getAttribute()',
      '[ERROR]   location: class java.lang.Object',
    ].join('\n');

    const result = parseErrors(output);

    expect(result['/proj/src/main/java/Foo.java']).toEqual([
      '[422,43] cannot find symbol\n  symbol: method getAttribute()\n  location: class java.lang.Object',
    ]);
  });

  it('collapses Maven\'s whole-list double-print (inline block + final summary block) to one entry per real error', () => {
    // Confirmed live against a real 19MB WAR: a single `mvn compile` run prints its complete
    // error list twice (inline as errors are found, then again in the failure summary), so
    // errorCount/errorsByFile were silently 2x every real number this project ever reported
    // (632->564 was actually 316->282 unique). Both blocks carry byte-identical text per error.
    const output = [
      '[ERROR] COMPILATION ERROR : ',
      '[ERROR] /proj/src/main/java/Foo.java:[3,9] cannot find symbol',
      '  symbol:   class Bar',
      '  location: class Foo',
      '[ERROR] /proj/src/main/java/Other.java:[7,2] class, interface, or enum expected',
      '[INFO] BUILD FAILURE',
      '[ERROR] Failed to execute goal ... Compilation failure',
      '[ERROR] /proj/src/main/java/Foo.java:[3,9] cannot find symbol',
      '[ERROR]   symbol:   class Bar',
      '[ERROR]   location: class Foo',
      '[ERROR] /proj/src/main/java/Other.java:[7,2] class, interface, or enum expected',
    ].join('\n');

    const result = parseErrors(output);

    expect(result['/proj/src/main/java/Foo.java']).toEqual([
      '[3,9] cannot find symbol\n  symbol: class Bar\n  location: class Foo',
    ]);
    expect(result['/proj/src/main/java/Other.java']).toEqual([
      '[7,2] class, interface, or enum expected',
    ]);
  });

  it('keeps two genuinely distinct errors at different locations in the same file, even with a shared message', () => {
    const output = [
      '[ERROR] /proj/src/main/java/Foo.java:[3,9] cannot find symbol',
      '[ERROR] /proj/src/main/java/Foo.java:[40,1] cannot find symbol',
    ].join('\n');

    const result = parseErrors(output);

    expect(result['/proj/src/main/java/Foo.java']).toEqual([
      '[3,9] cannot find symbol',
      '[40,1] cannot find symbol',
    ]);
  });
});

describe('parseBrokenArtifacts', () => {
  it('matches "Failed to read artifact descriptor for" (broken upstream POM shape)', () => {
    const output = '[ERROR] Failed to read artifact descriptor for org.foo:bar:jar:1.2.3';
    expect(parseBrokenArtifacts(output)).toEqual([{ groupId: 'org.foo', artifactId: 'bar' }]);
  });

  it('matches a bare "was not found in" line (dead SHA-1-matched coordinate shape)', () => {
    const output = '[ERROR] org.foo:bar:jar:1.2.3 was not found in https://repo.maven.apache.org/maven2';
    expect(parseBrokenArtifacts(output)).toEqual([{ groupId: 'org.foo', artifactId: 'bar' }]);
  });

  it('matches "Could not find artifact ... in central" (pre-Central relocation-hint shape)', () => {
    const output = '[ERROR] Could not find artifact org.foo:bar:jar:1.2.3 in central (https://repo.maven.apache.org/maven2), try downloading from http://example.com';
    expect(parseBrokenArtifacts(output)).toEqual([{ groupId: 'org.foo', artifactId: 'bar' }]);
  });

  it('extracts every artifact from mvn -q\'s condensed "could not be resolved" summary line (real NetBeans/commons-email case)', () => {
    // Confirmed live: `mvn -q -DskipTests compile` (what verifyBuild() always runs) collapses a
    // dependency-resolution failure onto ONE line, with the artifact coordinate NOT at the start
    // (unlike every other shape above) and potentially listing SEVERAL broken artifacts at once.
    const output = '[ERROR] Failed to execute goal on project fhcintfsolproj: Could not resolve dependencies for project com.wovenware:fhcintfsolproj:war:1.0.0: The following artifacts could not be resolved: javax.mail:mail:jar:1.3.3 (absent), javax.activation:activation:jar:1.0.2 (absent): javax.mail:mail:jar:1.3.3 was not found in https://repo.maven.apache.org/maven2 during a previous attempt. This failure was cached in the local repository and resolution is not reattempted until the update interval of central has elapsed or updates are forced -> [Help 1]';

    const result = parseBrokenArtifacts(output);

    expect(result).toEqual([
      { groupId: 'javax.mail', artifactId: 'mail' },
      { groupId: 'javax.activation', artifactId: 'activation' },
    ]);
  });

  it('handles the condensed summary shape with only a single broken artifact', () => {
    const output = '[ERROR] Failed to execute goal on project foo: Could not resolve dependencies for project com.example:foo:war:1.0.0: The following artifacts could not be resolved: org.foo:bar:jar:1.2.3 (absent): org.foo:bar:jar:1.2.3 was not found in https://repo.maven.apache.org/maven2 during a previous attempt. -> [Help 1]';
    expect(parseBrokenArtifacts(output)).toEqual([{ groupId: 'org.foo', artifactId: 'bar' }]);
  });

  it('dedupes the same artifact reported by multiple lines/shapes', () => {
    const output = [
      '[ERROR] Failed to execute goal on project foo: Could not resolve dependencies for project com.example:foo:war:1.0.0: The following artifacts could not be resolved: org.foo:bar:jar:1.2.3 (absent): org.foo:bar:jar:1.2.3 was not found in https://repo.maven.apache.org/maven2 during a previous attempt. -> [Help 1]',
      '[ERROR] org.foo:bar:jar:1.2.3 was not found in https://repo.maven.apache.org/maven2',
    ].join('\n');
    expect(parseBrokenArtifacts(output)).toEqual([{ groupId: 'org.foo', artifactId: 'bar' }]);
  });

  it('returns an empty array on a clean build', () => {
    expect(parseBrokenArtifacts('[INFO] BUILD SUCCESS')).toEqual([]);
  });
});
