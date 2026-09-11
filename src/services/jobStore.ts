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
 * BJavaDecompiler - job persistence: one JSON file per job under data/jobs/<id>.json.
 *
 * Deliberately not TypeORM/SQL — this is a single-user local tool, unlike the multi-tenant
 * billing/panel apps elsewhere in this portfolio that genuinely need a real DB. An in-memory
 * Map caches active jobs for fast reads; every state transition flushes to disk via an atomic
 * write-then-rename so a crash mid-write can never leave a half-written, corrupt job record.
 */

import fs from 'fs';
import path from 'path';
import { Config } from '../config/config';
import { Logger } from '../core/logger';
import { DecompileJob, JobStatus } from '../models/job';

const logger = Logger.getLogger('JobStore');

const ACTIVE_STATUSES: JobStatus[] = [
  'extracting', 'resolving_dependencies', 'decompiling',
  'scoring_candidates', 'ai_reconstructing', 'generating_project', 'verifying_build',
];

/** Genuinely done, in the sense that nothing will ever resume or advance this job further —
 * safe to delete outright. Deliberately excludes 'paused': that's an interrupted-but-resumable
 * job (see loadAll() above), and a "clear all" should never quietly throw away work a developer
 * might still come back to resume. */
export const TERMINAL_STATUSES: JobStatus[] = ['completed', 'completed_with_errors', 'failed', 'cancelled'];

export class JobStore {
  private static cache = new Map<string, DecompileJob>();
  private static loaded = false;

  private static jobFile(id: string): string {
    return path.join(Config.jobsPath, `${id}.json`);
  }

  /** Scan data/jobs/*.json into the in-memory cache and flip any job stuck mid-phase to
   * 'paused' — no in-memory pipeline loop survived a process restart, so an active-looking
   * status is stale by definition. Call once at startup. */
  static loadAll(): void {
    if (JobStore.loaded) return;
    const dir = Config.jobsPath;
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter(f => f.endsWith('.json')) : [];
    for (const file of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, file), 'utf8');
        const job: DecompileJob = JSON.parse(raw);
        if (ACTIVE_STATUSES.includes(job.status)) {
          logger.warn(`Job ${job.id} was stuck in '${job.status}' at startup — marking paused for manual resume.`);
          job.status = 'paused';
          job.updatedAt = new Date().toISOString();
          JobStore.writeToDisk(job);
        }
        JobStore.cache.set(job.id, job);
      } catch (err: any) {
        logger.error(`Failed to load job file ${file}: ${err.message}`);
      }
    }
    JobStore.loaded = true;
    logger.info(`Loaded ${JobStore.cache.size} job(s) from disk.`);
  }

  static get(id: string): DecompileJob | null {
    return JobStore.cache.get(id) || null;
  }

  static list(): DecompileJob[] {
    return Array.from(JobStore.cache.values()).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  static create(job: DecompileJob): void {
    JobStore.cache.set(job.id, job);
    JobStore.writeToDisk(job);
  }

  /** Deletes the job's record file and drops it from the cache. Does NOT touch its workspace
   * directory (the generated project, decompiled sources, downloaded jars, etc.) — that's a
   * separate, much larger cleanup callers must do explicitly (see DecompileJobService.
   * clearTerminalJobs()), kept out of this class since JobStore only owns the job *records*,
   * not the workspace filesystem layout. */
  static remove(id: string): void {
    JobStore.cache.delete(id);
    const file = JobStore.jobFile(id);
    if (fs.existsSync(file)) fs.unlinkSync(file);
  }

  /** Save the given job's current in-memory state to disk. Callers mutate the object returned
   * by get() in place, then call save() — mirrors the "set a field, then persist" pattern used
   * throughout this user's other job-state-machine services. */
  static save(job: DecompileJob): void {
    job.updatedAt = new Date().toISOString();
    JobStore.cache.set(job.id, job);
    JobStore.writeToDisk(job);
  }

  private static writeToDisk(job: DecompileJob): void {
    const file = JobStore.jobFile(job.id);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(job, null, 2), 'utf8');
    fs.renameSync(tmp, file); // atomic on the same filesystem
  }

  static setStatus(job: DecompileJob, status: JobStatus): void {
    job.status = status;
    job.phaseTimestamps[status] = new Date().toISOString();
    JobStore.save(job);
  }

  static appendLog(job: DecompileJob, level: 'info' | 'warn' | 'error', message: string): void {
    job.log.push({ timestamp: new Date().toISOString(), level, message });
    if (job.log.length > 2000) job.log = job.log.slice(-2000); // keep job files bounded
    JobStore.save(job);
  }

  /** Sets the "what's running right now" field the dashboard shows in its live activity box —
   * distinct from the scrolling job log. Pass null once a stage has nothing in flight (between
   * subprocess calls, or the job finished/paused/failed) so the box doesn't show a stale command. */
  static setCurrentOperation(job: DecompileJob, operation: string | null): void {
    job.currentOperation = operation;
    JobStore.save(job);
  }

  /** Records a subprocess command both in the live activity box and the historical log, in a
   * single save — used for the "about to spawn java/mvn ..." callbacks so a developer watching
   * the dashboard sees the exact command instead of just a generic per-stage message. */
  static logOperation(job: DecompileJob, message: string): void {
    job.currentOperation = message;
    job.log.push({ timestamp: new Date().toISOString(), level: 'info', message });
    if (job.log.length > 2000) job.log = job.log.slice(-2000);
    JobStore.save(job);
  }
}
