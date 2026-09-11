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
import { stripDuplicateJumpStatements, cleanKnownDecompilerArtifacts } from '../src/services/decompilerArtifactCleanup';

describe('stripDuplicateJumpStatements', () => {
  it('collapses a duplicated break; down to one', () => {
    const source = [
      'switch (x) {',
      '  case 1:',
      '    doThing();',
      '    break;',
      '    break;',
      '  default:',
      '    break;',
      '}',
    ].join('\n');

    const { fixed, removed } = stripDuplicateJumpStatements(source);

    expect(removed).toBe(1);
    expect(fixed).not.toMatch(/break;\s*\n\s*break;/);
    expect((fixed.match(/break;/g) || []).length).toBe(2); // one real, one for default
  });

  it('collapses a run of 3+ duplicates down to one', () => {
    const source = 'break;\nbreak;\nbreak;\n';
    const { fixed, removed } = stripDuplicateJumpStatements(source);
    expect(removed).toBe(2);
    expect(fixed).toBe('break;\n');
  });

  it('handles duplicated labeled continue and identical return statements', () => {
    const continueSrc = 'continue outer;\ncontinue outer;\n';
    expect(stripDuplicateJumpStatements(continueSrc).removed).toBe(1);

    const returnSrc = 'return foo();\nreturn foo();\n';
    expect(stripDuplicateJumpStatements(returnSrc).removed).toBe(1);
  });

  it('does not touch two independent break statements separated by other code', () => {
    const source = [
      'case 1:',
      '  break;',
      'case 2:',
      '  break;',
    ].join('\n');
    const { removed } = stripDuplicateJumpStatements(source);
    expect(removed).toBe(0);
  });

  it('does not collapse duplicates separated by a blank line', () => {
    const source = 'break;\n\nbreak;\n';
    const { removed } = stripDuplicateJumpStatements(source);
    expect(removed).toBe(0);
  });

  it('leaves clean source untouched', () => {
    const source = 'class Foo {\n  void bar() {\n    return;\n  }\n}\n';
    const { fixed, removed } = stripDuplicateJumpStatements(source);
    expect(removed).toBe(0);
    expect(fixed).toBe(source);
  });
});

describe('cleanKnownDecompilerArtifacts', () => {
  it('fixes files in place across a directory tree and reports the count', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bjd-cleanup-'));
    const brokenFile = path.join(dir, 'com', 'example', 'Foo.java');
    fs.mkdirSync(path.dirname(brokenFile), { recursive: true });
    fs.writeFileSync(brokenFile, 'switch (x) {\n  case 1:\n    break;\n    break;\n}\n', 'utf8');
    const cleanFile = path.join(dir, 'com', 'example', 'Bar.java');
    fs.writeFileSync(cleanFile, 'class Bar {}\n', 'utf8');

    const fixedCount = cleanKnownDecompilerArtifacts(dir);

    expect(fixedCount).toBe(1);
    expect(fs.readFileSync(brokenFile, 'utf8')).not.toMatch(/break;\s*\n\s*break;/);
    expect(fs.readFileSync(cleanFile, 'utf8')).toBe('class Bar {}\n');
  });
});
