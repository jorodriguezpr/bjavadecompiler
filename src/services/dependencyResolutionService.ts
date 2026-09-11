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
 * BJavaDecompiler - Stage 2: dependency resolution.
 *
 * For each WEB-INF/lib/*.jar, resolves real Maven coordinates in decreasing order of
 * confidence: (1) an embedded META-INF/maven/<g>/<a>/pom.properties — near-zero cost, highest
 * confidence; (2) SHA-1 checksum lookup against Maven Central's search API; (3) a filename-
 * derived artifactId free-text search on Central, marked 'guess'; (4) a class-name-voting auto-
 * match (see mavenSearchService.ts's autoMatchDependency()) when AUTO_MATCH_UNRESOLVED_DEPS is
 * enabled (default on) — confirmed real case: a jar literally named "mail.jar" would otherwise
 * guess the unrelated "com.ritense.valtimo:mail" via (3)'s filename search, where voting across
 * the jar's own javax.mail.* classes instead correctly finds javax.mail:javax.mail-api; (5) when
 * Config.sharedDependenciesDirs is configured, a local jar folder search (see
 * matchSharedLibrary() below) for internal/proprietary jars that will never be on Central no
 * matter how good the heuristic — an exact SHA-1 match there gives the dependency a real,
 * meaningful identity instead of a generic placeholder, though it always still resolves as
 * confidence 'unresolved' (see that function's own comment for why); (6) last resort, a
 * placeholder coordinate under com.bjavadecompiler.unresolved so the build still stays green even
 * when nothing resolves. Every SHA-1 -> coordinate resolution is cached across jobs in
 * data/dependency-cache.json since the same common jars (commons-lang3, gson, etc.) recur
 * constantly.
 */

import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import AdmZip from 'adm-zip';
import axios from 'axios';
import { Config } from '../config/config';
import { Logger } from '../core/logger';
import { withRetry, httpDefaults } from '../core/httpRetry';
import { DependencyResolution } from '../models/job';
import { autoMatchDependency } from './mavenSearchService';

const logger = Logger.getLogger('DependencyResolutionService');

type CacheMap = Record<string, ResolvedCacheEntry | UnresolvedCacheEntry>;

type ResolvedCacheEntry = { groupId: string; artifactId: string; version: string; classifier: string | null; confidence: 'pom-properties' | 'sha1-match' | 'guess' | 'auto-class-match' };

/** Marks a jar SHA-1 as "already tried every resolution method, found nothing" — distinct from
 * a ResolvedCacheEntry so it's never mistaken for a real coordinate. Kept only for
 * UNRESOLVED_RECHECK_MS (see below), not forever: unlike pom-properties/sha1-match (facts about
 * these exact bytes that can never change), a "nothing found" result depends on Maven Central's
 * CURRENT search index and this project's OWN guess/auto-class-match heuristics — either can
 * improve after this jar was last checked, so a stale negative result should eventually get a
 * fresh attempt rather than being trusted forever. */
type UnresolvedCacheEntry = { confidence: 'confirmed-unresolved'; checkedAt: string };

/** How long a "confirmed unresolved" result is trusted before the next job re-attempts full
 * resolution for that jar SHA-1 from scratch. Long enough to eliminate the common case (the same
 * internal/proprietary jars recurring across many jobs run close together in time) while still
 * self-healing if Central gains a matching publish or this project's own search heuristics
 * improve later — no manual cache-busting needed. */
const UNRESOLVED_RECHECK_MS = 7 * 24 * 60 * 60 * 1000;

function loadCache(): CacheMap {
  const p = Config.dependencyCachePath;
  if (!fs.existsSync(p)) return {};
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return {}; }
}

function saveCache(cache: CacheMap): void {
  fs.writeFileSync(Config.dependencyCachePath, JSON.stringify(cache, null, 2), 'utf8');
}

/**
 * Overwrites (or removes, when `resolved` is null) one jar's cached SHA-1 -> coordinate entry.
 * Used by decompileJobService.ts's broken-artifact recovery: a dependency that matched via (3)'s
 * filename guess but then failed to actually resolve at `mvn compile` time (confirmed real case:
 * a jar named "mail.jar" guessed as the unrelated, non-existent "com.ritense.valtimo:mail") would
 * otherwise poison the cache permanently — every future job with the exact same jar bytes would
 * keep re-hitting the same known-bad guess and re-discovering it's broken via a wasted build-fix
 * cycle, forever. Passing a fresh `resolved` (e.g. from a class-name auto-match that succeeded
 * where the guess didn't) replaces the bad entry outright instead of just deleting it.
 */
export function updateCachedResolution(sha1: string, resolved: CacheMap[string] | null): void {
  const cache = loadCache();
  if (resolved) cache[sha1] = resolved;
  else delete cache[sha1];
  saveCache(cache);
}

function mavenJarUrl(groupId: string, artifactId: string, version: string, classifier?: string | null): string {
  const groupPath = groupId.replace(/\./g, '/');
  const suffix = classifier ? `-${classifier}` : '';
  return `https://repo.maven.apache.org/maven2/${groupPath}/${artifactId}/${version}/${artifactId}-${version}${suffix}.jar`;
}

async function jarExistsAt(url: string): Promise<boolean> {
  try {
    const res = await axios.head(url, { timeout: 15000, validateStatus: () => true });
    return res.status === 200;
  } catch {
    return false;
  }
}

/** Extracts a Maven classifier from the WAR's own original jar filename, for when the plain
 * (unclassified) artifact doesn't actually exist on Central even though its coordinate looks
 * fully valid — confirmed real case: net.sf.json-lib:json-lib publishes a POM and shows up in
 * Central's search index at every version, but NEVER a plain json-lib-1.1.jar, only
 * json-lib-1.1-jdk13.jar / -jdk15.jar. The bundled jar's own filename already carries the
 * classifier bjavadecompiler needs (`json-lib-1.1-jdk13.jar` matched to
 * net.sf.json-lib:json-lib:1.1 leaves exactly "jdk13" once that prefix is stripped) — no need to
 * guess from a fixed list. */
function classifierFromFilename(jarName: string, artifactId: string, version: string): string | null {
  const base = jarName.replace(/\.jar$/i, '');
  const prefix = `${artifactId}-${version}-`;
  if (base.startsWith(prefix)) {
    const rest = base.slice(prefix.length);
    return rest.length ? rest : null;
  }
  return null;
}

/**
 * Confirms a resolved g:a:v actually has a downloadable jar on Central before accepting it —
 * confirmed real failure mode: a coordinate can have a valid POM and rank well in search results
 * while the plain jar 404s forever, because the library only ever published classified jars (see
 * classifierFromFilename above). Accepting an unverified coordinate here would otherwise poison
 * dependency-cache.json (and, on the broken-artifact recovery path in decompileJobService.ts,
 * re-guess the exact same dead coordinate on every retry, wasting a full build-fix cycle each
 * time) with a build that can never succeed.
 */
export async function verifyArtifactResolvable(
  groupId: string, artifactId: string, version: string, jarName: string,
): Promise<{ ok: boolean; classifier: string | null }> {
  if (await jarExistsAt(mavenJarUrl(groupId, artifactId, version))) return { ok: true, classifier: null };
  const classifier = classifierFromFilename(jarName, artifactId, version);
  if (classifier && await jarExistsAt(mavenJarUrl(groupId, artifactId, version, classifier))) {
    return { ok: true, classifier };
  }
  return { ok: false, classifier: null };
}

export function sha1OfFile(filePath: string): string {
  const buf = fs.readFileSync(filePath);
  return crypto.createHash('sha1').update(buf).digest('hex');
}

/** Common servlet/JSP API groupId:artifactId patterns — container-supplied, must never be bundled. */
const PROVIDED_PATTERNS = [
  /^javax\.servlet:/i, /^jakarta\.servlet:/i, /:servlet-api:/i, /:javax\.servlet-api:/i,
  /^javax\.servlet\.jsp:/i, /^jakarta\.servlet\.jsp:/i, /:jsp-api:/i,
  /^javax\.el:/i, /^jakarta\.el:/i,
];

/** Exported so projectGeneratorService.ts can check whether a bundled dependency already covers
 * the servlet/JSP/EL API before deciding whether a java-ee project needs one synthesized (see
 * buildPomXml's `hasServletApi` check) — reuses the same pattern list instead of a second,
 * independently-drifting copy of "what counts as the servlet API". */
export function isProvided(groupId: string, artifactId: string): boolean {
  const key = `${groupId}:${artifactId}`;
  return PROVIDED_PATTERNS.some(re => re.test(key));
}

export interface ProvidedApiCatalogEntry {
  /** Package prefix this entry answers for — matches the package itself or any sub-package
   * (`javax.xml.bind` also covers `javax.xml.bind.annotation`). */
  packagePrefix: string;
  groupId: string;
  artifactId: string;
  version: string;
}

/**
 * Standard Java EE / Jakarta EE APIs a servlet/EJB container (GlassFish, WildFly, WebSphere,
 * Payara, TomEE...) supplies at runtime and that are therefore almost never bundled in a WAR's own
 * WEB-INF/lib — confirmed real case: a WAR decompiled outside its container shows
 * `package javax.mail does not exist` even though it ran fine deployed, because GlassFish's own
 * `glassfish/lib/javax.mail.jar` supplied it and the WAR simply never needed a copy. Each entry
 * here is a real, stable, standalone "-api" artifact that genuinely exists on Maven Central under
 * that exact coordinate (confirmed against Central's own search, not guessed) — unlike a bundled
 * WEB-INF/lib jar, there's no jar to identify at all here, the coordinate is simply known in
 * advance, so this needs no local GlassFish installation or any other configuration to work.
 * javax.servlet itself is deliberately NOT in this table — projectGeneratorService.ts already
 * synthesizes it proactively for every java-ee app before the first build attempt even runs (see
 * buildPomXml's `servletApiDep`), so it's resolved before it could ever show up as "missing" here.
 * See findProvidedApiForPackage() for the lookup, and Config.javaEeProvidedLibsDirs (a real
 * container installation's own libs) for the fallback when a package isn't in this table at all.
 */
export const PROVIDED_API_CATALOG: ProvidedApiCatalogEntry[] = [
  { packagePrefix: 'javax.servlet.jsp', groupId: 'javax.servlet.jsp', artifactId: 'javax.servlet.jsp-api', version: '2.3.3' },
  { packagePrefix: 'javax.el', groupId: 'javax.el', artifactId: 'javax.el-api', version: '3.0.0' },
  { packagePrefix: 'javax.mail', groupId: 'javax.mail', artifactId: 'javax.mail-api', version: '1.6.2' },
  { packagePrefix: 'javax.activation', groupId: 'javax.activation', artifactId: 'javax.activation-api', version: '1.2.0' },
  { packagePrefix: 'javax.ejb', groupId: 'javax.ejb', artifactId: 'javax.ejb-api', version: '3.2.6' },
  { packagePrefix: 'javax.transaction', groupId: 'javax.transaction', artifactId: 'javax.transaction-api', version: '1.3' },
  { packagePrefix: 'javax.xml.bind', groupId: 'javax.xml.bind', artifactId: 'jaxb-api', version: '2.3.1' },
  { packagePrefix: 'javax.ws.rs', groupId: 'javax.ws.rs', artifactId: 'javax.ws.rs-api', version: '2.1.1' },
  { packagePrefix: 'javax.faces', groupId: 'javax.faces', artifactId: 'javax.faces-api', version: '2.3' },
  { packagePrefix: 'javax.persistence', groupId: 'javax.persistence', artifactId: 'javax.persistence-api', version: '2.2' },
  { packagePrefix: 'javax.jms', groupId: 'javax.jms', artifactId: 'javax.jms-api', version: '2.0.1' },
  { packagePrefix: 'javax.annotation', groupId: 'javax.annotation', artifactId: 'javax.annotation-api', version: '1.3.2' },
  { packagePrefix: 'javax.enterprise', groupId: 'javax.enterprise', artifactId: 'cdi-api', version: '2.0' },
];

/** Longest-prefix match (not simple array order) so a more specific entry like
 * `javax.servlet.jsp` always wins over a hypothetical broader `javax.servlet` entry regardless of
 * table order — matters because `javax.servlet.jsp` textually starts with `javax.servlet`. Exact
 * equality also counts as a match (a class directly in the prefix package itself, not just a
 * sub-package of it). */
export function findProvidedApiForPackage(pkg: string): ProvidedApiCatalogEntry | null {
  let best: ProvidedApiCatalogEntry | null = null;
  for (const entry of PROVIDED_API_CATALOG) {
    if (pkg === entry.packagePrefix || pkg.startsWith(`${entry.packagePrefix}.`)) {
      if (!best || entry.packagePrefix.length > best.packagePrefix.length) best = entry;
    }
  }
  return best;
}

function findPomProperties(jarPath: string): { groupId: string; artifactId: string; version: string } | null {
  const zip = new AdmZip(jarPath);
  const entry = zip.getEntries().find(e => /^META-INF\/maven\/[^/]+\/[^/]+\/pom\.properties$/.test(e.entryName));
  if (!entry) return null;
  const text = entry.getData().toString('utf8');
  const props: Record<string, string> = {};
  for (const line of text.split('\n')) {
    const [k, ...rest] = line.split('=');
    if (k && rest.length) props[k.trim()] = rest.join('=').trim();
  }
  if (props.groupId && props.artifactId && props.version) {
    return { groupId: props.groupId, artifactId: props.artifactId, version: props.version };
  }
  return null;
}

async function searchBySha1(sha1: string): Promise<{ groupId: string; artifactId: string; version: string } | null> {
  const res = await withRetry(() => axios.get('https://search.maven.org/solrsearch/select', httpDefaults({
    params: { q: `1:${sha1}`, rows: 1, wt: 'json' },
    timeout: 20000,
  })), { label: 'MavenCentral-sha1' });
  const doc = res.data?.response?.docs?.[0];
  if (!doc) return null;
  return { groupId: doc.g, artifactId: doc.a, version: doc.v || doc.latestVersion };
}

// Same trailing -<version> shape both functions below key off of — kept as one regex so the
// "what did we strip" and "what did we capture" halves can never drift apart.
const TRAILING_VERSION_RE = /-(\d+(?:\.\d+){1,3}(?:[.-].*)?)$/;

function guessArtifactIdFromFilename(jarName: string): string {
  // strip a trailing -<version>.jar (e.g. commons-lang3-3.14.0.jar -> commons-lang3)
  return jarName.replace(/\.jar$/i, '').replace(TRAILING_VERSION_RE, '');
}

/** The version this specific jar's own filename claims to be — e.g. "1.3" from
 * "opencsv-1.3.jar". Null when the filename doesn't end in a recognizable version. */
function guessVersionFromFilename(jarName: string): string | null {
  const m = jarName.replace(/\.jar$/i, '').match(TRAILING_VERSION_RE);
  return m ? m[1] : null;
}

function majorVersion(version: string): string | null {
  const m = version.match(/^\d+/);
  return m ? m[0] : null;
}

export async function searchByArtifactIdGuess(jarName: string): Promise<{ groupId: string; artifactId: string; version: string } | null> {
  const guess = guessArtifactIdFromFilename(jarName);
  const res = await withRetry(() => axios.get('https://search.maven.org/solrsearch/select', httpDefaults({
    params: { q: `a:${guess}`, rows: 1, wt: 'json' },
    timeout: 20000,
  })), { label: 'MavenCentral-guess' });
  const doc = res.data?.response?.docs?.[0];
  if (!doc) return null;

  // Confirmed live: this search only ever matches on artifactId, so it previously trusted
  // whatever Central's CURRENT "latest" version happens to be regardless of what version the
  // actual bundled jar is — for a library that renamed its own package across major versions
  // (opencsv's `au.com.bytecode.opencsv` in 1.x/2.x became `com.opencsv` from 2.3 on), that
  // silently substituted source that doesn't even share package names with the real jar, and
  // wasn't just "close enough" wrong, it was 100% guaranteed to fail every single import. A
  // major-version mismatch between the filename's own claimed version and Central's "latest" is
  // a strong, cheap signal that "latest" is a different generation of the library — reject the
  // guess entirely rather than risk it; the caller falls through to the next resolution method,
  // ultimately landing on decompiling the real, original jar directly if nothing else matches,
  // which is always correct by construction (it's the actual bytecode) even if less tidy.
  const filenameVersion = guessVersionFromFilename(jarName);
  if (filenameVersion) {
    const filenameMajor = majorVersion(filenameVersion);
    const latestMajor = majorVersion(String(doc.latestVersion || ''));
    if (filenameMajor && latestMajor && filenameMajor !== latestMajor) {
      logger.warn(`Artifact-id guess for ${jarName} found ${doc.g}:${doc.a}:${doc.latestVersion} on Central, but the jar's own filename claims version ${filenameVersion} (major ${filenameMajor} vs ${latestMajor}) — rejecting as too likely to be a different, incompatible generation of the library.`);
      return null;
    }
  }

  return { groupId: doc.g, artifactId: doc.a, version: doc.latestVersion };
}

interface SharedLibraryEntry { jarPath: string; sha1: string }

/** Recursively lists every `.jar` under `dir` — best-effort: an unreadable subdirectory (odd
 * permissions, a broken junction) is skipped with a warning rather than aborting the whole scan. */
function walkJarFiles(dir: string): string[] {
  const found: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err: any) {
    logger.warn(`Could not read shared-dependencies directory ${dir}: ${err.message}`);
    return found;
  }
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walkJarFiles(full));
    else if (entry.isFile() && /\.jar$/i.test(entry.name)) found.push(full);
  }
  return found;
}

/** Every `.jar` under every configured Config.sharedDependenciesDirs entry — exported so
 * sharedLibraryPackageSearchService.ts's package-name index can enumerate the same jars without
 * duplicating the dir-validation/recursive-walk logic. Missing/invalid directories are logged and
 * skipped, never thrown — a stale or typo'd entry should never crash resolution. */
export function listAllSharedDependencyJars(): string[] {
  const found: string[] = [];
  for (const dir of Config.sharedDependenciesDirs) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
      logger.warn(`Configured shared-dependencies directory does not exist, skipping: ${dir}`);
      continue;
    }
    found.push(...walkJarFiles(dir));
  }
  return found;
}

/** Built once per resolveDependencies() call (not per jar) — hashing every configured shared
 * folder once and reusing the index across all of a WAR's own unresolved jars is far cheaper
 * than re-scanning per jar, and the folder's contents can't meaningfully change mid-run. */
function buildSharedLibraryIndex(): SharedLibraryEntry[] {
  const jarPaths = listAllSharedDependencyJars();
  const index: SharedLibraryEntry[] = [];
  for (const jarPath of jarPaths) {
    try {
      index.push({ jarPath, sha1: sha1OfFile(jarPath) });
    } catch (err: any) {
      logger.warn(`Could not hash shared-dependencies jar ${jarPath}: ${err.message}`);
    }
  }
  if (index.length) logger.info(`Shared-dependencies library: indexed ${index.length} jar(s) from ${Config.sharedDependenciesDirs.length} configured director${Config.sharedDependenciesDirs.length === 1 ? 'y' : 'ies'}.`);
  return index;
}

interface SharedLibraryMatch { groupId: string; artifactId: string; version: string; matchedJarPath: string; exact: boolean }

/** Maven artifactId/groupId have no hard character restriction, but keeping a filename-derived
 * value to the same safe charset the generic unresolved placeholder already uses avoids surprises
 * in generated pom.xml/paths — same regex that branch already applies. */
function sanitizeCoordSegment(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '-');
}

/** Derives a groupId/artifactId/version identity for a jar found in the shared-dependencies
 * folder — its own embedded pom.properties if it has one, else a sanitized filename-based guess
 * under the `local.shared` namespace. Exported so sharedLibraryPackageSearchService.ts's "package
 * entirely missing from the WAR" search can give its own finds the identical identity treatment
 * matchSharedLibrary() below already gives an exact/fuzzy SHA-1 match, instead of a second,
 * independently-drifting copy of this logic. */
export function identifySharedJar(jarPath: string): { groupId: string; artifactId: string; version: string } {
  const pom = findPomProperties(jarPath);
  if (pom) return { groupId: sanitizeCoordSegment(pom.groupId), artifactId: sanitizeCoordSegment(pom.artifactId), version: pom.version };
  const sharedName = path.basename(jarPath);
  return {
    groupId: 'local.shared',
    artifactId: sanitizeCoordSegment(guessArtifactIdFromFilename(sharedName)),
    version: guessVersionFromFilename(sharedName) || '0.0.0-unresolved',
  };
}

/**
 * Last-resort local lookup for a jar that pom.properties/SHA-1/filename-guess/class-vote all
 * failed on — searches the shared-dependencies folder(s) (Config.sharedDependenciesDirs) for a
 * jar that could BE this dependency. An exact SHA-1 match (identical bytes) is as certain as
 * resolution gets short of pom.properties on the bundled jar itself; falls back to a normalized-
 * filename match (same artifactId once version+extension are stripped) only when exactly one
 * shared jar matches that name — more than one candidate sharing a normalized name is exactly the
 * "which version is it" ambiguity this can't settle on its own, so it stays unresolved rather than
 * guessing wrong.
 *
 * Deliberately never returned as a confidence that would make projectGeneratorService.ts emit a
 * normal Central-downloadable `<dependency>` — even a shared jar's own embedded pom.properties
 * names a coordinate that is almost certainly NOT actually published on public Maven Central (an
 * internal/enterprise groupId), so trusting it as 'pom-properties' would generate a pom.xml that
 * fails at `mvn compile` trying to download something that doesn't exist there. The caller always
 * keeps the dependency as 'unresolved' (still installed locally from the WAR's own original jar
 * bytes and, if enabled, decompiled) — this only upgrades its groupId/artifactId/version identity
 * from the generic sanitized-filename placeholder to something real and meaningful.
 */
function matchSharedLibrary(jarName: string, sha1: string, index: SharedLibraryEntry[]): SharedLibraryMatch | null {
  const exactEntry = index.find(e => e.sha1 === sha1);
  if (exactEntry) return { ...identifySharedJar(exactEntry.jarPath), matchedJarPath: exactEntry.jarPath, exact: true };

  const normalized = guessArtifactIdFromFilename(jarName).toLowerCase();
  const nameMatches = index.filter(e => guessArtifactIdFromFilename(path.basename(e.jarPath)).toLowerCase() === normalized);
  if (nameMatches.length === 1) return { ...identifySharedJar(nameMatches[0].jarPath), matchedJarPath: nameMatches[0].jarPath, exact: false };

  return null;
}

export async function resolveDependencies(libJars: string[]): Promise<DependencyResolution[]> {
  const cache = loadCache();
  const results: DependencyResolution[] = [];
  const seen = new Set<string>();
  const sharedLibraryIndex = Config.sharedDependenciesDirs.length ? buildSharedLibraryIndex() : [];

  // Bounded concurrency (5 at a time) — polite to Maven Central, still fast for the common
  // case of dozens of jars in WEB-INF/lib.
  const CONCURRENCY = 5;
  let index = 0;

  async function worker() {
    while (index < libJars.length) {
      const jarPath = libJars[index++];
      const jarName = path.basename(jarPath);
      const sha1 = sha1OfFile(jarPath);
      if (seen.has(sha1)) continue;
      seen.add(sha1);

      let resolved: ResolvedCacheEntry | null = null;
      const cached = cache[sha1];
      const cachedUnresolvedIsFresh = cached?.confidence === 'confirmed-unresolved'
        && Date.now() - new Date(cached.checkedAt).getTime() < UNRESOLVED_RECHECK_MS;

      // Only trust a cached entry for the same two objectively-verifiable tiers the write path
      // below actually persists (pom-properties/sha1-match) — closes a real gap where a
      // 'guess'/'auto-class-match' entry written before that write-gate existed (or by any
      // future regression of it) would otherwise be read back and trusted forever, since this
      // check previously accepted any cached confidence except 'confirmed-unresolved'. Confirmed
      // real case: a WAR's own activation.jar (bare filename, no version to sanity-check against)
      // had a stale 'guess' entry pinning it to an unrelated one.gfw:activation:1.1.1 coordinate.
      if (cached && (cached.confidence === 'pom-properties' || cached.confidence === 'sha1-match')) {
        resolved = cached;
      } else if (cachedUnresolvedIsFresh) {
        logger.info(`${jarName}: skipping resolution attempts — confirmed unresolvable as of ${(cached as UnresolvedCacheEntry).checkedAt} (same jar bytes).`);
      } else {
        // Each candidate is verified to actually have a downloadable jar on Central (see
        // verifyArtifactResolvable above) before being accepted — a candidate that fails
        // verification falls through to the next method instead of being trusted outright.
        type Candidate = { groupId: string; artifactId: string; version: string; confidence: ResolvedCacheEntry['confidence'] };
        const attempts: Array<() => Promise<Candidate | null>> = [
          async () => {
            const pom = findPomProperties(jarPath);
            return pom ? { ...pom, confidence: 'pom-properties' } : null;
          },
          async () => {
            try {
              const central = await searchBySha1(sha1);
              return central ? { ...central, confidence: 'sha1-match' } : null;
            } catch (err: any) {
              logger.warn(`SHA-1 lookup failed for ${jarName}: ${err.message}`);
              return null;
            }
          },
          async () => {
            try {
              const guess = await searchByArtifactIdGuess(jarName);
              return guess ? { ...guess, confidence: 'guess' } : null;
            } catch (err: any) {
              logger.warn(`Artifact-id guess search failed for ${jarName}: ${err.message}`);
              return null;
            }
          },
          async () => {
            if (!Config.autoMatchUnresolvedDeps) return null;
            try {
              const auto = await autoMatchDependency(jarPath);
              if (!auto) return null;
              logger.info(`Auto-matched ${jarName} -> ${auto.groupId}:${auto.artifactId}:${auto.version} (${auto.agreeingClasses}/${auto.sampledClasses} sampled classes agreed).`);
              return { groupId: auto.groupId, artifactId: auto.artifactId, version: auto.version, confidence: 'auto-class-match' };
            } catch (err: any) {
              logger.warn(`Class-name auto-match failed for ${jarName}: ${err.message}`);
              return null;
            }
          },
        ];

        for (const attempt of attempts) {
          const candidate = await attempt();
          if (!candidate) continue;
          const verify = await verifyArtifactResolvable(candidate.groupId, candidate.artifactId, candidate.version, jarName);
          if (!verify.ok) {
            logger.warn(`${candidate.confidence} match ${candidate.groupId}:${candidate.artifactId}:${candidate.version} for ${jarName} has no downloadable jar on Central (even with a classifier guessed from the filename) — trying the next resolution method.`);
            continue;
          }
          resolved = { ...candidate, classifier: verify.classifier };
          break;
        }

        // Only persist the two objectively-verifiable tiers across jobs — a jar's own embedded
        // pom.properties or a Central SHA-1 hit are facts that can never change for these exact
        // bytes. 'guess'/'auto-class-match' are heuristic best-efforts that CAN be wrong (confirmed
        // real case: opencsv-1.3.jar's artifactId-only guess landed on a totally incompatible
        // later major version before searchByArtifactIdGuess() gained its major-version check) —
        // caching a heuristic result forever means a future improvement to the heuristic itself
        // never gets a chance to re-run for jars already cached with the old, wrong answer. These
        // are cheap to re-derive (only reached for jars that already failed the two high-confidence
        // checks, a small fraction of any WAR) so there's no real cost to re-checking every job.
        if (resolved && (resolved.confidence === 'pom-properties' || resolved.confidence === 'sha1-match')) {
          cache[sha1] = resolved;
        } else if (!resolved) {
          // Every method (including the network-heavy auto-class-match, which fires a Central
          // search PER sampled class) came up empty — cache that fact so the next job with this
          // exact jar skips straight past all four attempts instead of re-discovering the same
          // dead end. Time-bounded (see UNRESOLVED_RECHECK_MS), not permanent.
          cache[sha1] = { confidence: 'confirmed-unresolved', checkedAt: new Date().toISOString() };
        }
      }


      if (resolved) {
        results.push({
          jarName, sha1,
          groupId: resolved.groupId, artifactId: resolved.artifactId, version: resolved.version,
          classifier: resolved.classifier,
          scope: isProvided(resolved.groupId, resolved.artifactId) ? 'provided' : 'compile',
          confidence: resolved.confidence,
          decompiledSourceDir: null, sharedLibrarySource: null,
        });
      } else {
        // Last resort before the generic opaque placeholder — see matchSharedLibrary() above for
        // why this still always lands as confidence 'unresolved' even on an exact byte match.
        const sharedMatch = sharedLibraryIndex.length ? matchSharedLibrary(jarName, sha1, sharedLibraryIndex) : null;
        if (sharedMatch) {
          results.push({
            jarName, sha1,
            groupId: sharedMatch.groupId, artifactId: sharedMatch.artifactId, version: sharedMatch.version,
            classifier: null,
            scope: 'compile', confidence: 'unresolved', decompiledSourceDir: null,
            sharedLibrarySource: path.basename(sharedMatch.matchedJarPath),
          });
          logger.info(`${jarName}: no real Maven coordinate found, but matched a local shared-dependencies jar ${sharedMatch.exact ? 'exactly (identical bytes)' : 'by name'} — ${path.basename(sharedMatch.matchedJarPath)} — using ${sharedMatch.groupId}:${sharedMatch.artifactId}:${sharedMatch.version} as its identity (still installed locally from the WAR's own original jar, not downloaded).`);
        } else {
          // The build stays green via a locally-installed placeholder coordinate;
          // projectGeneratorService/mavenVerifyService handle actually running
          // `mvn install:install-file` for entries marked 'unresolved'.
          const sanitized = jarName.replace(/\.jar$/i, '').replace(/[^a-zA-Z0-9._-]/g, '-');
          results.push({
            jarName, sha1,
            groupId: 'com.bjavadecompiler.unresolved', artifactId: sanitized, version: '0.0.0-unresolved',
            classifier: null,
            scope: 'compile', confidence: 'unresolved', decompiledSourceDir: null, sharedLibrarySource: null,
          });
          logger.warn(`Could not resolve real Maven coordinates for ${jarName} — using a local placeholder.`);
        }
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, libJars.length) }, worker));
  saveCache(cache);
  return results;
}
