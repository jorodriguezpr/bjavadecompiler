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
 * BJavaDecompiler - Main API Router. Mounts all /api/* sub-routers.
 */

import { Router } from 'express';
import { jobsRouter } from './api/jobs';
import { systemRouter } from './api/system';
import { mavenRouter } from './api/maven';
import { aiDelegationRouter } from './api/aiDelegation';

export const apiRouter = Router();

apiRouter.use('/jobs', jobsRouter);
apiRouter.use('/system', systemRouter);
apiRouter.use('/maven', mavenRouter);
apiRouter.use('/ai-delegation', aiDelegationRouter);
