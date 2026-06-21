module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Force the OS keychain off by default so no test touches the real keychain
  // (hermetic + deterministic); keychain behaviour is tested via mocks.
  setupFiles: ['<rootDir>/jest.setup.js'],
  // Whole-source coverage: the gate previously measured only src/commands.ts,
  // which made the "core >= 80%" CI claim meaningless. Thresholds below are a
  // ratchet floor set just under the measured baseline (2026-06-21: statements
  // 73.5%, branches 61.7%, functions 66.7%, lines 73.1% — up from the 2026-06-13
  // baseline as the pure-helper test suites landed: genericUtils, FileUtils,
  // commandHelpers, snClient, appUtils) — raise them as coverage grows; never
  // lower them. Remaining headroom toward 70%+ branches is in the IO-heavy paths
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
      statements: 72,
      branches: 60,
      functions: 65,
      lines: 72,
    },
  },
}
