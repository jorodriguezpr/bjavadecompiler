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
 * BJavaDecompiler - system/tool-status routes, drives the Tool Setup panel and the
 * Upload-button gate.
 */

import fs from 'fs';
import path from 'path';
import { Router, Request, Response } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { ApiError } from '../../core/apiError';
import { checkToolchain } from '../../core/toolchainCheck';
import { getAllEngineStatus, ensureEngine, EngineName } from '../../core/externalTools';
import { AIProvider } from '../../core/aiProvider';
import { Config } from '../../config/config';
import { ENV_SCHEMA } from '../../core/envSchema';
import { AiDelegationService } from '../../services/aiDelegationService';

export const systemRouter = Router();

async function buildStatusPayload() {
  const [toolchain, engines, aiLocal, aiLmStudio] = await Promise.all([
    checkToolchain(), getAllEngineStatus(), AIProvider.checkLocalOllama(), AIProvider.checkLocalLmStudio(),
  ]);
  return {
    appName: Config.appName,
    version: Config.getVersion(),
    toolchain,
    engines,
    aiConfigured: AIProvider.isConfigured(),
    aiEnabled: Config.aiEnabled,
    aiProvider: Config.aiProvider,
    aiModel: Config.aiModel,
    aiLocal, // { reachable, modelPulled } — only meaningful when aiProvider === 'ollama-local'
    aiLmStudio, // { reachable, modelPulled } — only meaningful when aiProvider === 'lm-studio'
    aiDelegationWorker: AiDelegationService.getWorkerStatus(), // { lastSeenAt, online } — only meaningful when aiProvider === 'ai-delegation'
    enabledEngines: Config.enabledEngines,
    decompileUnresolvedLibs: Config.decompileUnresolvedLibs,
    decompileParallel: Config.decompileParallel,
    uploadReady: toolchain.ready && engines.every(e => e.installed),
  };
}

systemRouter.get('/status', asyncHandler(async (_req: Request, res: Response) => {
  res.json({ success: true, data: await buildStatusPayload() });
}));

// POST /system/reload-env — re-reads .env into process.env with no process restart. Works for
// AI_ENABLED/AI_PROVIDER/AI_MODEL/DECOMPILE_* and friends since Config's getters all read
// process.env live; PORT/NODE_ENV genuinely need a real restart (the HTTP server is already
// bound), so those are called out separately in the response instead of silently no-op'ing.
systemRouter.post('/reload-env', asyncHandler(async (_req: Request, res: Response) => {
  const { changed, restartRequiredFor } = Config.reloadFromEnvFile();
  res.json({ success: true, data: { changed, restartRequiredFor, status: await buildStatusPayload() } });
}));

// GET /system/env — schema + current values for the Tool Setup settings form. The secret field
// (OLLAMA_CLOUD_API_KEY) never comes back with its real value — only whether one is set — so
// the browser never re-displays a credential that isn't currently being typed into the form.
systemRouter.get('/env', (_req: Request, res: Response) => {
  const raw = Config.readEnvFile();
  const values: Record<string, string> = {};
  const secretIsSet: Record<string, boolean> = {};
  for (const field of ENV_SCHEMA) {
    if (field.type === 'secret') {
      secretIsSet[field.key] = !!raw[field.key];
      values[field.key] = '';
    } else {
      values[field.key] = raw[field.key] ?? '';
    }
  }
  res.json({ success: true, data: { schema: ENV_SCHEMA, values, secretIsSet } });
});

// POST /system/env { values: { KEY: "..." } } — writes the given keys into .env (every other
// line untouched) and reloads them live. Only keys in ENV_SCHEMA are accepted — this is a
// deliberate whitelist, not an arbitrary "write anything to .env" endpoint. A secret field sent
// blank is dropped from the write entirely (leaves the existing stored value alone) rather than
// blanking out a credential just because the form re-submitted an empty placeholder.
systemRouter.post('/env', asyncHandler(async (req: Request, res: Response) => {
  const incoming = req.body?.values;
  if (!incoming || typeof incoming !== 'object') throw ApiError.badRequest('Request body must be { values: { KEY: "value", ... } }.');

  const knownKeys = new Set(ENV_SCHEMA.map(f => f.key));
  const secretKeys = new Set(ENV_SCHEMA.filter(f => f.type === 'secret').map(f => f.key));
  const updates: Record<string, string> = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (!knownKeys.has(key)) throw ApiError.badRequest(`Unknown setting: ${key}`);
    if (secretKeys.has(key) && (value === '' || value === null || value === undefined)) continue; // leave stored secret alone
    updates[key] = String(value ?? '');
  }

  Config.writeEnvValues(updates);
  const { changed, restartRequiredFor } = Config.reloadFromEnvFile();
  res.json({ success: true, data: { changed, restartRequiredFor, status: await buildStatusPayload() } });
}));

// POST /system/test-ai — fires one real, bounded-time chat-completion call against whichever
// provider is currently configured, so "is my AI provider actually reachable and does the model
// respond" can be answered from the browser without waiting on (or accidentally triggering) a
// real pipeline job. See AIProvider.testConnection() for why ai-delegation is handled differently.
systemRouter.post('/test-ai', asyncHandler(async (_req: Request, res: Response) => {
  // The API call itself always "succeeds" (HTTP 200) even when the AI test comes back negative
  // (wrong model, unreachable server, bad key) — that's a valid, complete diagnostic result, not
  // a server error. The actual pass/fail lives in data.success for the frontend to render.
  const result = await AIProvider.testConnection();
  res.json({ success: true, data: result });
}));

// GET /system/about — developer/license info for the About page.
systemRouter.get('/about', (_req: Request, res: Response) => {
  let licenseText = '';
  try { licenseText = fs.readFileSync(path.join(Config.basePath, 'LICENSE'), 'utf8'); } catch { /* optional */ }
  res.json({
    success: true,
    data: {
      appName: Config.appName,
      version: Config.getVersion(),
      description: Config.appDescription,
      author: Config.author,
      license: Config.license,
      licenseText,
      repositoryUrl: Config.repositoryUrl,
    },
  });
});

// GET /system/ai-delegation-key — the bearer token AiWindowsAssistant's .env needs
// (BJAVADECOMPILER_WORKER_API_KEY) to poll this app's delegation queue. Generated on first
// request if unset. Separate from the generic /env settings form (like Guardian's escalation
// worker key in SysAdminCenterHCP) since this is a "copy this into the OTHER app's config"
// value, not something a human types in here.
systemRouter.get('/ai-delegation-key', (_req: Request, res: Response) => {
  res.json({ success: true, data: { key: AiDelegationService.getOrCreateWorkerApiKey() } });
});

// POST /system/ai-delegation-key/regenerate — invalidates the old key immediately; the human
// must update AiWindowsAssistant's .env with the new one or its polling starts failing 401s.
systemRouter.post('/ai-delegation-key/regenerate', (_req: Request, res: Response) => {
  res.json({ success: true, data: { key: AiDelegationService.regenerateWorkerApiKey() } });
});

// POST /system/clear-cache — wipes the dependency-resolution cache (data/dependency-cache.json)
// and the decompiled+AI-cleaned unresolved-lib cache (data/decompiled-lib-cache/) so the next job
// re-derives everything from scratch. Real need: a job re-run against byte-identical jars can
// legitimately get WORSE results than a fresh run if either cache holds output from an earlier,
// since-fixed version of the pipeline (confirmed live — a run right after fixing a real
// remediation-loop bug still reused stale pre-fix decompiled+AI-cleaned lib output on its next
// run and regressed). This is a full wipe, not a per-jar surgical purge — both caches are
// self-healing/cheap to rebuild (re-derived automatically on the next job that needs them), so
// there's no reason to expose finer-grained clearing.
systemRouter.post('/clear-cache', asyncHandler(async (_req: Request, res: Response) => {
  let depEntriesCleared = 0;
  if (fs.existsSync(Config.dependencyCachePath)) {
    try {
      depEntriesCleared = Object.keys(JSON.parse(fs.readFileSync(Config.dependencyCachePath, 'utf8'))).length;
    } catch { /* corrupt/unreadable — still safe to overwrite below */ }
    fs.writeFileSync(Config.dependencyCachePath, '{}', 'utf8');
  }

  let libCacheEntriesCleared = 0;
  const libCacheDir = Config.decompiledLibCachePath;
  if (fs.existsSync(libCacheDir)) {
    const entries = fs.readdirSync(libCacheDir);
    libCacheEntriesCleared = entries.length;
    for (const entry of entries) {
      fs.rmSync(path.join(libCacheDir, entry), { recursive: true, force: true });
    }
  }

  res.json({ success: true, data: { depEntriesCleared, libCacheEntriesCleared } });
}));

systemRouter.post('/engines/:name/install', asyncHandler(async (req: Request, res: Response) => {
  const name = req.params.name as EngineName;
  if (!['cfr', 'vineflower', 'jdcli', 'jadx', 'procyon'].includes(name)) {
    return res.status(400).json({ success: false, error: 'Unknown engine' });
  }
  const status = await ensureEngine(name);
  res.json({ success: true, data: status });
}));
