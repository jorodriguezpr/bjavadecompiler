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
 * BJavaDecompiler - external decompiler jar bootstrapping (CFR, Vineflower, jd-cli, JADX).
 *
 * Never silently downloads on the critical path of a job — the Tool Setup UI drives this
 * explicitly so a multi-minute first-run download isn't mistaken for a hang. Versions are
 * resolved from each artifact's real source (Maven Central for CFR/Vineflower, GitHub
 * Releases for jd-cli/JADX) rather than hardcoded, and verified against Maven Central's own
 * published .sha1 checksum where available — pinning a checksum we can't independently
 * confirm right now would be worse than fetching the live one from the same trusted host
 * the jar itself comes from.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import axios from 'axios';
import AdmZip from 'adm-zip';
import { Config } from '../config/config';
import { Logger } from './logger';
import { httpDefaults } from './httpRetry';

const logger = Logger.getLogger('ExternalTools');

export type EngineName = 'cfr' | 'vineflower' | 'jdcli' | 'jadx' | 'procyon';

export interface EngineStatus {
  name: EngineName;
  installed: boolean;
  version: string | null;
  jarPath: string | null;
  sizeBytes: number | null;
  checksumVerified: boolean;
}

interface ManifestEntry {
  version: string | null;
  jarPath: string | null;
  sha1: string | null; // Maven Central artifacts only
  sha256: string | null; // jd-cli — a locally-computed hash, logged for reference even when unverified
  /** True only when the hash was actually checked against a trusted published value — a
   * stored hash existing at all (e.g. jd-cli's, which has nothing to compare against) does
   * NOT imply this. Kept as its own field rather than derived from `sha1 || sha256` being
   * non-null, which was silently wrong (a merely-computed, never-confirmed jd-cli hash made
   * the status endpoint report "verified"). */
  verified: boolean;
  fetchedAt: string | null;
}

interface Manifest {
  cfr: ManifestEntry;
  vineflower: ManifestEntry;
  jdcli: ManifestEntry;
  jadx: ManifestEntry;
  procyon: ManifestEntry;
}

const EMPTY_ENTRY: ManifestEntry = { version: null, jarPath: null, sha1: null, sha256: null, verified: false, fetchedAt: null };

function manifestPath(): string {
  return path.join(Config.toolsPath, 'manifest.json');
}

function loadManifest(): Manifest {
  const fresh: Manifest = { cfr: { ...EMPTY_ENTRY }, vineflower: { ...EMPTY_ENTRY }, jdcli: { ...EMPTY_ENTRY }, jadx: { ...EMPTY_ENTRY }, procyon: { ...EMPTY_ENTRY } };
  const p = manifestPath();
  if (fs.existsSync(p)) {
    try {
      // Merge onto fresh defaults rather than trusting the parsed JSON directly — an older
      // manifest.json written before a new engine was added here would otherwise come back
      // missing that key entirely and crash the first time it's accessed.
      return { ...fresh, ...JSON.parse(fs.readFileSync(p, 'utf8')) };
    } catch {
      // fall through to a fresh manifest
    }
  }
  return fresh;
}

function saveManifest(m: Manifest): void {
  fs.writeFileSync(manifestPath(), JSON.stringify(m, null, 2), 'utf8');
}

async function sha1File(filePath: string): Promise<string> {
  const buf = await fs.promises.readFile(filePath);
  return crypto.createHash('sha1').update(buf).digest('hex');
}

async function sha256File(filePath: string): Promise<string> {
  const buf = await fs.promises.readFile(filePath);
  return crypto.createHash('sha256').update(buf).digest('hex');
}

async function downloadFile(url: string, destPath: string): Promise<void> {
  const res = await axios.get(url, httpDefaults({ responseType: 'arraybuffer', timeout: 120000 }));
  await fs.promises.writeFile(destPath, res.data);
}

/** Resolve the latest released version of a Maven Central artifact. */
async function resolveLatestCentralVersion(groupId: string, artifactId: string): Promise<string> {
  const res = await axios.get('https://search.maven.org/solrsearch/select', httpDefaults({
    params: { q: `g:${groupId} AND a:${artifactId}`, rows: 1, wt: 'json' },
    timeout: 30000,
  }));
  const doc = res.data?.response?.docs?.[0];
  if (!doc?.latestVersion) {
    throw new Error(`Could not resolve latest version for ${groupId}:${artifactId} from Maven Central`);
  }
  return doc.latestVersion;
}

async function ensureCentralArtifact(name: EngineName, groupId: string, artifactId: string): Promise<EngineStatus> {
  const manifest = loadManifest();
  const entry = manifest[name];

  if (entry.jarPath && fs.existsSync(path.join(Config.toolsPath, entry.jarPath))) {
    const jarPath = path.join(Config.toolsPath, entry.jarPath);
    const stat = await fs.promises.stat(jarPath);
    return {
      name, installed: true, version: entry.version, jarPath,
      sizeBytes: stat.size, checksumVerified: entry.verified,
    };
  }

  logger.info(`[${name}] not cached — resolving latest version from Maven Central...`);
  const version = await resolveLatestCentralVersion(groupId, artifactId);
  const groupPath = groupId.replace(/\./g, '/');
  const baseUrl = `https://repo1.maven.org/maven2/${groupPath}/${artifactId}/${version}/${artifactId}-${version}.jar`;
  const jarFile = `${name}-${version}.jar`;
  const jarPath = path.join(Config.toolsPath, jarFile);

  logger.info(`[${name}] downloading ${baseUrl}`);
  await downloadFile(baseUrl, jarPath);

  let sha1: string | null = null;
  let checksumVerified = false;
  try {
    const sha1Res = await axios.get(`${baseUrl}.sha1`, httpDefaults({ timeout: 30000 }));
    const published = String(sha1Res.data).trim().split(/\s+/)[0];
    const actual = await sha1File(jarPath);
    checksumVerified = published.toLowerCase() === actual.toLowerCase();
    sha1 = actual;
    if (!checksumVerified) {
      await fs.promises.unlink(jarPath);
      throw new Error(`SHA-1 mismatch for ${jarFile} — published ${published}, got ${actual}. Deleted, not trusting this download.`);
    }
  } catch (err: any) {
    if (!checksumVerified) throw err;
  }

  const stat = await fs.promises.stat(jarPath);
  manifest[name] = { version, jarPath: jarFile, sha1, sha256: null, verified: checksumVerified, fetchedAt: new Date().toISOString() };
  saveManifest(manifest);

  logger.info(`[${name}] installed v${version} (${stat.size} bytes, checksum verified: ${checksumVerified})`);
  return { name, installed: true, version, jarPath, sizeBytes: stat.size, checksumVerified };
}

async function ensureJdCli(): Promise<EngineStatus> {
  const manifest = loadManifest();
  const entry = manifest.jdcli;

  if (entry.jarPath && fs.existsSync(path.join(Config.toolsPath, entry.jarPath))) {
    const jarPath = path.join(Config.toolsPath, entry.jarPath);
    const stat = await fs.promises.stat(jarPath);
    return {
      name: 'jdcli', installed: true, version: entry.version, jarPath,
      sizeBytes: stat.size, checksumVerified: entry.verified,
    };
  }

  logger.info('[jdcli] not cached — resolving latest release from GitHub...');
  const rel = await axios.get('https://api.github.com/repos/intoolswetrust/jd-cli/releases/latest', httpDefaults({ timeout: 30000 }));
  const assets: any[] = rel.data?.assets || [];
  // jd-cli doesn't publish a bare .jar release asset — only a "-dist.zip"/"-dist.tar.gz"
  // bundle (jar + launcher scripts + license, confirmed by inspecting a real release: the jar
  // itself is self-contained, no separate lib/ dependencies to worry about). Use the .zip
  // variant since AdmZip (already a dependency for WAR/JAR extraction) can pull just the jar
  // out of it without needing a separate tar library.
  const distAsset = assets.find(a => /\.zip$/i.test(a.name) && /jd-cli/i.test(a.name));
  if (!distAsset) throw new Error('jd-cli release has no matching -dist.zip asset — check the repo manually.');

  const version = rel.data.tag_name || 'unknown';
  const zipTempPath = path.join(Config.toolsPath, `jdcli-${version}-dist.zip.tmp`);
  logger.info(`[jdcli] downloading ${distAsset.browser_download_url}`);
  await downloadFile(distAsset.browser_download_url, zipTempPath);

  const jarFile = `jdcli-${version}.jar`;
  const jarPath = path.join(Config.toolsPath, jarFile);
  const zip = new AdmZip(zipTempPath);
  const jarEntry = zip.getEntries().find(e => /(^|\/)jd-cli\.jar$/i.test(e.entryName));
  if (!jarEntry) {
    await fs.promises.unlink(zipTempPath);
    throw new Error(`jd-cli dist archive did not contain jd-cli.jar — entries were: ${zip.getEntries().map(e => e.entryName).join(', ')}`);
  }
  await fs.promises.writeFile(jarPath, jarEntry.getData());
  await fs.promises.unlink(zipTempPath);

  // GitHub doesn't publish a checksum for the jar file *inside* the dist archive — best-effort
  // only. Not treated as a hard failure since jd-cli/jd-core is already the lowest-priority
  // engine of the three (GPLv3, weakest maintenance) and its output is validated the same way
  // as the others' regardless: by whether the assembled project actually compiles.
  const sha256 = await sha256File(jarPath);
  const checksumVerified = false;
  logger.warn(`[jdcli] no published checksum available for the jar inside the dist archive — computed SHA-256 ${sha256} logged for manual verification, not auto-confirmed.`);

  const stat = await fs.promises.stat(jarPath);
  manifest.jdcli = { version, jarPath: jarFile, sha1: null, sha256, verified: checksumVerified, fetchedAt: new Date().toISOString() };
  saveManifest(manifest);

  return { name: 'jdcli', installed: true, version, jarPath, sizeBytes: stat.size, checksumVerified };
}

async function ensureJadx(): Promise<EngineStatus> {
  const manifest = loadManifest();
  const entry = manifest.jadx;

  if (entry.jarPath && fs.existsSync(path.join(Config.toolsPath, entry.jarPath))) {
    const jarPath = path.join(Config.toolsPath, entry.jarPath);
    const stat = await fs.promises.stat(jarPath);
    return {
      name: 'jadx', installed: true, version: entry.version, jarPath,
      sizeBytes: stat.size, checksumVerified: entry.verified,
    };
  }

  logger.info('[jadx] not cached — resolving latest release from GitHub...');
  const rel = await axios.get('https://api.github.com/repos/skylot/jadx/releases/latest', httpDefaults({ timeout: 30000 }));
  const assets: any[] = rel.data?.assets || [];
  // The CLI+GUI bundle is `jadx-<version>.zip` — NOT `jadx-gui-*` (a separate, GUI-only
  // asset). Confirmed live: the bundle's lib/jadx-<version>-all.jar is a self-contained fat
  // jar, but it must be run as `java -cp <jar> jadx.cli.JadxCLI ...`, not `java -jar` — the
  // jar's own manifest launches the Swing GUI by default (crashes with
  // GraphicsEnvironment.checkHeadless on a server with no display); the real bin/jadx launcher
  // script explicitly sets -cp + the CLI main class instead. decompilerRunner.ts must invoke
  // it the same way.
  const distAsset = assets.find(a => /^jadx-[\d.]+\.zip$/i.test(a.name));
  if (!distAsset) throw new Error('jadx release has no matching jadx-<version>.zip asset — check the repo manually.');

  const version = rel.data.tag_name || 'unknown';
  const zipTempPath = path.join(Config.toolsPath, `jadx-${version}-dist.zip.tmp`);
  logger.info(`[jadx] downloading ${distAsset.browser_download_url} (this one's large, ~75MB — give it a bit)`);
  await downloadFile(distAsset.browser_download_url, zipTempPath);

  const jarFile = `jadx-${version}-all.jar`;
  const jarPath = path.join(Config.toolsPath, jarFile);
  const zip = new AdmZip(zipTempPath);
  const jarEntry = zip.getEntries().find(e => /^lib\/jadx-[\d.]+-all\.jar$/i.test(e.entryName));
  if (!jarEntry) {
    await fs.promises.unlink(zipTempPath);
    throw new Error(`jadx dist archive did not contain lib/jadx-*-all.jar — entries were: ${zip.getEntries().map(e => e.entryName).join(', ')}`);
  }
  await fs.promises.writeFile(jarPath, jarEntry.getData());
  await fs.promises.unlink(zipTempPath);

  // Same situation as jd-cli — no published checksum for the jar file *inside* the archive.
  const sha256 = await sha256File(jarPath);
  const checksumVerified = false;
  logger.warn(`[jadx] no published checksum available for the jar inside the dist archive — computed SHA-256 ${sha256} logged for manual verification, not auto-confirmed.`);

  const stat = await fs.promises.stat(jarPath);
  manifest.jadx = { version, jarPath: jarFile, sha1: null, sha256, verified: checksumVerified, fetchedAt: new Date().toISOString() };
  saveManifest(manifest);

  return { name: 'jadx', installed: true, version, jarPath, sizeBytes: stat.size, checksumVerified };
}

async function ensureProcyon(): Promise<EngineStatus> {
  const manifest = loadManifest();
  const entry = manifest.procyon;

  if (entry.jarPath && fs.existsSync(path.join(Config.toolsPath, entry.jarPath))) {
    const jarPath = path.join(Config.toolsPath, entry.jarPath);
    const stat = await fs.promises.stat(jarPath);
    return {
      name: 'procyon', installed: true, version: entry.version, jarPath,
      sizeBytes: stat.size, checksumVerified: entry.verified,
    };
  }

  // Procyon's runnable CLI jar (com.strobel.decompiler.DecompilerDriver) is only published as
  // a GitHub Release asset — `org.bitbucket.mstrobel:procyon-decompiler` does NOT exist on
  // Maven Central (only procyon-core/compilertools/reflection/expressions do, none of which
  // are runnable on their own). Confirmed live: the release asset is a bare, already-shaded
  // .jar — unlike jd-cli/jadx there's no -dist.zip wrapper to unpack.
  logger.info('[procyon] not cached — resolving latest release from GitHub...');
  const rel = await axios.get('https://api.github.com/repos/mstrobel/procyon/releases/latest', httpDefaults({ timeout: 30000 }));
  const assets: any[] = rel.data?.assets || [];
  const jarAsset = assets.find(a => /^procyon-decompiler-[\d.]+\.jar$/i.test(a.name));
  if (!jarAsset) throw new Error('procyon release has no matching procyon-decompiler-<version>.jar asset — check the repo manually.');

  const version = (rel.data.tag_name || 'unknown').replace(/^v/, '');
  const jarFile = `procyon-${version}.jar`;
  const jarPath = path.join(Config.toolsPath, jarFile);
  logger.info(`[procyon] downloading ${jarAsset.browser_download_url}`);
  await downloadFile(jarAsset.browser_download_url, jarPath);

  // Same situation as jd-cli/jadx — GitHub doesn't publish a checksum for the release asset.
  const sha256 = await sha256File(jarPath);
  const checksumVerified = false;
  logger.warn(`[procyon] no published checksum available for the release asset — computed SHA-256 ${sha256} logged for manual verification, not auto-confirmed.`);

  const stat = await fs.promises.stat(jarPath);
  manifest.procyon = { version, jarPath: jarFile, sha1: null, sha256, verified: checksumVerified, fetchedAt: new Date().toISOString() };
  saveManifest(manifest);

  return { name: 'procyon', installed: true, version, jarPath, sizeBytes: stat.size, checksumVerified };
}

export async function ensureEngine(name: EngineName): Promise<EngineStatus> {
  switch (name) {
    case 'cfr': return ensureCentralArtifact('cfr', 'org.benf', 'cfr');
    case 'vineflower': return ensureCentralArtifact('vineflower', 'org.vineflower', 'vineflower');
    case 'jdcli': return ensureJdCli();
    case 'jadx': return ensureJadx();
    case 'procyon': return ensureProcyon();
  }
}

export async function getEngineStatus(name: EngineName): Promise<EngineStatus> {
  const manifest = loadManifest();
  const entry = manifest[name];
  if (!entry.jarPath) return { name, installed: false, version: null, jarPath: null, sizeBytes: null, checksumVerified: false };
  const jarPath = path.join(Config.toolsPath, entry.jarPath);
  if (!fs.existsSync(jarPath)) return { name, installed: false, version: null, jarPath: null, sizeBytes: null, checksumVerified: false };
  const stat = await fs.promises.stat(jarPath);
  return { name, installed: true, version: entry.version, jarPath, sizeBytes: stat.size, checksumVerified: entry.verified };
}

export async function getAllEngineStatus(): Promise<EngineStatus[]> {
  return Promise.all([getEngineStatus('cfr'), getEngineStatus('vineflower'), getEngineStatus('jdcli'), getEngineStatus('jadx'), getEngineStatus('procyon')]);
}
