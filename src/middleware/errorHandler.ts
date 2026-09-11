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
 * BJavaDecompiler - Error Handler Middleware
 */

import { Request, Response, NextFunction } from 'express';
import { ApiError } from '../core/apiError';
import { Logger } from '../core/logger';

const logger = Logger.getLogger('ErrorHandler');

export function errorHandler(err: any, req: Request, res: Response, next: NextFunction): void {
  if (res.headersSent) return next(err);

  if (err instanceof ApiError) {
    res.status(err.status).json({ success: false, error: err.message });
    return;
  }

  logger.error(`Unhandled error: ${err.message}`, { stack: err.stack, path: req.path });
  res.status(500).json({
    success: false,
    error: { status: 500, message: 'Internal Server Error', path: req.path, timestamp: new Date().toISOString() },
  });
}
