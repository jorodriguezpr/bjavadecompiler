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
 * BJavaDecompiler - Web Routes
 * Serves the vanilla-JS single-page frontend and static assets.
 */

import { Router, Request, Response } from 'express';
import path from 'path';
import fs from 'fs';
import express from 'express';
import { Config } from '../config/config';

const router = Router();

const themePath = Config.themePath;
if (fs.existsSync(themePath)) {
  router.use(express.static(themePath));
}

router.get('*', (req: Request, res: Response) => {
  const indexPath = path.join(themePath, 'index.html');
  if (fs.existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(200).json({
      name: Config.appName,
      version: Config.getVersion(),
      message: 'BJavaDecompiler API is running. Web UI not yet built.',
      apiBase: '/api',
    });
  }
});

export const webRouter = router;
