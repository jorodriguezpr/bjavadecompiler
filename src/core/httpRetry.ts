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
 * BJavaDecompiler - shared HTTP retry/backoff helper.
 *
 * Ported from the retry logic in C:\PythonProjects\AiAgentAssistant\src\utils\AIProvider.ts
 * (the most complete implementation of this pattern anywhere in this user's portfolio — the
 * sibling SysAdminCenterHCP/AiWindowsAssistant Ollama Cloud clients have no retry at all).
 * Used by both the AI provider and Maven Central dependency-resolution lookups so both benefit
 * from the same rate-limit/backoff handling.
 */

import { AxiosRequestConfig } from 'axios';
import { Logger } from './logger';

const logger = Logger.getLogger('HttpRetry');

const TRANSIENT_CODES = ['ECONNRESET', 'ECONNABORTED', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN', 'EPIPE'];

/**
 * Sensible defaults for every outbound call this tool makes (Maven Central, GitHub Releases,
 * jar downloads): a real User-Agent (some hosts, e.g. search.maven.org, return 403 for
 * axios's default UA as a bot-blocking measure) and IPv4 forced. The `family: 4` is load-
 * bearing, not cosmetic — confirmed live in this dev environment that Node's default
 * dual-stack (IPv6-first) resolution hangs until timeout against these hosts while curl (and
 * an explicit IPv4 request) succeed in under a second. Cheap enough to apply everywhere rather
 * than debug per-host.
 */
export function httpDefaults(overrides: AxiosRequestConfig = {}): AxiosRequestConfig {
  return {
    headers: { 'User-Agent': 'BJavaDecompiler/1.0 (+https://github.com/)', ...(overrides.headers || {}) },
    family: 4,
    ...overrides,
  };
}

function isRateLimit(error: any): boolean {
  return error?.response?.status === 429 || error?.status === 429;
}

function isTransientError(error: any): boolean {
  return TRANSIENT_CODES.includes(error?.code) ||
    TRANSIENT_CODES.some(c => error?.message?.includes(c)) ||
    !!error?.message?.includes('socket hang up');
}

function getRetryAfterDelayMs(error: any): number | null {
  const retryAfter = error?.response?.headers?.['retry-after'];
  if (!retryAfter) return null;
  const seconds = parseInt(retryAfter, 10);
  return isNaN(seconds) ? null : seconds * 1000;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export interface RetryOptions {
  maxRetries?: number;
  /** Label used in log lines, e.g. "OllamaCloud" or "MavenCentral". */
  label?: string;
}

/**
 * Run `fn` with retry on HTTP 429 (honoring Retry-After) and transient network errors.
 * Exponential backoff for 429 (2^attempt * 1000ms), linear for transient errors
 * (attempt * 2000ms) — both capped at 30s. Throws the last error once retries are exhausted.
 */
export async function withRetry<T>(fn: () => Promise<T>, opts: RetryOptions = {}): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const label = opts.label || 'HTTP';
  let lastError: any;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;

      const rateLimit = isRateLimit(error);
      const transient = isTransientError(error);

      if ((rateLimit || transient) && attempt < maxRetries) {
        const serverRetryAfter = rateLimit ? getRetryAfterDelayMs(error) : null;
        let waitMs = serverRetryAfter ?? (transient ? attempt * 2000 : Math.pow(2, attempt) * 1000);
        waitMs = Math.min(waitMs, 30000);

        logger.warn(`[${label}] attempt ${attempt}/${maxRetries} failed (${rateLimit ? 'rate limit' : 'transient error'}) — retrying in ${waitMs}ms`, {
          message: error?.message,
        });
        await sleep(waitMs);
        continue;
      }

      throw error;
    }
  }

  throw lastError;
}
