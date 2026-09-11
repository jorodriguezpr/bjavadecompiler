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
 * BJavaDecompiler Logger — Winston-based, mirrors the sibling SysAdmin* project conventions.
 */

import winston from 'winston';
import path from 'path';
import { Config } from '../config/config';

const logDir = Config.logPath;

const logFormat = winston.format.combine(
  winston.format.timestamp({ format: 'YYYY-MM-DD HH:mm:ss' }),
  winston.format.errors({ stack: true }),
  winston.format.printf(({ timestamp, level, message, ...meta }) => {
    const metaStr = Object.keys(meta).length ? ` ${JSON.stringify(meta)}` : '';
    return `${timestamp} [${level.toUpperCase()}] ${message}${metaStr}`;
  })
);

const consoleFormat = winston.format.combine(
  winston.format.colorize(),
  winston.format.timestamp({ format: 'HH:mm:ss' }),
  winston.format.printf(({ timestamp, level, message }) => `${timestamp} [${level}] ${message}`)
);

export class Logger {
  private static loggers = new Map<string, winston.Logger>();

  static getLogger(context: string): winston.Logger {
    if (Logger.loggers.has(context)) return Logger.loggers.get(context)!;

    const logger = winston.createLogger({
      level: Config.isDebug ? 'debug' : 'info',
      format: logFormat,
      transports: [
        new winston.transports.Console({ format: consoleFormat }),
        new winston.transports.File({
          filename: path.join(logDir, 'error.log'),
          level: 'error',
          maxsize: 5242880,
          maxFiles: 5,
        }),
        new winston.transports.File({
          filename: path.join(logDir, 'combined.log'),
          maxsize: 5242880,
          maxFiles: 5,
        }),
      ],
    });

    Logger.loggers.set(context, logger);
    return logger;
  }
}
