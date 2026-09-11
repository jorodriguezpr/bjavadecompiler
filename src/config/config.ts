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
 * Centralized configuration for BJavaDecompiler.
 * Reads from environment variables with sensible dev defaults.
 */

import path from 'path';
import fs from 'fs';
import { DecompilerEngine } from '../models/job';

const pkg = require('../../package.json');

export class Config {
  private static readonly BASE_PATH = path.resolve(__dirname, '../..');

  // ─── Paths ────────────────────────────────────────────────────────
  static get basePath(): string { return Config.BASE_PATH; }

  private static ensureDir(p: string): string {
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    return p;
  }

  static get dataPath(): string { return Config.ensureDir(path.join(Config.BASE_PATH, 'data')); }
  static get jobsPath(): string { return Config.ensureDir(path.join(Config.dataPath, 'jobs')); }
  static get uploadsPath(): string { return Config.ensureDir(path.join(Config.dataPath, 'uploads')); }
  static get workspacesPath(): string { return Config.ensureDir(path.join(Config.dataPath, 'workspaces')); }
  static get dependencyCachePath(): string { return path.join(Config.dataPath, 'dependency-cache.json'); }
  // Shared, app-wide cache of fully decompiled+AI-cleaned unresolved dependency jars, keyed by
  // the jar's own SHA-1 — the same internal/proprietary jar (e.g. a vendor's shared "-commons"
  // module) recurs byte-for-byte across many WARs from the same product suite, so a jar
  // decompiled once here never needs all 5 engines + AI re-run against it again.
  static get decompiledLibCachePath(): string { return Config.ensureDir(path.join(Config.dataPath, 'decompiled-lib-cache')); }
  // Shared, app-wide Maven local repository — NOT `~/.m2` (which may sit outside a locked-down
  // deployment's writable paths, e.g. a systemd service with ProtectSystem=yes exposing only
  // its own data dir; confirmed live: mvn failed silently there with "Read-only file system").
  // Shared across jobs (not per-workspace) so the compiler plugin etc. isn't re-downloaded
  // every single job.
  static get mavenLocalRepoPath(): string { return Config.ensureDir(path.join(Config.dataPath, 'm2-repo')); }
  static get themePath(): string { return path.join(Config.BASE_PATH, 'theme'); }
  static get logPath(): string { return Config.ensureDir(path.join(Config.BASE_PATH, 'logs')); }
  static get toolsPath(): string { return Config.ensureDir(path.join(Config.BASE_PATH, 'tools')); }

  // ─── Runtime ──────────────────────────────────────────────────────
  static get isDevelopment(): boolean { return process.env.NODE_ENV !== 'production'; }
  static get isDebug(): boolean { return Config.isDevelopment; }
  static get port(): number { return parseInt(process.env.PORT || '7795', 10); }
  static get publicUrl(): string { return process.env.PUBLIC_URL || `http://localhost:${Config.port}`; }

  // ─── Version / About ──────────────────────────────────────────────
  static getVersion(): string { return pkg.version || '1.0.0'; }
  static get appName(): string { return 'BJavaDecompiler'; }
  static get appDescription(): string { return pkg.description || ''; }
  static get author(): string { return pkg.author || 'Jose Rodriguez <jrpcone@gmail.com>'; }
  static get license(): string { return pkg.license || 'Apache-2.0'; }
  static get repositoryUrl(): string { return pkg.repository?.url || pkg.homepage || ''; }

  // ─── Upload / pipeline limits ─────────────────────────────────────
  static get maxUploadMb(): number { return parseInt(process.env.MAX_UPLOAD_MB || '200', 10); }
  static get maxBuildFixAttempts(): number { return parseInt(process.env.MAX_BUILD_FIX_ATTEMPTS || '5', 10); }
  static get aiConcurrency(): number { return parseInt(process.env.AI_CONCURRENCY || '3', 10); }
  /** Confirmed live: a "thinking"-capable model (e.g. kimi-k2.7-code) generating a full corrected
   * Java file plus its reasoning trace routinely exceeds the previous hardcoded 180s, especially
   * under Stage 5's concurrent batching — timing out mid-thought wastes the call AND its retries
   * (up to 3x) for nothing. Higher default gives real code-recovery quality room to actually
   * finish instead of silently degrading to more `failed_fallback`/unfixed files. */
  static get aiRequestTimeoutMs(): number { return parseInt(process.env.AI_REQUEST_TIMEOUT_MS || '300000', 10); }
  static get decompilerTimeoutMs(): number { return parseInt(process.env.DECOMPILER_TIMEOUT_MS || '600000', 10); }

  // ─── Speed/feature toggles ──────────────────────────────────────────
  // All three exist because the same pipeline that finishes a small plain jar in under a
  // minute can take hours on a WAR with many bundled third-party ("addon") jars once a slow
  // local model is doing the AI passes — confirmed live: a local 7B model is easily 10-50x
  // slower per call than Ollama Cloud's hosted models, and that cost multiplies across every
  // AI-flagged class in every unresolved dependency, not just the app's own code.

  /** Master AI kill switch — independent of whether a provider is otherwise configured. Set
   * AI_ENABLED=false to force the zero-AI path: decompiler-winner output is kept as-is,
   * deterministic (no-AI) remediation still runs, but nothing waits on an LLM call. Wired
   * through AIProvider.isConfigured() so every AI-gated call site (reconstruction,
   * remediation, and unresolved-lib AI cleanup) picks this up automatically. */
  static get aiEnabled(): boolean {
    return (process.env.AI_ENABLED ?? 'true').trim().toLowerCase() !== 'false';
  }

  /** Which decompiler engines actually run, both against the app's own classes and against
   * each unresolved dependency jar. Defaults to all five (unchanged behavior). Comma-separated,
   * e.g. DECOMPILE_ENGINES=cfr,vineflower to skip the other three entirely — no install check,
   * no invocation, no wait. cfr+vineflower are the two most actively-maintained engines and were
   * the fastest to start in local testing; jd-cli (GPLv3, weakest upstream maintenance — see
   * unresolvedLibDecompiler.ts) and procyon (unmaintained upstream since ~2022) are the two
   * safest to drop first for speed, jadx third (an Android-focused decompiler included mainly
   * for extra coverage on this JVM/WAR use case, and the heaviest JVM startup of the five). */
  static get enabledEngines(): DecompilerEngine[] {
    const ALL: DecompilerEngine[] = ['cfr', 'vineflower', 'jdcli', 'jadx', 'procyon'];
    const raw = process.env.DECOMPILE_ENGINES;
    if (!raw?.trim()) return ALL;
    const requested = raw.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const filtered = ALL.filter(e => requested.includes(e));
    return filtered.length ? filtered : ALL; // never silently end up with zero engines
  }

  /** The single biggest lever for a WAR with many bundled "addon"/third-party jars: decompiling
   * every unresolved one with every enabled engine, then AI-cleaning every flagged class in each
   * — multiplying the app's own decompile+AI cost by however many unresolved jars it has. Set
   * DECOMPILE_UNRESOLVED_LIBS=false to skip this stage entirely; unresolved dependencies fall
   * back to the original opaque install-file placeholder (pre-dates this feature, still fully
   * supported) instead of being decompiled and inlined as real source. */
  static get decompileUnresolvedLibs(): boolean {
    return (process.env.DECOMPILE_UNRESOLVED_LIBS ?? 'true').trim().toLowerCase() !== 'false';
  }

  /** Runs the enabled engines concurrently instead of one-after-another — each is an independent
   * child process writing to its own output directory, so this is safe, but N JVMs running at
   * once means proportionally higher peak memory, which matters more on a machine already
   * running a local LLM. Opt-in (default false, current sequential behavior) rather than a free
   * win for everyone. */
  static get decompileParallel(): boolean {
    return (process.env.DECOMPILE_PARALLEL ?? 'false').trim().toLowerCase() === 'true';
  }

  /** Last-resort auto-fix for a dependency the pom.properties/SHA-1/filename-guess passes all
   * failed on: search Maven Central by several of the jar's own classes and vote (see
   * mavenSearchService.ts's autoMatchDependency()) instead of falling straight to an opaque
   * placeholder coordinate. Only ever replaces what would otherwise be 'unresolved' — can't make
   * a working match worse, so this defaults on. Marked as 'auto-class-match' confidence (not
   * 'sha1-match'/'pom-properties' certainty) everywhere it's shown, and a human can still
   * override it via the manual Maven search in the Dependencies panel. */
  static get autoMatchUnresolvedDeps(): boolean {
    return (process.env.AUTO_MATCH_UNRESOLVED_DEPS ?? 'true').trim().toLowerCase() !== 'false';
  }

  /** One or more local folders of known-good jars, searched by dependencyResolutionService.ts as
   * a last resort when a bundled WEB-INF/lib jar can't be resolved to a real Maven Central
   * coordinate — useful for internal/proprietary libraries (other modules of the same in-house
   * product, vendor jars pulled from a private repo) that will never show up in a public Central
   * search no matter how good the heuristic. Accepts `;` or `,` as a separator (Windows
   * PATH-style, and comma-friendly for anyone listing paths without drive-letter colons in mind);
   * each entry is trimmed and silently skipped at scan time if it doesn't exist, so a stale or
   * typo'd entry never crashes resolution — it just means that one folder contributes nothing. */
  static get sharedDependenciesDirs(): string[] {
    const raw = process.env.SHARED_DEPENDENCIES_DIRS || '';
    return raw.split(/[;,]/).map(s => s.trim()).filter(Boolean);
  }

  /** One or more additional local folders searched ONLY for classes missing from a WAR entirely
   * (see sharedLibraryPackageSearchService.ts) — kept separate from sharedDependenciesDirs so a
   * broad "everything I might ever need" archive can be pointed at just this search without also
   * being scanned by the (SHA-1/filename-based) already-bundled-jar matcher above, which cares
   * about identity, not just package coverage. Same `;`/`,` separator convention. Both lists are
   * combined when the missing-package index is built — this is purely additive. */
  static get missingPackagesSearchDirs(): string[] {
    const raw = process.env.MISSING_PACKAGES_SEARCH_DIR || '';
    return raw.split(/[;,]/).map(s => s.trim()).filter(Boolean);
  }

  /** When enabled, missing-package search also looks across every OTHER job's already-decompiled
   * dependency source (data/workspaces/<jobId>/decompiled-libs/<artifactId>/) — useful when
   * several WARs from the same product suite bundle overlapping internal modules: a class missing
   * from THIS WAR may already have been decompiled (and AI-cleaned) as an unresolved dependency of
   * a DIFFERENT job. Off by default — scanning every prior job's decompiled output on every build-
   * fix attempt is real, avoidable work for anyone not running related WARs through this app. */
  static get searchWorkspaceDecompiledLibs(): boolean {
    return (process.env.SEARCH_WORKSPACE_DECOMPILED_LIBS ?? 'false').trim().toLowerCase() === 'true';
  }

  /** One or more local folders containing a real Java EE/Jakarta EE container installation's own
   * runtime libraries — e.g. `$GLASSFISH_HOME/glassfish/lib` + `$GLASSFISH_HOME/glassfish/modules`
   * for GlassFish, or the equivalent for WildFly/WebSphere/Payara. A WAR never bundles these (the
   * container supplies javax.mail/javax.ejb/javax.transaction/CDI/JAX-RS/etc. at runtime), so a
   * class from one of them shows up as `package X does not exist` during build verification with
   * no jar anywhere in WEB-INF/lib to explain it. Consulted only for packages
   * PROVIDED_API_CATALOG's static table doesn't already cover (a vendor extension, an older/newer
   * spec version) — a match here gets install:install-file'd into the local repo and added as a
   * `provided`-scope dependency, but is never decompiled (it's the container's own code, not the
   * WAR's). Same `;`/`,` separator convention as sharedDependenciesDirs. */
  static get javaEeProvidedLibsDirs(): string[] {
    const raw = process.env.JAVAEE_PROVIDED_LIBS_DIR || '';
    return raw.split(/[;,]/).map(s => s.trim()).filter(Boolean);
  }

  /** Global default Java release to compile every generated project against, when a job doesn't
   * set its own targetJavaVersion (see DecompileJob.targetJavaVersion) — e.g. "most of what I feed
   * this app targets Java 8 even though I run NetBeans on JDK 17". 'auto' (the default) keeps the
   * existing bytecode-detected-and-clamped-to-8 behavior; any other value here always overrides
   * detection. A per-job choice still wins over this when both are set. */
  static get defaultTargetJavaVersion(): number | null {
    const raw = (process.env.DEFAULT_TARGET_JAVA_VERSION || 'auto').trim().toLowerCase();
    if (!raw || raw === 'auto') return null;
    const n = parseInt(raw, 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  }

  /** Maps a Java release number to a real local JDK installation's home directory, so `mvn` for
   * that job actually runs with THAT JDK's own javac (JAVA_HOME/PATH override on the subprocess —
   * see mavenVerifyService.ts) instead of always using whatever single JDK satisfies
   * toolchainCheck.ts's floor. Format: `8=C:\Program Files\Java\jdk1.8.0_202;11=C:\...\jdk-11`
   * (same `;`/`,`-separated-entries convention as every other multi-value Config getter here, one
   * level deeper with a `version=path` pair per entry). A version with no matching entry falls
   * back to running `mvn` on whatever's already on PATH — same as before this feature existed,
   * so an empty/unset value changes nothing. */
  static get jdkHomeOverrides(): Map<number, string> {
    const raw = process.env.JDK_HOME_OVERRIDES || '';
    const map = new Map<number, string>();
    for (const entry of raw.split(/[;,]/).map(s => s.trim()).filter(Boolean)) {
      const eq = entry.indexOf('=');
      if (eq === -1) continue;
      const version = parseInt(entry.slice(0, eq).trim(), 10);
      const home = entry.slice(eq + 1).trim();
      if (Number.isFinite(version) && home) map.set(version, home);
    }
    return map;
  }

  /** The configured JDK home for a given Java release, or null when nothing is configured for it
   * (the normal case — falls back to running `mvn` on whatever JDK is already on PATH). */
  static jdkHomeForVersion(javaVersion: number): string | null {
    return Config.jdkHomeOverrides.get(javaVersion) || null;
  }

  /** Last-resort, opt-in remediation (see deadCodePruningService.ts) for a missing package that
   * genuinely has no jar or previously-decompiled library anywhere (e.g. com.sun.jdmk.comm — a
   * Sun JVM extension with no redistributable Maven artifact under any coordinate). When enabled,
   * a decompiled dependency's own source file that references such a package AND is referenced by
   * nothing else in the project gets moved (never deleted) out of the compiled path, instead of
   * leaving the build permanently broken by dead optional code (confirmed real case: log4j's own
   * bundled, never-instantiated JMSAppender/JMX Agent classes). Off by default — this is
   * meaningfully more aggressive than every other remediation step in this app, since it removes
   * source from the compiled output rather than just adding/excluding a dependency. */
  static get pruneUnfixableDecompiledClasses(): boolean {
    return (process.env.PRUNE_UNFIXABLE_DECOMPILED_CLASSES ?? 'false').trim().toLowerCase() === 'true';
  }

  // ─── AI provider ────────────────────────────────────────────────────
  // ollama-cloud (default) | ollama-local | openai | anthropic | ai-delegation. The last one
  // has nothing to do with Ollama at all: it hands the prompt to a local AiWindowsAssistant
  // instance (see aiDelegationService.ts), which runs it through the user's own authenticated
  // Claude Code CLI on their desktop and posts the result back — for a Claude Code subscription
  // with no separate API key. `anthropic` is the other way to use Claude: a direct Anthropic API
  // key, no AiWindowsAssistant or desktop dependency at all — for anyone who'd rather pay for API
  // access directly than run a second app.
  static get aiProvider(): 'ollama-cloud' | 'ollama-local' | 'lm-studio' | 'openai' | 'anthropic' | 'ai-delegation' {
    const v = (process.env.AI_PROVIDER || '').trim().toLowerCase();
    if (v === 'ollama-local' || v === 'lm-studio' || v === 'openai' || v === 'anthropic' || v === 'ai-delegation') return v;
    return 'ollama-cloud';
  }

  // Two env var names both seen in this portfolio (SysAdminCenterHCP uses *_HOST,
  // AiWindowsAssistant/AiAgentAssistant use *_BASE_URL) — accept either.
  static get ollamaCloudHost(): string {
    return process.env.OLLAMA_CLOUD_HOST || process.env.OLLAMA_CLOUD_BASE_URL || 'https://ollama.com';
  }
  static get ollamaCloudApiKey(): string {
    return process.env.OLLAMA_CLOUD_API_KEY || process.env.AI_API_KEY || '';
  }

  /** `ollama serve`'s default local address — 11434 is Ollama's own fixed default port, not
   * something this app picks. OLLAMA_HOST is the env var Ollama's own CLI/docs use for this,
   * so accept it directly rather than inventing a BJavaDecompiler-specific name. */
  static get ollamaLocalHost(): string {
    return process.env.OLLAMA_LOCAL_HOST || process.env.OLLAMA_HOST || 'http://localhost:11434';
  }

  /** LM Studio's built-in local server — 1234 is its own fixed default port (Developer tab ->
   * "Start Server"). Speaks the OpenAI Chat Completions shape at /v1/chat/completions, so its
   * request path in core/aiProvider.ts reuses the same branch as the 'openai' provider — only the
   * base URL and (lack of) auth differ. */
  static get lmStudioHost(): string {
    return process.env.LM_STUDIO_HOST || 'http://localhost:1234';
  }

  /** Default model differs by provider — glm-5.2 is an Ollama Cloud-hosted model with no local
   * equivalent, and qwen2.5-coder:7b (a strong, widely-available local coding model that fits
   * comfortably on consumer GPUs at 7B) makes a sensible local default. AI_MODEL always wins
   * when set, for either provider — e.g. AI_MODEL=deepseek-coder-v2:16b for a different local
   * pull, or AI_MODEL=qwen2.5-coder:32b on a machine with more VRAM. */
  static get aiModel(): string {
    if (process.env.AI_MODEL) return process.env.AI_MODEL;
    switch (Config.aiProvider) {
      case 'ollama-local': return 'qwen2.5-coder:7b';
      // LM Studio's built-in server only ever serves whichever single model is currently loaded
      // in the app — it ignores the `model` field on the request entirely for that common case,
      // so there's no real "sensible default" the way ollama-local's tag-based pull has. This
      // placeholder is never actually sent-and-honored; set AI_MODEL explicitly to match what
      // LM Studio's own model-picker shows if you're running its newer multi-model server mode.
      case 'lm-studio': return 'local-model';
      case 'openai': return 'gpt-4o-mini';
      case 'anthropic': return 'claude-sonnet-5';
      default: return 'glm-5.2'; // ollama-cloud; ai-delegation ignores this entirely (Claude Code uses its own configured model)
    }
  }

  // ─── OpenAI ─────────────────────────────────────────────────────────
  static get openaiApiKey(): string { return process.env.OPENAI_API_KEY || ''; }
  static get openaiHost(): string { return process.env.OPENAI_HOST || 'https://api.openai.com'; }

  // ─── Anthropic (direct Claude API — no AiWindowsAssistant/Claude Code CLI involved) ─────
  static get anthropicApiKey(): string { return process.env.ANTHROPIC_API_KEY || ''; }
  static get anthropicHost(): string { return process.env.ANTHROPIC_HOST || 'https://api.anthropic.com'; }
  /** The Messages API requires max_tokens on every request (no server-side default, unlike
   * OpenAI/Ollama) — high enough that a full-class reconstruction response isn't truncated
   * mid-file, which would otherwise hand the pipeline invalid Java to try to compile. */
  static get anthropicMaxTokens(): number {
    return parseInt(process.env.ANTHROPIC_MAX_TOKENS || '8192', 10);
  }

  // ─── AI delegation (AiWindowsAssistant → local Claude Code) ────────
  /** Bearer token AiWindowsAssistant's poll loop authenticates with against
   * /api/ai-delegation/worker/* — auto-generated on first need by aiDelegationService.ts and
   * written into .env via Config.writeEnvValues(), same as every other setting this session's
   * settings editor manages. Read-only here; nothing under Config itself generates it. */
  static get aiDelegationWorkerApiKey(): string { return process.env.AI_DELEGATION_WORKER_API_KEY || ''; }

  /** How long chatCompletion() waits for a human-run desktop worker to claim and finish a
   * delegated prompt before giving up — generous by design (15 min default): unlike a cloud API
   * call, this depends on a machine being awake, AiWindowsAssistant running, and an actual
   * Claude Code turn completing, which can legitimately take minutes for a substantial prompt. */
  static get aiDelegationTimeoutMs(): number {
    return parseInt(process.env.AI_DELEGATION_TIMEOUT_MS || '900000', 10);
  }

  /** A worker that's never once polled isn't "offline", it just isn't set up yet — same
   * lastSeenAt:null-is-not-alert-worthy distinction SysAdminCenterHCP's Guardian escalation
   * worker status already makes. */
  static get aiDelegationWorkerOfflineThresholdMinutes(): number {
    return parseInt(process.env.AI_DELEGATION_WORKER_OFFLINE_THRESHOLD_MINUTES || '5', 10);
  }

  /**
   * Re-reads .env into process.env and returns which keys actually changed — no process
   * restart needed for most of this: every getter above reads process.env live on each call
   * rather than caching a value at startup, so a job started right after this call already sees
   * the new AI_ENABLED/AI_PROVIDER/DECOMPILE_* etc. The one cached exception is AIProvider's
   * axios client, which already detects a provider change and rebuilds itself (see
   * core/aiProvider.ts) — nothing else in the AI/pipeline path needs special handling here.
   *
   * Real exceptions that a live reload can NOT apply: PORT (the HTTP server is already bound),
   * and anything under Paths (data/tools/logs dirs — read once at first use and, for several,
   * memoized as directories already created on disk). Both are called out in the returned
   * `restartRequiredFor` list so the caller can warn instead of silently no-op'ing them.
   */
  static reloadFromEnvFile(): { changed: string[]; restartRequiredFor: string[] } {
    const dotenv = require('dotenv');
    const before = { ...process.env };
    const result = dotenv.config({ path: Config.envFilePath, override: true });
    if (result.error) throw result.error;

    const changed = Object.keys(result.parsed || {}).filter(k => before[k] !== process.env[k]);
    const restartRequiredFor = changed.filter(k => RESTART_REQUIRED_KEYS.has(k));
    return { changed, restartRequiredFor };
  }

  static get envFilePath(): string { return path.join(Config.BASE_PATH, '.env'); }

  /** Parses the raw .env file into a flat key->value map (comments/blank lines skipped, quoted
   * values unwrapped) — used to prefill the Tool Setup settings form. Returns {} if .env doesn't
   * exist yet rather than throwing; a fresh checkout with no .env is a valid (if unconfigured)
   * state, same as every Config getter's own env-var fallback already assumes. */
  static readEnvFile(): Record<string, string> {
    if (!fs.existsSync(Config.envFilePath)) return {};
    const text = fs.readFileSync(Config.envFilePath, 'utf8');
    const values: Record<string, string> = {};
    for (const line of text.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq === -1) continue;
      const key = trimmed.slice(0, eq).trim();
      let value = trimmed.slice(eq + 1).trim();
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      values[key] = value;
    }
    return values;
  }

  /**
   * Upserts the given keys into the .env file on disk, preserving every other line (comments,
   * ordering, blank lines) exactly as-is — this rewrites individual `KEY=...` lines in place via
   * per-key regex rather than regenerating the whole file from a value map, since the latter
   * would silently throw away the user's own comments/section headers. A key with no existing
   * line is appended at the end. Does NOT reload process.env itself — call
   * reloadFromEnvFile() after, same two-step shape as writing a file then re-reading it.
   */
  static writeEnvValues(updates: Record<string, string>): void {
    let text = fs.existsSync(Config.envFilePath) ? fs.readFileSync(Config.envFilePath, 'utf8') : '';
    for (const [key, rawValue] of Object.entries(updates)) {
      const needsQuotes = /[\s#"]/.test(rawValue);
      const value = needsQuotes ? `"${rawValue.replace(/"/g, '\\"')}"` : rawValue;
      const line = `${key}=${value}`;
      const lineRe = new RegExp(`^${key}=.*$`, 'm');
      if (lineRe.test(text)) {
        text = text.replace(lineRe, line);
      } else {
        text = text.replace(/\n?$/, `\n${line}\n`);
      }
    }
    fs.writeFileSync(Config.envFilePath, text, 'utf8');
  }
}

/** Which .env keys a live reload (reloadFromEnvFile) can NOT apply — the process already bound
 * to the old PORT, NODE_ENV affects things resolved once at startup (e.g. Config.isDevelopment-
 * gated setup). Kept here rather than duplicated in envSchema.ts's per-field restartRequired
 * flags — this set is what reloadFromEnvFile actually checks against; the schema flags are for
 * the settings-form UI to show the same warning before the user even saves. */
const RESTART_REQUIRED_KEYS = new Set(['PORT', 'NODE_ENV']);
