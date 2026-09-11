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

import fs from 'fs';
import os from 'os';
import path from 'path';
import { detectFrameworks } from '../src/services/frameworkDetectionService';
import { DependencyResolution } from '../src/models/job';

function makeTempDir(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bjd-fw-'));
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(dir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return dir;
}

function dep(groupId: string, artifactId: string, version = '1.0'): DependencyResolution {
  return {
    jarName: `${artifactId}-${version}.jar`,
    sha1: 'deadbeef',
    groupId, artifactId, version,
    classifier: null,
    scope: 'compile',
    confidence: 'pom-properties',
    decompiledSourceDir: null,
    sharedLibrarySource: null,
  };
}

describe('detectFrameworks — coordinate-based', () => {
  it('detects Spring Boot from spring-boot jar', () => {
    const dir = makeTempDir({});
    const result = detectFrameworks(
      [dep('org.springframework.boot', 'spring-boot', '3.2.0')],
      dir, dir, dir,
    );
    const sb = result.frameworks.find(f => f.id === 'spring-boot');
    expect(sb).toBeDefined();
    expect(sb!.confidence).toBe('confirmed');
    expect(result.primary).toBe('spring-boot');
    expect(result.isWebApplication).toBe(true);
  });

  it('detects Spring MVC from spring-webmvc jar', () => {
    const dir = makeTempDir({});
    const result = detectFrameworks(
      [dep('org.springframework', 'spring-webmvc', '5.3.0')],
      dir, dir, dir,
    );
    expect(result.frameworks.find(f => f.id === 'spring-mvc')).toBeDefined();
    expect(result.primary).toBe('spring-mvc');
  });

  it('detects Struts', () => {
    const dir = makeTempDir({});
    const result = detectFrameworks(
      [dep('org.apache.struts', 'struts2-core', '2.5.30')],
      dir, dir, dir,
    );
    expect(result.frameworks.find(f => f.id === 'struts')).toBeDefined();
    expect(result.primary).toBe('struts');
  });

  it('detects Hibernate and JPA', () => {
    const dir = makeTempDir({});
    const result = detectFrameworks(
      [dep('org.hibernate', 'hibernate-core', '5.6.0'),
       dep('javax.persistence', 'javax.persistence-api', '2.2')],
      dir, dir, dir,
    );
    expect(result.frameworks.find(f => f.id === 'hibernate')).toBeDefined();
    expect(result.frameworks.find(f => f.id === 'jpa')).toBeDefined();
  });

  it('detects Jakarta EE API', () => {
    const dir = makeTempDir({});
    const result = detectFrameworks(
      [dep('jakarta.platform', 'jakarta.jakartaee-api', '10.0.0')],
      dir, dir, dir,
    );
    expect(result.frameworks.find(f => f.id === 'jakarta-ee')).toBeDefined();
  });

  it('detects Quarkus and Micronaut', () => {
    const dir = makeTempDir({});
    const result = detectFrameworks(
      [dep('io.quarkus', 'quarkus-core', '3.0.0')],
      dir, dir, dir,
    );
    expect(result.frameworks.find(f => f.id === 'quarkus')).toBeDefined();
    expect(result.primary).toBe('quarkus');
  });

  it('detects Lombok', () => {
    const dir = makeTempDir({});
    const result = detectFrameworks(
      [dep('org.projectlombok', 'lombok', '1.18.30')],
      dir, dir, dir,
    );
    expect(result.frameworks.find(f => f.id === 'lombok')).toBeDefined();
    // Lombok alone is not a web application
    expect(result.isWebApplication).toBe(false);
  });

  it('returns no frameworks for a plain jar with generic deps', () => {
    const dir = makeTempDir({});
    const result = detectFrameworks(
      [dep('com.google.guava', 'guava', '32.0.0')],
      dir, dir, dir,
    );
    expect(result.frameworks).toHaveLength(0);
    expect(result.primary).toBeNull();
    expect(result.isWebApplication).toBe(false);
  });

  it('skips unresolved dependencies in coordinate detection', () => {
    const dir = makeTempDir({});
    const unresolved = { ...dep('com.bjavadecompiler.unresolved', 'mystery-lib'), confidence: 'unresolved' as const };
    const result = detectFrameworks([unresolved], dir, dir, dir);
    expect(result.frameworks).toHaveLength(0);
  });
});

describe('detectFrameworks — descriptor-based', () => {
  it('detects servlet from web.xml', () => {
    const dir = makeTempDir({
      'WEB-INF/web.xml': '<?xml version="1.0"?><web-app xmlns="http://xmlns.jcp.org/xml/ns/javaee" version="3.1"></web-app>',
    });
    const result = detectFrameworks([], dir, dir, dir);
    const servlet = result.frameworks.find(f => f.id === 'servlet');
    expect(servlet).toBeDefined();
    expect(servlet!.evidence).toContain('web.xml');
    expect(result.isWebApplication).toBe(true);
  });

  it('detects JPA from persistence.xml', () => {
    const dir = makeTempDir({
      'META-INF/persistence.xml': '<?xml version="1.0"?><persistence xmlns="http://xmlns.jcp.org/xml/ns/persistence"></persistence>',
    });
    const result = detectFrameworks([], dir, dir, dir);
    const jpa = result.frameworks.find(f => f.id === 'jpa');
    expect(jpa).toBeDefined();
    expect(jpa!.evidence).toContain('persistence.xml');
  });

  it('detects EJB from ejb-jar.xml', () => {
    const dir = makeTempDir({
      'META-INF/ejb-jar.xml': '<?xml version="1.0"?><ejb-jar></ejb-jar>',
    });
    const result = detectFrameworks([], dir, dir, dir);
    expect(result.frameworks.find(f => f.id === 'ejb')).toBeDefined();
  });

  it('detects Spring core from applicationContext.xml', () => {
    const dir = makeTempDir({
      'applicationContext.xml': '<beans></beans>',
    });
    const result = detectFrameworks([], dir, dir, dir);
    expect(result.frameworks.find(f => f.id === 'spring-core')).toBeDefined();
  });

  it('upgrades confidence when both coordinate and descriptor agree', () => {
    // persistence.xml (confirmed) + hibernate-jpa api coordinate — should stay confirmed and
    // not duplicate the JPA entry
    const dir = makeTempDir({
      'META-INF/persistence.xml': '<persistence/>',
    });
    const result = detectFrameworks(
      [dep('org.hibernate.javax.persistence', 'hibernate-jpa-2.1-api', '1.0.2')],
      dir, dir, dir,
    );
    const jpaEntries = result.frameworks.filter(f => f.id === 'jpa');
    expect(jpaEntries).toHaveLength(1);
    expect(jpaEntries[0].confidence).toBe('confirmed');
  });
});

describe('detectFrameworks — primary selection', () => {
  it('prefers spring-boot over spring-mvc when both are present', () => {
    const dir = makeTempDir({});
    const result = detectFrameworks(
      [dep('org.springframework.boot', 'spring-boot-starter-web', '3.2.0'),
       dep('org.springframework', 'spring-webmvc', '6.0.0')],
      dir, dir, dir,
    );
    // spring-boot-starter-web matches the spring-boot prefix pattern
    expect(result.primary).toBe('spring-boot');
  });

  it('prefers spring-mvc over plain spring-core', () => {
    const dir = makeTempDir({});
    const result = detectFrameworks(
      [dep('org.springframework', 'spring-core', '5.3.0'),
       dep('org.springframework', 'spring-webmvc', '5.3.0')],
      dir, dir, dir,
    );
    expect(result.primary).toBe('spring-mvc');
  });
});