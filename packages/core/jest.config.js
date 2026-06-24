// SPDX-License-Identifier: GPL-3.0-or-later
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Force the OS keychain off by default so no test touches the real keychain
  // (hermetic + deterministic); keychain behaviour is tested via mocks.
  setupFiles: ['<rootDir>/jest.setup.js'],
  // Whole-source coverage: the gate previously measured only src/commands.ts,
  // which made the "core >= 80%" CI claim meaningless. Thresholds below are a
  // ratchet floor set just under the measured baseline (2026-06-24: statements
  // 77.3%, branches 64.2%, functions 72.2%, lines 77.0% — up from the 2026-06-21
  // baseline as the logMessages, bootstrap and gitUtils suites landed on top of
  // the earlier pure-helper suites: genericUtils, FileUtils, commandHelpers,
  // snClient, appUtils) — raise them as coverage grows; never lower them.
  // Remaining headroom toward 80%+ branches is in the IO-heavy paths
  // (commands/wizard/snClient request paths), addressed opportunistically.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/tests/**',
  ],
  testPathIgnorePatterns: [
    ".js"
  ],
  coverageThreshold: {
    global: {
      statements: 76,
      branches: 63,
      functions: 71,
      lines: 76,
    },
  },
}
