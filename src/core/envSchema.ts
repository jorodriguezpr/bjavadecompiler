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
 * BJavaDecompiler - declarative schema for every .env setting the Tool Setup page can edit.
 *
 * Single source of truth for the settings form: adding a new tunable env var means adding one
 * entry here, not touching the route or the frontend markup separately. `type: 'secret'` fields
 * (the Ollama Cloud, OpenAI, and Anthropic API keys) are never echoed back to the browser after
 * the first save — GET returns an empty value with `secretIsSet` set instead, and POST leaves
 * the stored secret untouched whenever the field arrives blank, so "save without retyping the
 * key" can never accidentally wipe it.
 */

export type EnvFieldType = 'string' | 'number' | 'boolean' | 'select' | 'engines' | 'secret';

export interface EnvFieldSchema {
  key: string;
  label: string;
  type: EnvFieldType;
  group: 'Server' | 'AI Provider' | 'Pipeline Tuning' | 'Speed & Feature Toggles';
  /** Shown as placeholder/help text — usually the effective default when the var is unset. */
  help?: string;
  options?: string[]; // for type: 'select'
  /** Set changes to this key require a full process restart to take effect (reload-env can't
   * apply them — the HTTP server is already bound, etc). */
  restartRequired?: boolean;
}

export const ENV_SCHEMA: EnvFieldSchema[] = [
  { key: 'PORT', label: 'Port', type: 'number', group: 'Server', help: '7795', restartRequired: true },
  { key: 'NODE_ENV', label: 'Environment', type: 'select', group: 'Server', options: ['development', 'production'], help: 'development', restartRequired: true },

  { key: 'AI_ENABLED', label: 'AI enabled', type: 'boolean', group: 'AI Provider', help: 'Master switch — off runs the pipeline with zero AI dependency' },
  { key: 'AI_PROVIDER', label: 'Provider', type: 'select', group: 'AI Provider', options: ['ollama-cloud', 'ollama-local', 'lm-studio', 'openai', 'anthropic', 'ai-delegation'], help: 'ollama-cloud' },
  { key: 'AI_MODEL', label: 'Model', type: 'string', group: 'AI Provider', help: 'glm-5.2 (cloud) / qwen2.5-coder:7b (ollama-local) / whatever LM Studio has loaded (lm-studio) / gpt-4o-mini (openai) / claude-sonnet-5 (anthropic) — ignored by ai-delegation' },
  { key: 'OLLAMA_CLOUD_API_KEY', label: 'Ollama Cloud API key', type: 'secret', group: 'AI Provider' },
  { key: 'OLLAMA_CLOUD_HOST', label: 'Ollama Cloud host', type: 'string', group: 'AI Provider', help: 'https://ollama.com' },
  { key: 'OLLAMA_LOCAL_HOST', label: 'Local Ollama host', type: 'string', group: 'AI Provider', help: 'http://localhost:11434' },
  { key: 'LM_STUDIO_HOST', label: 'LM Studio host', type: 'string', group: 'AI Provider', help: 'http://localhost:1234 — LM Studio Developer tab -> Start Server' },
  { key: 'OPENAI_API_KEY', label: 'OpenAI API key', type: 'secret', group: 'AI Provider' },
  { key: 'OPENAI_HOST', label: 'OpenAI host', type: 'string', group: 'AI Provider', help: 'https://api.openai.com' },
  { key: 'ANTHROPIC_API_KEY', label: 'Anthropic API key', type: 'secret', group: 'AI Provider' },
  { key: 'ANTHROPIC_HOST', label: 'Anthropic host', type: 'string', group: 'AI Provider', help: 'https://api.anthropic.com' },
  { key: 'ANTHROPIC_MAX_TOKENS', label: 'Anthropic max output tokens', type: 'number', group: 'AI Provider', help: '8192 — the Messages API requires this on every request' },
  { key: 'AI_DELEGATION_TIMEOUT_MS', label: 'AI delegation timeout (ms)', type: 'number', group: 'AI Provider', help: '900000 (15 min) — how long to wait for AiWindowsAssistant to run a delegated prompt through Claude Code' },

  { key: 'MAX_UPLOAD_MB', label: 'Max upload size (MB)', type: 'number', group: 'Pipeline Tuning', help: '200' },
  { key: 'MAX_BUILD_FIX_ATTEMPTS', label: 'Max build-fix attempts', type: 'number', group: 'Pipeline Tuning', help: '5' },
  { key: 'AI_CONCURRENCY', label: 'AI batch concurrency', type: 'number', group: 'Pipeline Tuning', help: '3' },
  { key: 'AI_REQUEST_TIMEOUT_MS', label: 'AI request timeout (ms)', type: 'number', group: 'Pipeline Tuning', help: '300000 (5 min) — raise further for a slow "thinking" model on large files' },
  { key: 'DECOMPILER_TIMEOUT_MS', label: 'Decompiler timeout (ms)', type: 'number', group: 'Pipeline Tuning', help: '600000' },
  { key: 'SHARED_DEPENDENCIES_DIRS', label: 'Shared dependency library folder(s)', type: 'string', group: 'Pipeline Tuning', help: 'Local jar folder(s), separated by ; or , — searched by SHA-1/filename when a WEB-INF/lib jar can\'t be resolved on Maven Central, e.g. C:\\JavaProjects\\shared-libs' },
  { key: 'MISSING_PACKAGES_SEARCH_DIR', label: 'Missing-package search folder(s)', type: 'string', group: 'Pipeline Tuning', help: 'Additional folder(s), separated by ; or , — searched for classes missing from a WAR entirely. Accepts both jar files and already-decompiled source (each subdirectory treated as one module, like decompiled-libs/<artifactId>/)' },
  { key: 'JAVAEE_PROVIDED_LIBS_DIR', label: 'Java EE container library folder(s)', type: 'string', group: 'Pipeline Tuning', help: 'Folder(s), separated by ; or , — a real container install\'s own runtime libs (e.g. $GLASSFISH_HOME/glassfish/lib and .../modules) searched for a missing package the built-in provided-API catalog doesn\'t cover. Matches are added scope=provided, installed locally, never decompiled (it\'s the server\'s code, not the WAR\'s)' },
  { key: 'DEFAULT_TARGET_JAVA_VERSION', label: 'Default target Java version', type: 'select', group: 'Pipeline Tuning', options: ['auto', '8', '11', '17', '21'], help: 'auto — compiles against the bytecode-detected version (clamped to 8+). Any other value overrides detection for every job that doesn\'t set its own target; a per-job choice always wins over this' },
  { key: 'JDK_HOME_OVERRIDES', label: 'JDK home per Java version', type: 'string', group: 'Pipeline Tuning', help: 'e.g. 8=C:\\Program Files\\Java\\jdk1.8.0_202;11=C:\\Program Files\\Java\\jdk-11 — runs mvn with that JDK\'s own JAVA_HOME/PATH when compiling a job targeting that version, instead of whatever JDK satisfies the toolchain floor. Leave empty to always use the JDK already on PATH' },

  { key: 'DECOMPILE_ENGINES', label: 'Enabled engines', type: 'engines', group: 'Speed & Feature Toggles', help: 'All 5 when empty' },
  { key: 'DECOMPILE_UNRESOLVED_LIBS', label: 'Decompile unresolved dependency jars', type: 'boolean', group: 'Speed & Feature Toggles', help: 'Off leaves them as binary placeholders — the biggest speed lever for a WAR with many bundled jars' },
  { key: 'DECOMPILE_PARALLEL', label: 'Run engines in parallel', type: 'boolean', group: 'Speed & Feature Toggles', help: 'Faster on multi-core machines, higher peak memory' },
  { key: 'AUTO_MATCH_UNRESOLVED_DEPS', label: 'Auto-match unresolved dependencies by class search', type: 'boolean', group: 'Speed & Feature Toggles', help: 'When pom.properties/SHA-1/filename-guess all fail: vote across several of the jar\'s own classes on Maven Central instead of falling back to a placeholder' },
  { key: 'SEARCH_WORKSPACE_DECOMPILED_LIBS', label: 'Search other jobs\' decompiled libraries for missing packages', type: 'boolean', group: 'Speed & Feature Toggles', help: 'Off by default — reuses another job\'s already-decompiled dependency source when it covers a package this WAR is missing, instead of requiring a jar in the shared-dependencies folder' },
  { key: 'PRUNE_UNFIXABLE_DECOMPILED_CLASSES', label: 'Prune dead decompiled classes with no obtainable dependency', type: 'boolean', group: 'Speed & Feature Toggles', help: 'Off by default — moves (never deletes) a decompiled dependency\'s own source file out of the build when it references a package nothing can supply (e.g. com.sun.jdmk.comm) AND nothing else in the project references that class. More aggressive than other toggles here since it removes source from the compiled output.' },
];

export const ALL_ENGINES = ['cfr', 'vineflower', 'jdcli', 'jadx', 'procyon'];
