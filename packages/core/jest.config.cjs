// SPDX-License-Identifier: GPL-3.0-or-later
// This config is CommonJS (.cjs) on purpose: the package is now "type": "module"
// (ESM), so a plain jest.config.js would be parsed as ESM and break module.exports.
//
// The source tree is native ESM under TypeScript NodeNext, so tests run as real
// ESM via ts-jest (useESM) + Node's --experimental-vm-modules (set in the "test"
// script). Consequences that shape this config:
//   - extensionsToTreatAsEsm marks .ts files as ESM for the jest runtime.
//   - moduleNameMapper strips the mandatory ".js" suffix off relative specifiers
//     so jest resolves "./foo.js" back to the "./foo.ts" source.
//   - jest.mock() is NOT hoisted/applied under ESM; suites use
//     jest.unstable_mockModule() + a deferred await import() of the subject.
module.exports = {
  testEnvironment: 'node',
  extensionsToTreatAsEsm: ['.ts'],
  transform: {
    '^.+\\.tsx?$': ['ts-jest', { useESM: true }],
  },
  moduleNameMapper: {
    '^(\\.{1,2}/.*)\\.js$': '$1',
  },
  // Force the OS keychain off by default so no test touches the real keychain
  // (hermetic + deterministic); keychain behaviour is tested via mocks.
  setupFiles: ['<rootDir>/jest.setup.cjs'],
  // Whole-source coverage: the gate previously measured only src/commands.ts,
  // which made the "core >= 80%" CI claim meaningless. Thresholds below are a
  // ratchet floor set just under the measured baseline (2026-07-03: statements
  // 95.5%, branches 83.2%, functions 91.8%, lines 95.5% — up from the earlier
  // 85.7/71.9/80.7/85.6 baseline after per-file coverage suites landed for
  // diagnosticsCommands, downloadPipeline, config, FileUtils, manifestBuilder,
  // updateNotifier, pushCommand and Logger). Raise these as coverage grows;
  // never lower them. The lines/statements floors sit ~3pts under the measured
  // numbers so a real regression fails CI while cross-OS noise does not; the
  // branch floor keeps extra headroom because OS-specific branches
  // (keychain/homedir/platform) still make Linux CI measure a touch below macOS.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/tests/**',
  ],
  testPathIgnorePatterns: [
    ".js",
  ],
  coverageThreshold: {
    global: {
      statements: 92,
      branches: 79,
      functions: 89,
      lines: 92,
    },
  },
}
