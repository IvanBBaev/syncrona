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
    // REV-95 (GATE-1): the global-only thresholds above are diluted by the
    // whole tree — a brand-new source file at 0% coverage barely moves the
    // aggregate and ships green. These PER-FILE floors catch that: every file
    // that mismatches the floor fails CI on its own.
    //
    // Both globs together still preserve the global ratchet. Jest computes the
    // "global" bucket from files that match NO other threshold group; because
    // './src/*.ts' matches every collected source file, that bucket is empty
    // and Jest falls back to measuring `global` across ALL covered files (see
    // @jest/reporters coverage_reporter). So global and per-file gates both
    // stay live.
    //
    // The floors are deliberately conservative — far below the weakest
    // legitimately-thin file so cross-OS coverage noise never fails green, yet
    // well above a 0%-covered newcomer. Current weakest legitimate files
    // (2026-07-03 baseline): branches — authCommands.ts 55.6%; lines (excl.
    // index.ts) — cliCommands.ts 36.1%. Tune upward as coverage grows.
    //
    // src/index.ts is the CLI entry barrel (exercised only via subprocess
    // smoke tests, so it measures 0% lines/functions but 100% branches). It is
    // matched only by the branches glob below (which it passes) and excluded
    // from the lines glob via the '!(index)' extglob, so its legitimate 0%
    // lines does not fail the floor.
    './src/*.ts': {
      branches: 20,
    },
    './src/!(index).ts': {
      lines: 20,
    },
  },
}
