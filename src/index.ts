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
 * Main Application Entry Point
 */

import 'dotenv/config'; // must run before anything reads Config/process.env
import express from 'express';
import http from 'http';

import { Config } from './config/config';
import { Logger } from './core/logger';
import { checkToolchain } from './core/toolchainCheck';
import { errorHandler } from './middleware/errorHandler';
import { requestLogger } from './middleware/requestLogger';
import { apiRouter } from './routes/api';
import { webRouter } from './routes/web';
import { JobStore } from './services/jobStore';

const logger = Logger.getLogger('App');

async function bootstrap() {
  try {
    logger.info(`${Config.appName} v${Config.getVersion()} starting...`);

    // Load existing job records and flip anything left mid-phase from a prior crash/restart
    // to 'paused' — mirrors ServerConverterService.recoverOrphanedJobs() in SysAdminCenterHCP.
    JobStore.loadAll();

    const toolchain = await checkToolchain();
    if (!toolchain.ready) {
      logger.warn('JDK 17+/Maven not fully detected — Upload will stay disabled in the UI until this is fixed.', { toolchain });
    } else {
      logger.info(`Toolchain ready: ${toolchain.java.version}, ${toolchain.maven.version}`);
    }

    const app = express();
    app.set('trust proxy', 'loopback');

    app.use(express.json({ limit: '2mb' })); // file uploads go through multer, not this
    app.use(requestLogger);

    app.get('/health', (_req, res) => {
      res.json({ status: 'ok', name: Config.appName, version: Config.getVersion(), uptime: process.uptime() });
    });

    app.use('/api', apiRouter);
    app.use('/', webRouter);
    app.use(errorHandler);

    const server = http.createServer(app);
    server.listen(Config.port, () => {
      logger.info(`${Config.appName} listening on port ${Config.port}`);
      logger.info(`Dashboard: ${Config.publicUrl}`);
    });

    const shutdown = (signal: string) => {
      logger.info(`${signal} received — shutting down...`);
      server.close(() => {
        logger.info('Goodbye.');
        process.exit(0);
      });
    };
    process.on('SIGTERM', () => shutdown('SIGTERM'));
    process.on('SIGINT', () => shutdown('SIGINT'));
  } catch (err: any) {
    logger.error(`Failed to start: ${err.message}`, { stack: err.stack });
    process.exit(1);
  }
}

bootstrap();
