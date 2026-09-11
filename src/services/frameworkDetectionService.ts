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
 * BJavaDecompiler - framework/library detection for faithful project-type reconstruction.
 *
 * Examines the resolved dependency set + extracted descriptor files (web.xml, persistence.xml,
 * applicationContext.xml, MANIFEST.MF) to determine which application frameworks the original
 * project used — Spring (MVC / Boot / WebFlux), Struts, Hibernate, JPA/EJB, JSF, Jakarta EE,
 * etc. — so the generated Maven project carries the right plugins, facets, and resource
 * layouts for NetBeans to open it with the correct project type.
 *
 * Purely deterministic: every framework is detected by Maven coordinate patterns (highest
 * confidence) or descriptor-file content (web.xml root element, persistence.xml presence).
 * No bytecode scanning — expensive and usually redundant when the very jars that provide the
 * framework are sitting right there in WEB-INF/lib.
 */

import fs from 'fs';
import path from 'path';
import { Logger } from '../core/logger';
import { DependencyResolution } from '../models/job';

const logger = Logger.getLogger('FrameworkDetection');

export type FrameworkId =
  | 'spring-boot'
  | 'spring-mvc'
  | 'spring-core'
  | 'spring-webflux'
  | 'struts'
  | 'jsf'
  | 'jpa'
  | 'hibernate'
  | 'ejb'
  | 'jakarta-ee'
  | 'java-ee'
  | 'jersey'
  | 'gwt'
  | 'vaadin'
  | 'quarkus'
  | 'micronaut'
  | 'lombok'
  | 'servlet';

export interface DetectedFramework {
  id: FrameworkId;
  /** Human-readable name for NOTES.md / the web UI. */
  label: string;
  /** Confidence: confirmed = a real framework jar was resolved, or a descriptor file positively
   * matched; inferred = a weaker signal (e.g. a transitive coordinate pattern). */
  confidence: 'confirmed' | 'inferred';
  /** Which evidence triggered the detection — surfaced in NOTES.md so the user can audit it. */
  evidence: string;
}

export interface FrameworkDetectionResult {
  frameworks: DetectedFramework[];
  /** Highest-priority framework — drives the pom.xml primary facet/parent selection. */
  primary: FrameworkId | null;
  /** True when a servlet-based web framework is present (WAR packaging, maven-war-plugin,
   * web.xml handling). Redundant with inputType==='war' for traditional WARs but ALSO true for
   * a Spring Boot app packaged as an executable jar with spring-web on the classpath. */
  isWebApplication: boolean;
}

// ─── Coordinate patterns: groupId:artifactId → framework ───────────────

interface CoordinatePattern {
  framework: FrameworkId;
  label: string;
  /** Matches `<groupId>:<artifactId>` (both lowercased) — substring test. */
  pattern: RegExp;
  confidence: 'confirmed' | 'inferred';
}

const COORDINATE_PATTERNS: CoordinatePattern[] = [
  { framework: 'spring-boot', label: 'Spring Boot', pattern: /^org\.springframework\.boot:spring-boot([-.\w]*)$/, confidence: 'confirmed' },
  { framework: 'spring-mvc', label: 'Spring MVC (spring-webmvc)', pattern: /^org\.springframework:spring-webmvc(:|$)/, confidence: 'confirmed' },
  { framework: 'spring-webflux', label: 'Spring WebFlux', pattern: /^org\.springframework:spring-webflux(:|$)/, confidence: 'confirmed' },
  { framework: 'spring-core', label: 'Spring Framework (core)', pattern: /^org\.springframework:spring-(core|context|beans|aop)(:|$)/, confidence: 'confirmed' },
  { framework: 'quarkus', label: 'Quarkus', pattern: /^io\.quarkus:quarkus(-core|-arc)?(:|$)/, confidence: 'confirmed' },
  { framework: 'micronaut', label: 'Micronaut', pattern: /^io\.micronaut:micronaut-(core|inject|runtime)(:|$)/, confidence: 'confirmed' },
  { framework: 'struts', label: 'Apache Struts', pattern: /^org\.apache\.struts(:|$)/, confidence: 'confirmed' },
  { framework: 'jsf', label: 'JavaServer Faces', pattern: /:(jsf-api|jakarta\.faces|myfaces|mojarra)(:|$)/, confidence: 'confirmed' },
  { framework: 'hibernate', label: 'Hibernate ORM', pattern: /^org\.hibernate:hibernate-core(:|$)/, confidence: 'confirmed' },
  { framework: 'jpa', label: 'JPA API', pattern: /:(jakarta\.persistence-api|javax\.persistence-api|persistence-api|hibernate-jpa[\d.]+-api)(:|$)/, confidence: 'confirmed' },
  { framework: 'ejb', label: 'EJB API', pattern: /:(jakarta\.ejb-api|javax\.ejb-api|ejb-api)(:|$)/, confidence: 'confirmed' },
  { framework: 'jersey', label: 'Jersey (JAX-RS)', pattern: /^org\.glassfish\.jersey/, confidence: 'confirmed' },
  { framework: 'gwt', label: 'Google Web Toolkit', pattern: /^com\.google\.gwt(:|$)/, confidence: 'confirmed' },
  { framework: 'vaadin', label: 'Vaadin', pattern: /^com\.vaadin(:|$)/, confidence: 'confirmed' },
  { framework: 'lombok', label: 'Project Lombok', pattern: /^org\.projectlombok:lombok(:|$)/, confidence: 'confirmed' },
  { framework: 'jakarta-ee', label: 'Jakarta EE API', pattern: /^jakarta\.platform:jakarta\.jakartaee-api(:|$)/, confidence: 'confirmed' },
  { framework: 'java-ee', label: 'Java EE API', pattern: /:(javaee-api|javaee-web-api|javax\.javaee-api)(:|$)/, confidence: 'confirmed' },
  { framework: 'servlet', label: 'Servlet API', pattern: /:(javax\.servlet-api|jakarta\.servlet-api|jsp-api|javax\.servlet\.jsp-api)(:|$)/, confidence: 'confirmed' },
];

// ─── Descriptor-based detection ────────────────────────────────────────

/** Reads web.xml's root element to identify the Servlet/Java EE version and confirm the
 * servlet framework. Returns evidence string, or null if web.xml is absent/unparseable. */
function detectFromWebXml(webappFilesRoot: string): string | null {
  const webXmlPath = path.join(webappFilesRoot, 'WEB-INF', 'web.xml');
  if (!fs.existsSync(webXmlPath)) return null;
  try {
    const text = fs.readFileSync(webXmlPath, 'utf8');
    const m = text.match(/<web-app[^>]*xmlns[^>]*="([^"]+)"/i)
      || text.match(/<web-app[^>]*version\s*=\s*"([^"]+)"/i);
    if (m) return `WEB-INF/web.xml present (root namespace/version: ${m[1].trim()})`;
    return 'WEB-INF/web.xml present';
  } catch {
    return 'WEB-INF/web.xml present';
  }
}

/** persistence.xml presence confirms JPA regardless of which API jar carries it. */
function detectFromPersistenceXml(resourceFilesRoot: string): string | null {
  const p = path.join(resourceFilesRoot, 'META-INF', 'persistence.xml');
  if (!fs.existsSync(p)) return null;
  try {
    const text = fs.readFileSync(p, 'utf8');
    if (/xmlns="[^"]*jakarta\.persistence/i.test(text)) return 'META-INF/persistence.xml present (Jakarta Persistence)';
    return 'META-INF/persistence.xml present';
  } catch {
    return 'META-INF/persistence.xml present';
  }
}

/** ejb-jar.xml or an EJB deployment descriptor in a WAR confirms EJB beyond just the API jar. */
function detectFromEjbDescriptor(webappFilesRoot: string, resourceFilesRoot: string): string | null {
  const candidates = [
    path.join(webappFilesRoot, 'WEB-INF', 'ejb-jar.xml'),
    path.join(resourceFilesRoot, 'META-INF', 'ejb-jar.xml'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return `EJB deployment descriptor present: ${path.basename(c)}`;
  }
  return null;
}

/** Spring context files (applicationContext.xml / spring config in WEB-INF) confirm Spring Core
 * even when only annotation-driven config exists alongside no spring-core jar (rare, but a
 * pure-XML config with a hand-copied spring.jar sometimes resolves to nothing). */
function detectFromSpringContext(webappFilesRoot: string, resourceFilesRoot: string): string | null {
  const candidates = [
    path.join(webappFilesRoot, 'WEB-INF', 'applicationContext.xml'),
    path.join(resourceFilesRoot, 'applicationContext.xml'),
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) return `Spring application context present: ${path.relative(webappFilesRoot, c).replace(/\\/g, '/')}`;
  }
  return null;
}

/** MANIFEST.MF Implement-Title / Implementation-Title hints (e.g., "Spring Framework") —
 * weakest evidence, only used when nothing stronger matched. */
function detectFromManifest(extractedDir: string): string | null {
  const manifestPath = path.join(extractedDir, 'META-INF', 'MANIFEST.MF');
  if (!fs.existsSync(manifestPath)) return null;
  try {
    const text = fs.readFileSync(manifestPath, 'utf8');
    if (/spring-boot/i.test(text)) return 'MANIFEST.MF references Spring Boot';
    return null;
  } catch {
    return null;
  }
}

// ─── Priority / primary-framework selection ────────────────────────────

/** Lower = higher priority for deciding the pom.xml's primary facet. A Boot app beats a plain
 * Spring-MVC app beats plain J2EE descriptors; Quarkus/Micronaut are their own worlds. */
const PRIMARY_PRIORITY: FrameworkId[] = [
  'spring-boot',
  'quarkus',
  'micronaut',
  'spring-webflux',
  'spring-mvc',
  'struts',
  'jsf',
  'vaadin',
  'gwt',
  'jakarta-ee',
  'java-ee',
  'ejb',
  'jpa',
  'hibernate',
  'jersey',
  'spring-core',
  'servlet',
  'lombok',
];

const WEB_FRAMEWORKS = new Set<FrameworkId>([
  'spring-boot', 'spring-mvc', 'spring-webflux', 'struts', 'jsf',
  'vaadin', 'gwt', 'jakarta-ee', 'java-ee', 'servlet', 'jersey',
]);

/**
 * Runs framework detection over the dependency list + descriptor files.
 *
 * @param dependencies            resolved DependencyResolution[] (may contain 'unresolved' entries)
 * @param webappFilesRoot         absolute path of the extracted WAR root (or workspace if jar)
 * @param resourceFilesRoot       absolute path of the classes/resources root
 * @param extractedDir            absolute path of the full extraction directory (MANIFEST lookup)
 */
export function detectFrameworks(
  dependencies: DependencyResolution[],
  webappFilesRoot: string,
  resourceFilesRoot: string,
  extractedDir: string,
): FrameworkDetectionResult {
  const frameworks: DetectedFramework[] = [];
  const seen = new Set<FrameworkId>();

  const add = (id: FrameworkId, label: string, confidence: 'confirmed' | 'inferred', evidence: string) => {
    if (seen.has(id)) {
      const existing = frameworks.find(f => f.id === id);
      if (existing && existing.confidence === 'inferred' && confidence === 'confirmed') {
        existing.confidence = 'confirmed';
        existing.evidence = evidence;
      }
      return;
    }
    seen.add(id);
    frameworks.push({ id, label, confidence, evidence });
  };

  // 1. Coordinate-based detection (strongest signal — the framework's own jar is here)
  for (const dep of dependencies) {
    if (!dep.groupId || !dep.artifactId) continue;
    const coord = `${dep.groupId}:${dep.artifactId}`.toLowerCase();
    for (const cp of COORDINATE_PATTERNS) {
      if (cp.pattern.test(coord)) {
        add(cp.framework, cp.label, cp.confidence, `Dependency ${dep.groupId}:${dep.artifactId}:${dep.version} (${dep.jarName})`);
        break;
      }
    }
  }

  // 2. Descriptor-based confirmation / detection
  const webXmlEvidence = detectFromWebXml(webappFilesRoot);
  if (webXmlEvidence) add('servlet', 'Servlet API', 'confirmed', webXmlEvidence);
  const persistenceEvidence = detectFromPersistenceXml(resourceFilesRoot);
  if (persistenceEvidence) add('jpa', 'JPA', 'confirmed', persistenceEvidence);
  const ejbEvidence = detectFromEjbDescriptor(webappFilesRoot, resourceFilesRoot);
  if (ejbEvidence) add('ejb', 'EJB', 'confirmed', ejbEvidence);
  const springContextEvidence = detectFromSpringContext(webappFilesRoot, resourceFilesRoot);
  if (springContextEvidence) add('spring-core', 'Spring (core context)', 'confirmed', springContextEvidence);

  // 3. Manifest as a last-ditch inference (only if nothing else detected Spring at all)
  if (!seen.has('spring-boot') && !seen.has('spring-core')) {
    const manifestEvidence = detectFromManifest(extractedDir);
    if (manifestEvidence) add('spring-core', 'Spring (core)', 'inferred', manifestEvidence);
  }

  // Primary = highest-priority detected framework
  let primary: FrameworkId | null = null;
  for (const candidate of PRIMARY_PRIORITY) {
    if (seen.has(candidate)) { primary = candidate; break; }
  }

  const isWebApplication = webXmlEvidence !== null
    || (primary !== null && WEB_FRAMEWORKS.has(primary));

  logger.info(`Framework detection complete: ${frameworks.map(f => f.id).join(', ') || 'none'} (primary: ${primary || 'none'})`);

  return { frameworks, primary, isWebApplication };
}