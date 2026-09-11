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
 * BJavaDecompiler - manual Maven repository search, for resolving a dependency the automatic
 * passes left 'unresolved' (see mavenSearchService.ts). Job-agnostic — the job-scoped pieces
 * (listing classes inside a specific unresolved jar, applying the chosen coordinate) live on
 * jobsRouter instead, since they need that job's workspace.
 */

import { Router, Request, Response } from 'express';
import { asyncHandler } from '../../core/asyncHandler';
import { ApiError } from '../../core/apiError';
import { searchMavenByClassName, searchMavenByText } from '../../services/mavenSearchService';

export const mavenRouter = Router();

// GET /api/maven/search?class=com.example.Foo   -- fully-qualified class name search
// GET /api/maven/search?q=some-library-name      -- free-text fallback
mavenRouter.get('/search', asyncHandler(async (req: Request, res: Response) => {
  const className = typeof req.query.class === 'string' ? req.query.class.trim() : '';
  const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
  if (!className && !query) throw ApiError.badRequest('Provide either ?class=<fully.qualified.ClassName> or ?q=<search text>.');

  const results = className ? await searchMavenByClassName(className) : await searchMavenByText(query);
  res.json({ success: true, data: results });
}));
