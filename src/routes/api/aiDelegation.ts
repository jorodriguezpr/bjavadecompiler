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
 * BJavaDecompiler - AI delegation worker routes (bearer token, not a browser session) — the
 * AiWindowsAssistant poll loop's side of the queue described in aiDelegationService.ts.
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { ApiError } from '../../core/apiError';
import { AiDelegationService } from '../../services/aiDelegationService';
import { aiDelegationWorkerAuthMiddleware } from '../../middleware/aiDelegationAuth';

export const aiDelegationRouter = Router();
const worker = Router();
worker.use(aiDelegationWorkerAuthMiddleware);
aiDelegationRouter.use('/worker', worker);

// GET /api/ai-delegation/worker/pending?limit= — hit regularly regardless of whether anything's
// pending, so it doubles as the worker's liveness heartbeat.
worker.get('/pending', (req: Request, res: Response) => {
  AiDelegationService.recordWorkerHeartbeat();
  const limit = parseInt(req.query.limit as string, 10) || 10;
  res.json({ success: true, data: AiDelegationService.listPending(limit) });
});

// POST /api/ai-delegation/worker/:id/claim { claimedBy }
worker.post('/:id/claim', asyncHandler(async (req: Request, res: Response) => {
  const claimedBy = (req.body?.claimedBy && String(req.body.claimedBy)) || 'unknown-worker';
  try {
    res.json({ success: true, data: AiDelegationService.claim(req.params.id, claimedBy) });
  } catch (err: any) {
    throw ApiError.conflict(err.message);
  }
}));

// POST /api/ai-delegation/worker/:id/result { status, result?, success?, errorMessage?, durationMs? }
worker.post('/:id/result', (req: Request, res: Response) => {
  const { status, result, success, errorMessage, durationMs } = req.body || {};
  if (!['completed', 'failed'].includes(status)) {
    throw ApiError.badRequest('status must be one of: completed, failed');
  }
  res.json({ success: true, data: AiDelegationService.submitResult(req.params.id, { status, result, success, errorMessage, durationMs }) });
});
