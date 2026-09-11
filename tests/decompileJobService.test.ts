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

/**
 * Config.BASE_PATH drives every data/jobs/workspaces path in the app (see config.ts) — jest
 * resets the module registry per test file (not per test), so overriding it once here isolates
 * this whole suite from the real data/ directory without ever touching real job records. `as
 * any` is required only because BASE_PATH is declared `private readonly` for callers outside
 * this file; TypeScript's privacy is erased at runtime, so the override itself works fine.
 */
const tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'bjd-decompilejobservice-'));

import { Config } from '../src/config/config';
(Config as any).BASE_PATH = tempBase;

import { JobStore } from '../src/services/jobStore';
import { DecompileJobService } from '../src/services/decompileJobService';
import { newJobSkeleton, JobStatus } from '../src/models/job';

function makeJob(id: string, status: JobStatus): void {
  const job = newJobSkeleton(id, `${id}.war`, 'war');
  job.status = status;
  JobStore.create(job);
  const wsDir = path.join(Config.workspacesPath, job.workspaceDir);
  fs.mkdirSync(wsDir, { recursive: true });
  fs.writeFileSync(path.join(wsDir, 'marker.txt'), 'workspace data');
}

function workspaceExists(id: string): boolean {
  return fs.existsSync(path.join(Config.workspacesPath, id));
}

afterAll(() => {
  fs.rmSync(tempBase, { recursive: true, force: true });
});

describe('DecompileJobService.clearTerminalJobs', () => {
  it('deletes every terminal job (record + workspace) and leaves paused/active jobs alone', () => {
    makeJob('t-completed', 'completed');
    makeJob('t-completed-with-errors', 'completed_with_errors');
    makeJob('t-failed', 'failed');
    makeJob('t-cancelled', 'cancelled');
    makeJob('p-paused', 'paused');
    makeJob('a-decompiling', 'decompiling');

    const result = DecompileJobService.clearTerminalJobs();
    expect(result).toEqual({ cleared: 4, skipped: 2 });

    const remainingIds = JobStore.list().map(j => j.id).sort();
    expect(remainingIds).toEqual(['a-decompiling', 'p-paused']);

    for (const id of ['t-completed', 't-completed-with-errors', 't-failed', 't-cancelled']) {
      expect(JobStore.get(id)).toBeNull();
      expect(workspaceExists(id)).toBe(false);
    }
    for (const id of ['p-paused', 'a-decompiling']) {
      expect(JobStore.get(id)).not.toBeNull();
      expect(workspaceExists(id)).toBe(true);
    }
  });

  it('is a no-op (not an error) when there are no terminal jobs left to clear', () => {
    makeJob('p-still-paused', 'paused');
    const result = DecompileJobService.clearTerminalJobs();
    expect(result.cleared).toBe(0);
    expect(JobStore.get('p-still-paused')).not.toBeNull();
  });
});
