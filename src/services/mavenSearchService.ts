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
 * BJavaDecompiler - manual "search Maven repositories for a missing dependency" feature, for
 * whatever dependencyResolutionService.ts's automatic passes (pom.properties, SHA-1, filename
 * guess) couldn't resolve. Same idea as NetBeans' "Search in Repositories" dialog for a red
 * unresolved import: search Maven Central by a class name found inside the unresolved jar (or
 * free text), show every jar that could plausibly be it, and let a human pick — Central's class
 * index includes shaded/relocated copies of common classes (e.g. a fat jar bundling its own
 * commons-lang3), so the top-ranked result is NOT reliably "the real origin library"; this is
 * why the feature returns a list to choose from rather than auto-applying the first hit.
 *
 * Confirmed live against search.maven.org: the class-search field is `fc:"<fully.qualified.Name>"`
 * (fully-qualified, quoted) — a bare `c:ClassName` does NOT do a targeted contains-this-class
 * search at all, it silently degrades to a generic relevance/tag match across the whole index
 * and returns unrelated artifacts ranked by popularity. Simple-name-only searches will miss —
 * always search with the full dotted package+class name.
 */

import fs from 'fs';
import AdmZip from 'adm-zip';
import axios from 'axios';
import { Logger } from '../core/logger';
import { withRetry, httpDefaults } from '../core/httpRetry';

const logger = Logger.getLogger('MavenSearchService');

export interface MavenSearchResult {
  groupId: string;
  artifactId: string;
  version: string;
}

/** Search Central by a fully-qualified class name (`fc:"pkg.Class"`) — the closest equivalent to
 * NetBeans' "which jar defines this class" lookup. Deduplicated to one (newest-seen) version per
 * groupId:artifactId — the caller/UI lets the user pick a different version if they want one. */
export async function searchMavenByClassName(fqcn: string, rows = 25): Promise<MavenSearchResult[]> {
  const res = await withRetry(() => axios.get('https://search.maven.org/solrsearch/select', httpDefaults({
    params: { q: `fc:"${fqcn}"`, rows, wt: 'json' },
    timeout: 20000,
  })), { label: 'MavenCentral-classSearch' });
  const docs: any[] = res.data?.response?.docs || [];
  const seen = new Map<string, MavenSearchResult>();
  for (const doc of docs) {
    if (!doc.g || !doc.a || !doc.v) continue;
    const key = `${doc.g}:${doc.a}`;
    if (!seen.has(key)) seen.set(key, { groupId: doc.g, artifactId: doc.a, version: doc.v });
  }
  return Array.from(seen.values());
}

/** Free-text fallback — group/artifact id guesses, library names, etc. Uses Central's default
 * artifact-grouped search (one row per artifact, already at its latest version), unlike the
 * class search above which returns one row per version. */
export async function searchMavenByText(query: string, rows = 25): Promise<MavenSearchResult[]> {
  const res = await withRetry(() => axios.get('https://search.maven.org/solrsearch/select', httpDefaults({
    params: { q: query, rows, wt: 'json' },
    timeout: 20000,
  })), { label: 'MavenCentral-textSearch' });
  const docs: any[] = res.data?.response?.docs || [];
  return docs
    .filter(doc => doc.g && doc.a && (doc.latestVersion || doc.v))
    .map(doc => ({ groupId: doc.g, artifactId: doc.a, version: doc.latestVersion || doc.v }));
}

export interface AutoMatchResult extends MavenSearchResult {
  /** How many of the sampled classes actually voted for this g:a — surfaced so a human can
   * judge confidence at a glance ("6/8 classes agreed" vs "2/8"). */
  agreeingClasses: number;
  sampledClasses: number;
}

/** groupId/artifactId segments so generic they'd "match" almost anything under a shared
 * namespace (javax.*, org.apache.*, sourceforge's net.sf.*, etc.) — excluded from the
 * package-substring bonus below so e.g. "net" or "sf" never gets credit for a coincidental
 * substring hit; only a distinctive segment like "mail" or "json" should count. */
const GENERIC_PACKAGE_SEGMENTS = new Set([
  'com', 'org', 'net', 'io', 'sf', 'api', 'impl', 'internal', 'util', 'utils',
  'model', 'models', 'core', 'common', 'commons', 'lib', 'spi', 'beans',
]);

/** A jar that mocks/stubs a real API for testing (confirmed real case: "mockobjects" implements
 * fake javax.mail.* classes and out-ranks the real javax.mail-api on several individual class
 * searches) is never what a production WAR was actually built against — excluded outright rather
 * than merely down-weighted, since no amount of vote-count should recover from being the wrong
 * kind of artifact entirely. */
const SUSPICIOUS_SUBSTRINGS = ['mock', 'stub', 'fake', 'dummy', 'testkit'];

function isSuspicious(groupId: string, artifactId: string): boolean {
  const key = `${groupId}:${artifactId}`.toLowerCase();
  return SUSPICIOUS_SUBSTRINGS.some(s => key.includes(s));
}

/**
 * The longest package prefix shared by a MAJORITY of the jar's classes — grown one segment at a
 * time only as long as some prefix at that depth still covers >=50% of classes, so it correctly
 * stops at "javax.mail" (classes fan out into .internet/.util/etc. below that, no single deeper
 * prefix holds a majority) as readily as at "net.sf.json" (same fan-out pattern, one segment
 * deeper). A fixed depth cutoff can't handle both shapes at once — this adapts to whichever
 * namespace the jar actually uses, however deep it goes.
 */
export function commonPackagePrefix(fqcns: string[]): string | null {
  const packages = fqcns.map(f => f.split('.').slice(0, -1)).filter(p => p.length > 0);
  if (!packages.length) return null;

  let prefix: string[] = [];
  for (let depth = 0; depth < 6; depth++) {
    const counts = new Map<string, number>();
    for (const pkg of packages) {
      if (pkg.length <= depth) continue;
      const key = pkg.slice(0, depth + 1).join('.');
      counts.set(key, (counts.get(key) || 0) + 1);
    }
    if (!counts.size) break;
    const [bestKey, bestCount] = Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0];
    if (bestCount / packages.length < 0.5) break; // no prefix at this depth commands a majority anymore
    prefix = bestKey.split('.');
  }
  return prefix.length ? prefix.join('.') : null;
}

/** True when a groupId reads as "the home of" a package — exact match (javax.mail == javax.mail)
 * or a simple prefix variant in either direction (net.sf.json-lib starts with net.sf.json; a
 * shorter groupId like com.foo for package com.foo.bar also counts). Requires at least 2 dot-
 * segments of overlap so a single generic segment (com, net, org) can never trivially "own" an
 * unrelated package purely by being a string prefix of it. */
function groupIdOwnsPackage(groupId: string, pkg: string): boolean {
  const g = groupId.toLowerCase();
  const p = pkg.toLowerCase();
  if (g === p) return true;
  const shorter = g.length <= p.length ? g : p;
  if (shorter.split('.').filter(Boolean).length < 2) return false;
  return g.startsWith(p) || p.startsWith(g);
}

/**
 * Automatic version of the manual search above: finds the jar's dominant package, samples
 * several classes under it, searches Central for each, and votes across the results — a class
 * name searched alone is noisy (a shading/mocking jar can outrank the real library for any one
 * specific class, confirmed live: "mockobjects" beats javax.mail-api on Session/Message/
 * MimeMessage/Transport individually), but the REAL owning library is what consistently shows up
 * across MANY different classes from the same package, while a decoy only happens to implement a
 * few. Requires at least half the sampled classes to agree before returning a result at all —
 * anything less stays unresolved rather than guessing, same "stay honest" policy as the rest of
 * this tool. Returns null when there's nothing to go on (no classes, or no majority agreement).
 */
export async function autoMatchDependency(jarPath: string): Promise<AutoMatchResult | null> {
  const allClasses = listJarClasses(jarPath, 2000); // need the whole tree, not just the top few, to find the true dominant package
  const pkg = commonPackagePrefix(allClasses);
  if (!pkg) return null;

  const candidates = allClasses.filter(c => c.startsWith(`${pkg}.`));
  // Spread the sample across the package rather than always taking the first N alphabetically —
  // a stride keeps a hand-picked cap on Maven Central calls while still covering sub-packages
  // that an alphabetical prefix (e.g. everything starting with "A") would otherwise miss.
  const SAMPLE_SIZE = 8;
  const stride = Math.max(1, Math.floor(candidates.length / SAMPLE_SIZE));
  const sample = candidates.filter((_, i) => i % stride === 0).slice(0, SAMPLE_SIZE);
  if (sample.length < 2) return null; // too little signal to vote on

  const scores = new Map<string, { score: number; version: string; agreeing: Set<string> }>();
  for (const cls of sample) {
    let results: MavenSearchResult[] = [];
    try {
      results = await searchMavenByClassName(cls, 30);
    } catch (err: any) {
      logger.warn(`Auto-match class search failed for ${cls}: ${err.message}`);
      continue;
    }
    // Confirmed live: the real, correct artifact for a common API package can rank well outside
    // a naive top-5 (javax.mail:javax.mail-api sits at #26 for "javax.mail.Session" — its own
    // Jakarta-renamed successor crowds the top ranks instead) — a wide net plus gentle rank decay
    // still lets a consistent-but-lower-ranked candidate accumulate real signal across the
    // sample, rather than being invisible to this loop entirely.
    results.slice(0, 20).forEach((r, i) => {
      if (isSuspicious(r.groupId, r.artifactId)) return;
      const key = `${r.groupId}:${r.artifactId}`;
      const entry = scores.get(key) || { score: 0, version: r.version, agreeing: new Set<string>() };
      entry.score += Math.max(1, 20 - i);
      entry.agreeing.add(cls);
      entry.version = r.version;
      scores.set(key, entry);
    });
  }
  if (!scores.size) return null;

  // Bonus for a candidate whose own coordinates echo part of the jar's actual package — directly
  // "matches part of the package" rather than requiring the whole namespace to line up, and
  // tolerant of a version/revision-number-only difference since this never looks at versions.
  const meaningfulSegments = pkg.split('.').filter(s => s.length > 2 && !GENERIC_PACKAGE_SEGMENTS.has(s.toLowerCase()));
  for (const [key, entry] of scores) {
    const [groupId] = key.split(':');
    const keyLower = key.toLowerCase();
    // A groupId that OWNS the package (confirmed real cases: "javax.mail" == package
    // "javax.mail"; "net.sf.json-lib" starts with package "net.sf.json", the "-lib" suffix
    // being exactly the kind of partial/non-exact match worth still counting) is the strongest
    // namespace-ownership signal Maven convention offers — many libraries publish under a
    // groupId that IS (or is a trivial variant of) their own root package.
    if (groupIdOwnsPackage(groupId, pkg)) entry.score += 6;
    else if (meaningfulSegments.some(seg => keyLower.includes(seg.toLowerCase()))) entry.score += 3;
  }

  let ranked = Array.from(scores.entries()).sort((a, b) => b[1].score - a[1].score);

  // A groupId-owns-package candidate that's at least in the same league (half the raw vote
  // score) as the vote leader gets promoted over it — confirmed real case: javax.mail:javax.mail-
  // api scores lower than jakarta.mail:jakarta.mail-api on raw per-class rank (the newer,
  // Jakarta-renamed artifact places more consistently in each class's own top results) but the
  // namespace-ownership match is the more reliable "this is the actual home of this package"
  // signal once the two are in the same ballpark — a flat point bonus alone couldn't outweigh a
  // big enough raw-vote gap, so this checks explicitly rather than hoping the bonus was enough.
  const topScore = ranked[0][1].score;
  const exactMatchIdx = ranked.findIndex(([key]) => groupIdOwnsPackage(key.split(':')[0], pkg));
  if (exactMatchIdx > 0 && ranked[exactMatchIdx][1].score >= topScore * 0.5) {
    const [promoted] = ranked.splice(exactMatchIdx, 1);
    ranked = [promoted, ...ranked];
  }

  const [topKey, topEntry] = ranked[0];
  const minAgreement = Math.max(2, Math.ceil(sample.length / 2));
  if (topEntry.agreeing.size < minAgreement) return null;

  const [groupId, artifactId] = topKey.split(':');
  return {
    groupId, artifactId, version: topEntry.version,
    agreeingClasses: topEntry.agreeing.size, sampledClasses: sample.length,
  };
}

/** Lists candidate fully-qualified class names from inside an unresolved jar, for the UI to
 * offer as one-click search terms — picking a good one matters: a distinctive, top-level,
 * non-internal class searches far better than e.g. a generic `impl.InternalHelper`. Sorted by
 * package depth (shallower = more likely a public entry point) then alphabetically; inner
 * classes ($) and module-info/package-info are excluded as useless search terms. */
export function listJarClasses(jarPath: string, limit = 40): string[] {
  if (!fs.existsSync(jarPath)) return [];
  let zip: AdmZip;
  try {
    zip = new AdmZip(jarPath);
  } catch (err: any) {
    logger.warn(`Could not open ${jarPath} to list classes: ${err.message}`);
    return [];
  }

  const fqcns = zip.getEntries()
    .filter(e => !e.isDirectory && e.entryName.endsWith('.class'))
    .map(e => e.entryName.replace(/\.class$/, '').replace(/\//g, '.'))
    .filter(fqcn => !fqcn.includes('$') && fqcn !== 'module-info' && !fqcn.endsWith('.package-info'));

  fqcns.sort((a, b) => {
    const depthDiff = a.split('.').length - b.split('.').length;
    return depthDiff !== 0 ? depthDiff : a.localeCompare(b);
  });

  return fqcns.slice(0, limit);
}
