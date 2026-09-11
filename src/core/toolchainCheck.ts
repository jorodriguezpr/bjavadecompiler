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
 * BJavaDecompiler - JDK / Maven toolchain detection.
 *
 * Vineflower and the jd-core fork jd-cli wraps both require Java 17+; the final
 * `mvn compile` verification step needs a real Maven install. These checks never throw —
 * the web UI must stay reachable to *show* the diagnostic — callers gate the Upload action
 * on the result instead.
 */

import { spawn } from 'child_process';
import { Logger } from './logger';

const logger = Logger.getLogger('ToolchainCheck');

export interface ToolVersionResult {
  available: boolean;
  version: string | null;
  majorVersion: number | null;
  error?: string;
}

export interface ToolchainStatus {
  java: ToolVersionResult;
  maven: ToolVersionResult;
  ready: boolean;
}

/** On Windows, `mvn` resolves to `mvn.cmd` — spawn with shell:true so PATH resolution matches what a real terminal would find. */
function runVersionCommand(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { shell: true, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', (d) => { stdout += d.toString(); });
    child.stderr?.on('data', (d) => { stderr += d.toString(); });
    child.on('error', (err) => resolve({ stdout, stderr: err.message, code: -1 }));
    child.on('close', (code) => resolve({ stdout, stderr, code }));
  });
}

export async function checkJava(): Promise<ToolVersionResult> {
  const { stdout, stderr, code } = await runVersionCommand('java', ['-version']);
  const combined = `${stdout}\n${stderr}`;
  if (code !== 0 && !combined.includes('version')) {
    return { available: false, version: null, majorVersion: null, error: stderr || 'java not found on PATH' };
  }
  // `java version "17.0.9"` (old style) or `openjdk version "21.0.1"` (new style, still quoted)
  const match = combined.match(/version "(\d+)(?:\.(\d+))?/);
  if (!match) {
    return { available: false, version: null, majorVersion: null, error: 'Could not parse java -version output' };
  }
  // Old versioning (1.8.0_xxx) reports major as "1" with the real major in the next segment.
  const first = parseInt(match[1], 10);
  const major = first === 1 ? parseInt(match[2] || '0', 10) : first;
  // `java -version` writes to stderr, not stdout — combined's first line can be an empty
  // leading stdout line, so pick the actual "version" line rather than assuming position 0.
  const versionLine = combined.split('\n').find(l => l.includes('version')) || combined.split('\n')[0];
  return { available: true, version: versionLine.trim(), majorVersion: major };
}

export async function checkMaven(): Promise<ToolVersionResult> {
  const { stdout, stderr, code } = await runVersionCommand('mvn', ['-version']);
  const combined = `${stdout}\n${stderr}`;
  if (code !== 0 && !combined.toLowerCase().includes('apache maven')) {
    return { available: false, version: null, majorVersion: null, error: stderr || 'mvn not found on PATH' };
  }
  const match = combined.match(/Apache Maven (\d+)\.(\d+)/i);
  const versionLine = combined.split('\n').find(l => /apache maven/i.test(l)) || combined.split('\n')[0];
  return {
    available: true,
    version: versionLine.trim(),
    majorVersion: match ? parseInt(match[1], 10) : null,
  };
}

const MIN_JAVA_MAJOR = 17;

export async function checkToolchain(): Promise<ToolchainStatus> {
  const [java, maven] = await Promise.all([checkJava(), checkMaven()]);
  const javaOk = java.available && (java.majorVersion === null || java.majorVersion >= MIN_JAVA_MAJOR);
  const ready = javaOk && maven.available;
  if (!ready) {
    logger.warn('Toolchain not ready', { java, maven });
  }
  return { java, maven, ready };
}
