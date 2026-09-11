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
 * BJavaDecompiler - AI delegation queue: hands a prompt to a local AiWindowsAssistant instance,
 * which runs it through the user's own authenticated Claude Code CLI and posts the result back.
 *
 * Same architecture as SysAdminCenterHCP's Fleet Guardian -> AiWindowsAssistant Claude Code
 * escalation (c:\PhpProjects\SysAdminCenterHCP\src\services\claudeEscalationService.ts and
 * c:\PhpProjects\AiWindowsAssistant\src\services\EscalationPollService.ts), simplified for this
 * app's actual need: every delegation here is a single, self-contained text-reconstruction
 * prompt with zero real-world side effects (no server access, no destructive tool calls), unlike
 * Guardian's escalations which can reason about live infrastructure — so there is no Telegram
 * approve/deny gate in this model at all. AiWindowsAssistant's own poll service for this queue
 * still runs Claude Code under the same blanket read-only hook Guardian's unattended
 * (requiresApproval:false) runs use, since the prompt content here is built from AI-reconstructed
 * decompiled bytecode — untrusted text, even though the *task* is harmless.
 *
 * Persisted as a single JSON file (data/ai-delegations.json), matching this app's no-database
 * convention (see jobStore.ts, dependencyResolutionService.ts's dependency-cache.json) rather
 * than SysAdminCenterHCP's TypeORM entity — this app has no DB at all.
 */

import fs from 'fs';
import crypto from 'crypto';
import { Config } from '../config/config';
import { Logger } from '../core/logger';

const logger = Logger.getLogger('AiDelegationService');

export type AiDelegationStatus = 'pending' | 'claimed' | 'completed' | 'failed';

export interface AiDelegation {
  id: string;
  prompt: string;
  status: AiDelegationStatus;
  createdAt: string;
  claimedAt: string | null;
  claimedBy: string | null;
  completedAt: string | null;
  result: string | null;
  success: boolean | null;
  errorMessage: string | null;
  durationMs: number | null;
}

interface Store {
  delegations: AiDelegation[];
  workerLastSeenAt: string | null;
}

const MAX_STORED = 200; // bounded — completed/failed rows past this are pruned oldest-first

function storePath(): string {
  return `${Config.dataPath}/ai-delegations.json`;
}

function load(): Store {
  const p = storePath();
  if (!fs.existsSync(p)) return { delegations: [], workerLastSeenAt: null };
  try {
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return { delegations: parsed.delegations || [], workerLastSeenAt: parsed.workerLastSeenAt ?? null };
  } catch {
    return { delegations: [], workerLastSeenAt: null };
  }
}

function save(store: Store): void {
  if (store.delegations.length > MAX_STORED) {
    store.delegations = store.delegations
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(-MAX_STORED);
  }
  fs.writeFileSync(storePath(), JSON.stringify(store, null, 2), 'utf8');
}

export class AiDelegationService {
  static create(prompt: string): AiDelegation {
    const store = load();
    const delegation: AiDelegation = {
      id: crypto.randomUUID(),
      prompt,
      status: 'pending',
      createdAt: new Date().toISOString(),
      claimedAt: null, claimedBy: null, completedAt: null,
      result: null, success: null, errorMessage: null, durationMs: null,
    };
    store.delegations.push(delegation);
    save(store);
    return delegation;
  }

  static get(id: string): AiDelegation | null {
    return load().delegations.find(d => d.id === id) || null;
  }

  static listPending(limit = 10): AiDelegation[] {
    return load().delegations
      .filter(d => d.status === 'pending')
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .slice(0, limit);
  }

  static claim(id: string, claimedBy: string): AiDelegation {
    const store = load();
    const delegation = store.delegations.find(d => d.id === id);
    if (!delegation) throw new Error('Delegation not found');
    if (delegation.status !== 'pending') throw new Error(`Delegation is already "${delegation.status}", not pending`);
    delegation.status = 'claimed';
    delegation.claimedAt = new Date().toISOString();
    delegation.claimedBy = claimedBy;
    save(store);
    return delegation;
  }

  static submitResult(id: string, input: {
    status: 'completed' | 'failed';
    result?: string | null;
    success?: boolean | null;
    errorMessage?: string | null;
    durationMs?: number | null;
  }): AiDelegation {
    const store = load();
    const delegation = store.delegations.find(d => d.id === id);
    if (!delegation) throw new Error('Delegation not found');
    delegation.status = input.status;
    delegation.result = input.result ?? null;
    delegation.success = input.success ?? (input.status === 'completed');
    delegation.errorMessage = input.errorMessage ?? null;
    delegation.durationMs = input.durationMs ?? null;
    delegation.completedAt = new Date().toISOString();
    save(store);
    return delegation;
  }

  /** Hit every time the worker polls GET /ai-delegation/worker/pending — the natural heartbeat
   * signal, no separate ping mechanism needed (same pattern as GuardianSettingsService.
   * recordEscalationWorkerHeartbeat in SysAdminCenterHCP). */
  static recordWorkerHeartbeat(): void {
    const store = load();
    store.workerLastSeenAt = new Date().toISOString();
    save(store);
  }

  static getWorkerStatus(): { lastSeenAt: string | null; online: boolean } {
    const { workerLastSeenAt } = load();
    if (!workerLastSeenAt) return { lastSeenAt: null, online: false };
    const ageMs = Date.now() - new Date(workerLastSeenAt).getTime();
    const thresholdMs = Config.aiDelegationWorkerOfflineThresholdMinutes * 60 * 1000;
    return { lastSeenAt: workerLastSeenAt, online: ageMs <= thresholdMs };
  }

  /** Generated once and written straight into .env (via the same Config.writeEnvValues() /
   * reloadFromEnvFile() pair the Tool Setup settings form uses) — a human copies it from the
   * Tool Setup page into AiWindowsAssistant's own .env, there's nothing to "set" via a form
   * field for this one, same as SysAdminCenterHCP's escalation worker key. */
  static getOrCreateWorkerApiKey(): string {
    const existing = Config.aiDelegationWorkerApiKey;
    if (existing) return existing;
    const generated = crypto.randomBytes(32).toString('hex');
    Config.writeEnvValues({ AI_DELEGATION_WORKER_API_KEY: generated });
    Config.reloadFromEnvFile();
    logger.info('Generated a new AI delegation worker API key.');
    return generated;
  }

  static regenerateWorkerApiKey(): string {
    const generated = crypto.randomBytes(32).toString('hex');
    Config.writeEnvValues({ AI_DELEGATION_WORKER_API_KEY: generated });
    Config.reloadFromEnvFile();
    logger.info('Regenerated the AI delegation worker API key — the old one is now invalid.');
    return generated;
  }

  /**
   * Polls until the delegation reaches a terminal state or `timeoutMs` elapses — this is what
   * turns the async claim/result queue back into the single awaited Promise AIProvider.
   * chatCompletion() needs to return. Runs in-process (this app has no separate worker process
   * of its own), so a plain interval-based poll of the same JSON file is enough — no HTTP
   * round-trip needed for this half.
   */
  static async waitForResult(id: string, timeoutMs: number, pollIntervalMs = 2000): Promise<AiDelegation> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const delegation = AiDelegationService.get(id);
      if (!delegation) throw new Error('Delegation disappeared while waiting for a result');
      if (delegation.status === 'completed' || delegation.status === 'failed') return delegation;
      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }
    throw new Error(`Timed out after ${timeoutMs}ms waiting for the AI delegation worker to complete this prompt — is AiWindowsAssistant running and polling?`);
  }
}
