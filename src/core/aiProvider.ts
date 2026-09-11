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
 * BJavaDecompiler - AI provider dispatch: Ollama Cloud, a local Ollama install, OpenAI,
 * Anthropic (direct Claude API), or AI delegation to a local AiWindowsAssistant instance (which
 * runs the prompt through the user's own authenticated Claude Code CLI instead) — selected via
 * Config.aiProvider (AI_PROVIDER env var).
 *
 * Ollama Cloud/local share one request shape (native `/api/chat`) and are handled together;
 * OpenAI speaks the standard Chat Completions shape; Anthropic's Messages API differs from both
 * in a way that needs real branching, not just a different base URL — a `system`-role message
 * isn't valid inside its `messages` array at all (it's a dedicated top-level `system` string
 * parameter instead), and `max_tokens` is a required field with no server-side default (unlike
 * OpenAI/Ollama, which are fine without one); ai-delegation isn't an HTTP call to a chat API at
 * all — see aiDelegationService.ts for that queue's own design rationale.
 *
 * Request/response shape for Ollama ported from the confirmed-working implementation in
 * c:\PhpProjects\SysAdminCenterHCP\src\core\aiProvider.ts. Retry/backoff logic ported from
 * C:\PythonProjects\AiAgentAssistant\src\utils\AIProvider.ts, the most complete implementation
 * of that pattern in this user's portfolio.
 */

import axios, { AxiosInstance } from 'axios';
import { Config } from '../config/config';
import { Logger } from './logger';
import { withRetry, httpDefaults } from './httpRetry';
import { AiDelegationService } from '../services/aiDelegationService';

const logger = Logger.getLogger('AIProvider');

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface ChatCompletionResponse {
  content: string;
  raw?: any;
}

export class AIProviderError extends Error {}

type Provider = 'ollama-cloud' | 'ollama-local' | 'lm-studio' | 'openai' | 'anthropic' | 'ai-delegation';

const PROVIDER_LABELS: Record<Provider, string> = {
  'ollama-cloud': 'Ollama Cloud',
  'ollama-local': 'Ollama (local)',
  'lm-studio': 'LM Studio (local)',
  'openai': 'OpenAI',
  'anthropic': 'Anthropic (Claude API)',
  'ai-delegation': 'AI Delegation (Claude Code via AiWindowsAssistant)',
};

export class AIProvider {
  private static client: AxiosInstance | null = null;
  /** getClient() caches its axios instance — if AI_PROVIDER changes mid-process (only possible
   * via a code reload in dev; a real deploy always restarts) the cached client would still point
   * at the old provider. Tracking which provider built it lets a stale client be rebuilt instead
   * of silently serving requests against the wrong host. */
  private static clientProvider: Provider | null = null;

  private static getClient(provider: 'ollama-cloud' | 'ollama-local' | 'lm-studio' | 'openai' | 'anthropic'): AxiosInstance {
    if (AIProvider.client && AIProvider.clientProvider === provider) return AIProvider.client;

    if (provider === 'ollama-local') {
      AIProvider.client = axios.create(httpDefaults({
        baseURL: Config.ollamaLocalHost,
        timeout: Config.aiRequestTimeoutMs,
        headers: { 'Content-Type': 'application/json' }, // local Ollama has no auth
      }));
    } else if (provider === 'lm-studio') {
      // Same OpenAI-shaped request body as the 'openai' branch below (LM Studio's built-in
      // server implements the Chat Completions API) — just a local base URL and no real API
      // key, same as ollama-local. LM Studio's server doesn't validate the Authorization header
      // at all, so it's simplest to omit it entirely rather than send a placeholder token.
      AIProvider.client = axios.create(httpDefaults({
        baseURL: Config.lmStudioHost,
        timeout: Config.aiRequestTimeoutMs,
        headers: { 'Content-Type': 'application/json' },
      }));
    } else if (provider === 'openai') {
      AIProvider.client = axios.create(httpDefaults({
        baseURL: Config.openaiHost,
        timeout: Config.aiRequestTimeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Config.openaiApiKey}`,
        },
      }));
    } else if (provider === 'anthropic') {
      // Anthropic auth is a plain x-api-key header, not Authorization: Bearer, plus a required
      // anthropic-version header pinning the Messages API version this code was written against.
      AIProvider.client = axios.create(httpDefaults({
        baseURL: Config.anthropicHost,
        timeout: Config.aiRequestTimeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': Config.anthropicApiKey,
          'anthropic-version': '2023-06-01',
        },
      }));
    } else {
      AIProvider.client = axios.create(httpDefaults({
        baseURL: Config.ollamaCloudHost,
        timeout: Config.aiRequestTimeoutMs,
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${Config.ollamaCloudApiKey}`,
        },
      }));
    }
    AIProvider.clientProvider = provider;
    return AIProvider.client;
  }

  /** AI_ENABLED=false short-circuits this to false regardless of provider setup — every AI-gated
   * call site (aiReconstructionService, aiRemediationService, unresolvedLibDecompiler's AI
   * cleanup) already treats "not configured" as "skip AI, fall back to non-AI output", so this
   * one flag is enough to force the whole pipeline down the zero-AI path without touching those
   * call sites individually.
   *
   * Local Ollama, LM Studio, and AI delegation need no API key at all — "configured" for any of
   * them just means the user opted in via AI_PROVIDER. Whether a server/worker is actually
   * reachable can only be known by trying (or via checkLocalOllama()/checkLocalLmStudio()/
   * AiDelegationService.getWorkerStatus() for the Tool Setup panel's live status, which this
   * deliberately does NOT call — a status badge shouldn't cost a network round trip on every
   * isConfigured() check). */
  static isConfigured(): boolean {
    if (!Config.aiEnabled) return false;
    switch (Config.aiProvider) {
      case 'ollama-local': return true;
      case 'lm-studio': return true;
      case 'ai-delegation': return true;
      case 'openai': return !!Config.openaiApiKey;
      case 'anthropic': return !!Config.anthropicApiKey;
      default: return !!Config.ollamaCloudApiKey;
    }
  }

  /**
   * Single chat-completion call against whichever provider is configured, with retry on rate
   * limits and transient network errors for the HTTP-based providers (see core/httpRetry.ts).
   * No streaming — every caller in this tool wants the full response before proceeding to the
   * next pipeline step anyway.
   */
  static async chatCompletion(
    messages: ChatMessage[],
    opts: { model?: string; timeoutMs?: number; maxRetries?: number } = {},
  ): Promise<ChatCompletionResponse> {
    const provider = Config.aiProvider;
    const label = PROVIDER_LABELS[provider];
    if (!AIProvider.isConfigured()) {
      const reason = !Config.aiEnabled
        ? 'AI_ENABLED=false'
        : provider === 'openai'
          ? 'OPENAI_API_KEY is not configured'
          : provider === 'anthropic'
            ? 'ANTHROPIC_API_KEY is not configured'
            : 'OLLAMA_CLOUD_API_KEY is not configured (set AI_PROVIDER=ollama-local, openai, anthropic, or ai-delegation instead)';
      throw new AIProviderError(`AI is not available (${reason}) — this call should have been skipped by the caller's isConfigured() check.`);
    }

    if (provider === 'ai-delegation') return AIProvider.chatCompletionViaDelegation(messages);

    // Per-call override of the axios instance's own default timeout (Config.aiRequestTimeoutMs,
    // 5 min by default — appropriate for a real reconstruction/remediation call, wildly too long
    // for testConnection() below to keep a browser button waiting on). Axios's per-request config
    // wins over the instance default when both are set.
    const requestConfig = opts.timeoutMs ? { timeout: opts.timeoutMs } : undefined;

    try {
      // The raw axios error (with .response/.code intact) must reach withRetry's own
      // catch block un-translated, or it can't tell a 429/transient failure from anything
      // else — only wrap it into AIProviderError once retries are fully exhausted.
      return await withRetry(async () => {
        if (provider === 'openai' || provider === 'lm-studio') {
          // LM Studio's built-in server implements this exact same Chat Completions shape —
          // the only difference from real OpenAI is the base URL/auth, already handled in
          // getClient() above.
          const res = await AIProvider.getClient(provider).post('/v1/chat/completions', {
            model: opts.model || Config.aiModel,
            messages,
          }, requestConfig);
          const content = res.data?.choices?.[0]?.message?.content || '';
          return { content, raw: res.data };
        }
        if (provider === 'anthropic') {
          // The Messages API takes `system` as a dedicated top-level string, not a role inside
          // `messages` — passing a system-role message through unfiltered is a 400. Concatenate
          // in case a caller ever sends more than one (none currently do).
          const systemText = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n') || undefined;
          const conversational = messages.filter(m => m.role !== 'system').map(m => ({ role: m.role, content: m.content }));
          const res = await AIProvider.getClient('anthropic').post('/v1/messages', {
            model: opts.model || Config.aiModel,
            max_tokens: Config.anthropicMaxTokens,
            ...(systemText ? { system: systemText } : {}),
            messages: conversational,
          }, requestConfig);
          // content is an array of blocks (text/tool_use/...) — concatenate every text block,
          // same as how a multi-paragraph reply would be split if the model happens to emit more
          // than one block (no tool use here, so in practice this is usually exactly one).
          const content = (res.data?.content || [])
            .filter((block: any) => block.type === 'text')
            .map((block: any) => block.text)
            .join('');
          return { content, raw: res.data };
        }
        const res = await AIProvider.getClient(provider).post('/api/chat', {
          model: opts.model || Config.aiModel,
          messages,
          stream: false,
        }, requestConfig);
        const msg = res.data?.message || {};
        return { content: msg.content || '', raw: res.data };
      }, { label, maxRetries: opts.maxRetries });
    } catch (err: any) {
      if (err.response) {
        throw new AIProviderError(`${label} returned HTTP ${err.response.status}: ${JSON.stringify(err.response.data).slice(0, 500)}`);
      }
      const hint = provider === 'ollama-local'
        ? ` — is Ollama running (\`ollama serve\`) at ${Config.ollamaLocalHost} with ${Config.aiModel} pulled (\`ollama pull ${Config.aiModel}\`)?`
        : provider === 'lm-studio'
          ? ` — is LM Studio's local server running (Developer tab -> Start Server) at ${Config.lmStudioHost} with a model loaded?`
          : '';
      throw new AIProviderError(`${label} request failed: ${err.message}${hint}`);
    }
  }

  /**
   * "Test Connection" button backing — a real, bounded-time round trip against whatever provider
   * is currently configured, not just a reachability probe. Confirms three things at once that
   * checkLocalOllama()/checkLocalLmStudio() can't: the endpoint is reachable, credentials (if
   * any) are actually valid, AND the configured model genuinely answers — a typo'd model name or
   * a server that's up but has no model loaded can still pass a bare reachability check yet fail
   * here. Single attempt, 20s timeout — this backs an interactive button, not a pipeline call,
   * so it must never sit retrying for minutes the way a real reconstruction call reasonably would.
   *
   * ai-delegation is handled separately: a real round trip there can legitimately take up to
   * AI_DELEGATION_TIMEOUT_MS (15 min default) waiting on a human's desktop Claude Code session,
   * which would leave the browser button hanging for no good reason — instead this reports the
   * worker's own already-tracked online/offline status, with an honest note that it isn't a live
   * call.
   */
  static async testConnection(): Promise<{ success: boolean; message: string; elapsedMs?: number }> {
    const provider = Config.aiProvider;
    const label = PROVIDER_LABELS[provider];

    if (!Config.aiEnabled) {
      return { success: false, message: 'AI is disabled (AI_ENABLED=false) — nothing to test.' };
    }

    if (provider === 'ai-delegation') {
      const worker = AiDelegationService.getWorkerStatus();
      if (worker.online) {
        return {
          success: true,
          message: `AiWindowsAssistant worker is online (last seen ${worker.lastSeenAt ? new Date(worker.lastSeenAt).toLocaleTimeString() : 'just now'}). This confirms a worker is polling — not a live test call, since a real one can take up to ${Math.round(Config.aiDelegationTimeoutMs / 60000)} min waiting on a desktop Claude Code session.`,
        };
      }
      return {
        success: false,
        message: worker.lastSeenAt
          ? `Worker not seen recently (last seen ${new Date(worker.lastSeenAt).toLocaleString()}) — is AiWindowsAssistant running?`
          : 'No AiWindowsAssistant worker has ever polled — copy the key below into its .env first.',
      };
    }

    if (!AIProvider.isConfigured()) {
      return { success: false, message: `${label} is not configured — set the required API key first.` };
    }

    const start = Date.now();
    try {
      const res = await AIProvider.chatCompletion(
        [{ role: 'user', content: 'Reply with exactly one word: OK' }],
        { timeoutMs: 20000, maxRetries: 1 },
      );
      const elapsedMs = Date.now() - start;
      const reply = res.content.trim().slice(0, 200);
      return {
        success: true,
        elapsedMs,
        message: `${label} responded in ${elapsedMs}ms — model ${Config.aiModel}: "${reply || '(empty response)'}"`,
      };
    } catch (err: any) {
      return { success: false, message: err.message || String(err) };
    }
  }

  /**
   * Flattens the chat messages into a single prompt (Claude Code's CLI takes one string, not a
   * role-tagged array) and hands it to the local delegation queue, then blocks until
   * AiWindowsAssistant claims and finishes it — see aiDelegationService.ts. No retry here: a
   * failed/timed-out delegation almost never means "try again immediately" the way a transient
   * HTTP 429 does, it means the worker isn't running or the desktop is offline — retrying
   * wouldn't fix that, it would just wait twice as long to report the same problem.
   */
  private static async chatCompletionViaDelegation(messages: ChatMessage[]): Promise<ChatCompletionResponse> {
    const prompt = messages.map(m => m.role === 'system' ? m.content : `${m.role === 'user' ? 'Task' : 'Assistant'}:\n${m.content}`).join('\n\n');
    const delegation = AiDelegationService.create(prompt);
    logger.info(`Delegated a prompt to AiWindowsAssistant (id ${delegation.id}) — waiting up to ${Config.aiDelegationTimeoutMs}ms.`);
    const finished = await AiDelegationService.waitForResult(delegation.id, Config.aiDelegationTimeoutMs);
    if (finished.status !== 'completed' || !finished.success) {
      throw new AIProviderError(`AI Delegation (Claude Code via AiWindowsAssistant) failed: ${finished.errorMessage || 'no result returned'}`);
    }
    return { content: finished.result || '', raw: finished };
  }

  /**
   * Live check for the Tool Setup panel — isConfigured() only reflects "AI_PROVIDER=ollama-local
   * was selected," not whether a server is actually listening there or has the model pulled.
   * Hits Ollama's own `/api/tags` (lists locally-pulled models — no chat call, no GPU work) with
   * a short timeout so the status page doesn't hang if nothing's listening on that port at all.
   * Only meaningful for the local provider; returns reachable:false for every other provider
   * without a network call (a Bearer-key check is already `isConfigured()`, hitting a paid API
   * here would be wasteful just to render a status badge).
   */
  static async checkLocalOllama(): Promise<{ reachable: boolean; modelPulled: boolean }> {
    if (Config.aiProvider !== 'ollama-local') return { reachable: false, modelPulled: false };
    try {
      const res = await axios.get(`${Config.ollamaLocalHost}/api/tags`, httpDefaults({ timeout: 2000 }));
      const models: string[] = (res.data?.models || []).map((m: any) => m.name || m.model);
      const wanted = Config.aiModel;
      // Ollama tags are `name:tag` (defaulting to `:latest`) — match either the exact tag or the
      // bare name, so AI_MODEL=qwen2.5-coder still matches a locally-pulled qwen2.5-coder:7b.
      const modelPulled = models.some(m => m === wanted || m.split(':')[0] === wanted.split(':')[0]);
      return { reachable: true, modelPulled };
    } catch {
      return { reachable: false, modelPulled: false };
    }
  }

  /**
   * Live check for the Tool Setup panel, same purpose as checkLocalOllama() above but against
   * LM Studio's own OpenAI-compatible `/v1/models` (lists whatever's currently loaded/available
   * in the app — no chat call, no GPU work). LM Studio's default single-model server mode uses
   * whichever model is loaded regardless of the request's own `model` field, so `modelPulled`
   * here really means "AI_MODEL matches something LM Studio currently reports" — a reachable
   * server with ANY model loaded will still work for a chat request even if this reports false
   * (it's advisory, not a hard gate the way it would be for ollama-local's tag-based pulls).
   */
  static async checkLocalLmStudio(): Promise<{ reachable: boolean; modelPulled: boolean }> {
    if (Config.aiProvider !== 'lm-studio') return { reachable: false, modelPulled: false };
    try {
      const res = await axios.get(`${Config.lmStudioHost}/v1/models`, httpDefaults({ timeout: 2000 }));
      const models: string[] = (res.data?.data || []).map((m: any) => m.id).filter(Boolean);
      const wanted = Config.aiModel;
      const modelPulled = models.some(m => m === wanted);
      return { reachable: true, modelPulled };
    } catch {
      return { reachable: false, modelPulled: false };
    }
  }
}
