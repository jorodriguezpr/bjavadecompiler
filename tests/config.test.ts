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

import { Config } from '../src/config/config';

const ENV_KEYS = ['JDK_HOME_OVERRIDES', 'DEFAULT_TARGET_JAVA_VERSION', 'JAVAEE_PROVIDED_LIBS_DIR'];

describe('Config.jdkHomeOverrides / jdkHomeForVersion', () => {
  const original: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of ENV_KEYS) { original[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of ENV_KEYS) { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; } });

  it('returns an empty map and null lookups when unset', () => {
    expect(Config.jdkHomeOverrides.size).toBe(0);
    expect(Config.jdkHomeForVersion(8)).toBeNull();
  });

  it('parses version=path pairs separated by ; or ,', () => {
    process.env.JDK_HOME_OVERRIDES = String.raw`8=C:\Program Files\Java\jdk1.8.0_202;11=C:\Program Files\Java\jdk-11`;
    expect(Config.jdkHomeForVersion(8)).toBe(String.raw`C:\Program Files\Java\jdk1.8.0_202`);
    expect(Config.jdkHomeForVersion(11)).toBe(String.raw`C:\Program Files\Java\jdk-11`);
    expect(Config.jdkHomeForVersion(17)).toBeNull();
  });

  it('ignores a malformed entry (no "=") without throwing', () => {
    process.env.JDK_HOME_OVERRIDES = String.raw`not-a-pair;8=C:\jdk8`;
    expect(Config.jdkHomeForVersion(8)).toBe(String.raw`C:\jdk8`);
  });
});

describe('Config.defaultTargetJavaVersion', () => {
  const original: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of ENV_KEYS) { original[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of ENV_KEYS) { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; } });

  it('is null when unset (auto-detect)', () => {
    expect(Config.defaultTargetJavaVersion).toBeNull();
  });

  it('is null when explicitly "auto"', () => {
    process.env.DEFAULT_TARGET_JAVA_VERSION = 'auto';
    expect(Config.defaultTargetJavaVersion).toBeNull();
  });

  it('parses a numeric override', () => {
    process.env.DEFAULT_TARGET_JAVA_VERSION = '8';
    expect(Config.defaultTargetJavaVersion).toBe(8);
  });

  it('is null for garbage input rather than throwing', () => {
    process.env.DEFAULT_TARGET_JAVA_VERSION = 'not-a-number';
    expect(Config.defaultTargetJavaVersion).toBeNull();
  });
});

describe('Config.javaEeProvidedLibsDirs', () => {
  const original: Record<string, string | undefined> = {};
  beforeEach(() => { for (const k of ENV_KEYS) { original[k] = process.env[k]; delete process.env[k]; } });
  afterEach(() => { for (const k of ENV_KEYS) { if (original[k] === undefined) delete process.env[k]; else process.env[k] = original[k]; } });

  it('is empty when unset', () => {
    expect(Config.javaEeProvidedLibsDirs).toEqual([]);
  });

  it('splits on ; and , and trims entries', () => {
    process.env.JAVAEE_PROVIDED_LIBS_DIR = String.raw` C:\glassfish4\glassfish\lib ; C:\glassfish4\glassfish\modules `;
    expect(Config.javaEeProvidedLibsDirs).toEqual([
      String.raw`C:\glassfish4\glassfish\lib`,
      String.raw`C:\glassfish4\glassfish\modules`,
    ]);
  });
});
