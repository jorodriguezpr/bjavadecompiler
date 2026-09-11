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

import axios from 'axios';
import { verifyArtifactResolvable, searchByArtifactIdGuess, findProvidedApiForPackage } from '../src/services/dependencyResolutionService';

jest.mock('axios');
const mockedHead = axios.head as jest.Mock;
const mockedGet = axios.get as jest.Mock;

describe('verifyArtifactResolvable', () => {
  afterEach(() => jest.clearAllMocks());

  it('accepts a coordinate whose plain jar exists, with no classifier', async () => {
    mockedHead.mockResolvedValueOnce({ status: 200 });

    const result = await verifyArtifactResolvable('javax.mail', 'javax.mail-api', '1.6.2', 'mail.jar');

    expect(result).toEqual({ ok: true, classifier: null });
    expect(mockedHead).toHaveBeenCalledTimes(1);
    expect(mockedHead).toHaveBeenCalledWith(
      'https://repo.maven.apache.org/maven2/javax/mail/javax.mail-api/1.6.2/javax.mail-api-1.6.2.jar',
      expect.anything(),
    );
  });

  it('recovers the classifier from the original filename when only a classified jar exists (real json-lib case)', async () => {
    // Confirmed real failure: net.sf.json-lib:json-lib:1.1 has a valid POM and shows up in
    // Central's search index, but the plain jar 404s forever — only json-lib-1.1-jdk13.jar
    // exists. The classifier ("jdk13") comes from the WAR's own original filename.
    mockedHead
      .mockResolvedValueOnce({ status: 404 }) // plain jar: doesn't exist
      .mockResolvedValueOnce({ status: 200 }); // classified jar: exists

    const result = await verifyArtifactResolvable('net.sf.json-lib', 'json-lib', '1.1', 'json-lib-1.1-jdk13.jar');

    expect(result).toEqual({ ok: true, classifier: 'jdk13' });
    expect(mockedHead).toHaveBeenNthCalledWith(
      2,
      'https://repo.maven.apache.org/maven2/net/sf/json-lib/json-lib/1.1/json-lib-1.1-jdk13.jar',
      expect.anything(),
    );
  });

  it('rejects a coordinate when neither the plain jar nor a filename-derived classifier resolves', async () => {
    mockedHead.mockResolvedValue({ status: 404 });

    const result = await verifyArtifactResolvable('com.example', 'ghost-lib', '9.9.9', 'ghost-lib-9.9.9.jar');

    expect(result).toEqual({ ok: false, classifier: null });
  });

  it('does not attempt a second request when the original filename carries no extractable classifier', async () => {
    mockedHead.mockResolvedValueOnce({ status: 404 });

    // Filename doesn't match "<artifactId>-<version>-<classifier>.jar" at all.
    const result = await verifyArtifactResolvable('com.example', 'ghost-lib', '9.9.9', 'totally-unrelated-name.jar');

    expect(result).toEqual({ ok: false, classifier: null });
    expect(mockedHead).toHaveBeenCalledTimes(1);
  });

  it('treats a network error as "does not exist" rather than throwing', async () => {
    mockedHead.mockRejectedValue(new Error('ETIMEDOUT'));

    const result = await verifyArtifactResolvable('com.example', 'flaky-lib', '1.0', 'flaky-lib-1.0.jar');

    expect(result).toEqual({ ok: false, classifier: null });
  });
});

describe('searchByArtifactIdGuess', () => {
  afterEach(() => jest.clearAllMocks());

  it('rejects Central\'s "latest" when its major version differs from the jar filename\'s own version (real opencsv case)', async () => {
    // Confirmed real failure: opencsv-1.3.jar (package au.com.bytecode.opencsv) got matched to
    // com.opencsv:opencsv, and this search only checks artifactId, so it took whatever "latest"
    // happens to be on Central right now (5.10, package com.opencsv — opencsv renamed its
    // package across this exact major-version gap) — guaranteed to fail on import.
    mockedGet.mockResolvedValueOnce({ data: { response: { docs: [{ g: 'com.opencsv', a: 'opencsv', latestVersion: '5.10' }] } } });

    const result = await searchByArtifactIdGuess('opencsv-1.3.jar');

    expect(result).toBeNull();
  });

  it('accepts Central\'s "latest" when the major version matches the jar filename\'s own version', async () => {
    mockedGet.mockResolvedValueOnce({ data: { response: { docs: [{ g: 'commons-lang', a: 'commons-lang3', latestVersion: '3.17.0' }] } } });

    const result = await searchByArtifactIdGuess('commons-lang3-3.14.0.jar');

    expect(result).toEqual({ groupId: 'commons-lang', artifactId: 'commons-lang3', version: '3.17.0' });
  });

  it('accepts the guess when the filename has no extractable version to compare against', async () => {
    mockedGet.mockResolvedValueOnce({ data: { response: { docs: [{ g: 'com.example', a: 'weird-name', latestVersion: '9.0' }] } } });

    const result = await searchByArtifactIdGuess('weird-name-no-version.jar');

    expect(result).toEqual({ groupId: 'com.example', artifactId: 'weird-name', version: '9.0' });
  });

  it('returns null when Central has no match at all', async () => {
    mockedGet.mockResolvedValueOnce({ data: { response: { docs: [] } } });

    const result = await searchByArtifactIdGuess('totally-unknown-lib-1.0.jar');

    expect(result).toBeNull();
  });
});

describe('findProvidedApiForPackage', () => {
  it('matches a package exactly against a catalog entry', () => {
    expect(findProvidedApiForPackage('javax.mail')).toEqual({
      packagePrefix: 'javax.mail', groupId: 'javax.mail', artifactId: 'javax.mail-api', version: '1.6.2',
    });
  });

  it('matches a sub-package of a catalog entry', () => {
    const result = findProvidedApiForPackage('javax.persistence.criteria');
    expect(result?.artifactId).toBe('javax.persistence-api');
  });

  it('prefers the longest matching prefix (javax.servlet.jsp over a hypothetical broader javax.servlet entry)', () => {
    const result = findProvidedApiForPackage('javax.servlet.jsp.tagext');
    expect(result?.artifactId).toBe('javax.servlet.jsp-api');
  });

  it('returns null for a package with no catalog match, including javax.servlet itself (handled separately)', () => {
    expect(findProvidedApiForPackage('javax.servlet')).toBeNull();
    expect(findProvidedApiForPackage('com.wovenware.internal')).toBeNull();
  });

  it('does not false-positive on an unrelated package that merely shares a text prefix', () => {
    // "javax.mailx" is NOT a sub-package of "javax.mail" (no dot boundary) — must not match.
    expect(findProvidedApiForPackage('javax.mailx')).toBeNull();
  });
});
