module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/tests'],
  testMatch: ['**/*.test.ts'],
  // java-parser ships ESM-only with a dependency (chevrotain) that has NO CommonJS export
  // condition at all — Node's native dynamic-import interop handles this fine outside Jest
  // (confirmed live against the real dist/ build), but Jest's own CJS-oriented module system
  // can't load it at all, even with Babel down-leveling (chevrotain's package.json "exports"
  // map has only an "import" condition, so a transformed require() call has no valid resolution
  // path — this isn't a syntax-transform problem, it's a module-resolution dead end). Swap in a
  // small hand-written stand-in for tests instead: it exercises checkJavaSyntax's own
  // wrapping/scoring-integration logic without needing the real grammar loaded, and the real
  // grammar's correctness is verified separately via live pipeline runs against real WARs.
  moduleNameMapper: {
    '^java-parser$': '<rootDir>/tests/mocks/javaParserMock.ts',
  },
};
