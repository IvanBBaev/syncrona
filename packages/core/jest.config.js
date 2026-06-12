module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Whole-source coverage: the gate previously measured only src/commands.ts,
  // which made the "core >= 80%" CI claim meaningless. Thresholds below are a
  // ratchet floor set just under the measured baseline (2026-06-12:
  // statements 70%, branches 56%, functions 60%) — raise them as coverage
  // grows; never lower them.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/tests/**',
  ],
  testPathIgnorePatterns: [
    ".js"
  ],
  coverageThreshold: {
    global: {
      statements: 68,
      branches: 54,
      functions: 58,
      lines: 68,
    },
  },
}
