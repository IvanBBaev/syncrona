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
  // 85.7%, branches 72.3%, functions 80.7%, lines 85.6% — up from the earlier
  // 77.3/64.2/72.2/77.0 baseline as the offline appUtils/commands/wizard/
  // PluginManager/snClient suites landed on the IO-heavy paths that the
  // pure-helper suites could not reach) — raise them as coverage grows; never
  // lower them. Remaining headroom is in the few live-only request branches.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/tests/**',
  ],
  testPathIgnorePatterns: [
    ".js"
  ],
  coverageThreshold: {
    global: {
      statements: 85,
      branches: 72,
      functions: 80,
      lines: 85,
    },
  },
}
