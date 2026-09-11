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

import { classify } from '../src/services/aiRemediationService';

describe('classify', () => {
  it('treats a genuinely missing package as a dependency issue', () => {
    expect(classify(['[10,5] package com.wovenware.icgrid.flow does not exist'])).toBe('dependency');
  });

  it('treats a genuinely missing type (real "cannot find symbol: class") as a dependency issue', () => {
    expect(classify([
      '[5,10] cannot find symbol\n  symbol: class LsEntry\n  location: class com.wovenware.fs.SFTPScanner',
    ])).toBe('dependency');
  });

  it('treats a method/field missing on a raw-erased Object receiver as a fixable syntax issue, not a dependency', () => {
    // Confirmed live: javac reports this exact shape when a decompiled raw-generic call (e.g.
    // list.get(i).trim()) loses its type parameter — the symbol resolved fine, there's just no
    // such member on Object. Was previously misclassified as 'dependency' purely because the
    // message also contains the substring "cannot find symbol", permanently skipping AI/deterministic
    // remediation for a real, fixable cast issue.
    expect(classify([
      '[42,10] cannot find symbol\n  symbol: method trim()\n  location: class java.lang.Object',
    ])).toBe('syntax');
  });

  it('still classifies a file as dependency if it ALSO has a genuine dependency error, even alongside an Object-erasure one', () => {
    expect(classify([
      '[42,10] cannot find symbol\n  symbol: method trim()\n  location: class java.lang.Object',
      '[7,2] package com.wovenware.lic does not exist',
    ])).toBe('dependency');
  });

  it('treats a missing variable symbol at ANY location (not just java.lang.Object) as a fixable syntax issue', () => {
    // Confirmed live: the exact same root cause (decompiler mistyped a receiver's real type) also
    // surfaces with a non-Object location — a known, previously-flagged decompiler artifact where
    // a corrupted local variable ends up typed java.lang.Class<?> instead of an exception.
    expect(classify([
      '[33,51] cannot find symbol\n  symbol: method getMessage()\n  location: variable cls of type java.lang.Class<?>',
    ])).toBe('syntax');
  });

  it('treats a missing method symbol on a custom (non-JDK) type as syntax too — the receiver resolved, only the member did not', () => {
    expect(classify([
      '[10,3] cannot find symbol\n  symbol: method getPkRoleId()\n  location: variable role of type java.lang.Object',
    ])).toBe('syntax');
  });

  it('treats a plain incompatible-types error (no "cannot find symbol" at all) as syntax', () => {
    expect(classify(['[12,4] incompatible types: java.lang.Object cannot be converted to java.lang.String'])).toBe('syntax');
  });
});
