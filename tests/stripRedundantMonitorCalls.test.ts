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

import { stripRedundantMonitorCalls } from '../src/services/decompilerArtifactCleanup';

describe('stripRedundantMonitorCalls', () => {
  it('removes a monitorexit call matching its enclosing synchronized block (real Scheduler.java shape)', () => {
    const source = [
      'public void register(final SchedulerIntf client) {',
      '    synchronized (this.clientList) {',
      '        if (!this.clientList.contains(client)) {',
      '            this.clientList.add(client);',
      '        }',
      '        monitorexit(this.clientList);',
      '    }',
      '}',
    ].join('\n');

    const { fixed, removed } = stripRedundantMonitorCalls(source);
    expect(removed).toBe(1);
    expect(fixed).not.toContain('monitorexit');
    expect(fixed).toContain('synchronized (this.clientList) {');
  });

  it('removes a monitorexit inside a nested catch block still within the matching synchronized block (real FileSystemScanner.java shape)', () => {
    const source = [
      'public void kickOff(final Scheduler s) {',
      '    synchronized (this.files) {',
      '        this.files.clear();',
      '        try {',
      '            doWork();',
      '        }',
      '        catch (final InvalidParamException e2) {',
      '            log(e2);',
      '            monitorexit(this.files);',
      '            return;',
      '        }',
      '        monitorexit(this.files);',
      '    }',
      '}',
    ].join('\n');

    const { fixed, removed } = stripRedundantMonitorCalls(source);
    expect(removed).toBe(2);
    expect(fixed).not.toContain('monitorexit');
  });

  it('removes a qualified-this monitor target when it textually matches the enclosing block (real SFTPScanner.java shape)', () => {
    const source = [
      'synchronized (SFTPScanner.this.CHANNEL_LOCK) {',
      '    tempChildren = chl.ls(".");',
      '    monitorexit(SFTPScanner.this.CHANNEL_LOCK);',
      '}',
    ].join('\n');

    const { fixed, removed } = stripRedundantMonitorCalls(source);
    expect(removed).toBe(1);
    expect(fixed).not.toContain('monitorexit');
  });

  it('does NOT remove a monitor call with no enclosing synchronized block at all (real SocketPool.java shape — removing would silently drop real thread-safety)', () => {
    const source = [
      'final Object o;',
      'monitorenter(o = pendingReq);',
      'try {',
      '    pendingReq.notify();',
      '    monitorexit(o);',
      '}',
      'finally {}',
    ].join('\n');

    const { fixed, removed } = stripRedundantMonitorCalls(source);
    expect(removed).toBe(0);
    expect(fixed).toBe(source);
    expect(fixed).toContain('monitorenter(o = pendingReq);');
    expect(fixed).toContain('monitorexit(o);');
  });

  it('does NOT remove a monitor call whose argument does not match the enclosing synchronized target', () => {
    const source = [
      'synchronized (this.lockA) {',
      '    monitorexit(this.lockB);',
      '}',
    ].join('\n');

    const { fixed, removed } = stripRedundantMonitorCalls(source);
    expect(removed).toBe(0);
    expect(fixed).toContain('monitorexit(this.lockB);');
  });

  it('only removes the call inside the matching inner block when synchronized blocks are nested with different targets', () => {
    const source = [
      'synchronized (this.outer) {',
      '    synchronized (this.inner) {',
      '        monitorexit(this.inner);',
      '    }',
      '    monitorexit(this.outer);',
      '}',
    ].join('\n');

    const { fixed, removed } = stripRedundantMonitorCalls(source);
    expect(removed).toBe(2);
    expect(fixed).not.toContain('monitorexit');
    expect(fixed).toContain('synchronized (this.outer)');
    expect(fixed).toContain('synchronized (this.inner)');
  });

  it('leaves source with no monitor calls at all completely unchanged', () => {
    const source = 'class Foo { void bar() { synchronized (this) { doWork(); } } }';
    const { fixed, removed } = stripRedundantMonitorCalls(source);
    expect(removed).toBe(0);
    expect(fixed).toBe(source);
  });
});
