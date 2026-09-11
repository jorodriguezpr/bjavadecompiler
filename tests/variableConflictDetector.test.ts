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

import { detectVariableConflicts, formatConflictDiagnostics } from '../src/services/variableConflictDetector';

describe('detectVariableConflicts', () => {
  it('flags the full slot-reuse corruption shape from a real broken CFR decompile', () => {
    const source = `
public class Foo {
    public synchronized void init() throws ServletException {
        ?? Trim = this;
        synchronized (Trim) {
            try {
                Trim = 0;
                Trim = this._elogAppId;
                Trim = Trim;
            } catch (Throwable th) {
                throw Trim;
            }
        }
    }
}
`;
    const findings = detectVariableConflicts(source);
    const notes = findings.map(f => f.note);

    expect(notes.some(n => n.includes('could not infer a type'))).toBe(true);
    expect(notes.some(n => n.includes('incompatible-looking values'))).toBe(true);
    expect(notes.some(n => n.includes('no-op self-assignment'))).toBe(true);
    expect(notes.some(n => n.includes('synchronized (Trim)'))).toBe(true);
    expect(notes.some(n => n.includes('throw Trim'))).toBe(true);
  });

  it('does not flag a normal, single-role variable', () => {
    const source = `
public class Foo {
    void bar() {
        String name = "hello";
        name = name.trim();
        System.out.println(name);
    }
}
`;
    expect(detectVariableConflicts(source)).toEqual([]);
  });

  it('does not flag a legitimately caught-and-rethrown exception', () => {
    const source = `
public class Foo {
    void bar() {
        try {
            doWork();
        } catch (Exception ex) {
            throw ex;
        }
    }
}
`;
    expect(detectVariableConflicts(source)).toEqual([]);
  });

  it('does not flag this.field assignments as conflicting local-variable reuse', () => {
    const source = `
public class Foo {
    void init() {
        this._maintScheduler = new Scheduler(null, 5L);
        this._maintScheduler = new Scheduler(null, 10L);
    }
}
`;
    expect(detectVariableConflicts(source)).toEqual([]);
  });

  it('formats findings as a bullet list, and returns empty string for no findings', () => {
    expect(formatConflictDiagnostics([])).toBe('');
    const findings = detectVariableConflicts('class A { void x() { a = a; } }');
    expect(formatConflictDiagnostics(findings)).toMatch(/^- /);
  });
});
