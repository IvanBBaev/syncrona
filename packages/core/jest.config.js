module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  // Whole-source coverage: the gate previously measured only src/commands.ts,
  // which made the "core >= 80%" CI claim meaningless. Thresholds below are a
  // ratchet floor set just under the measured baseline (2026-06-13: statements
  // 70.7%, branches 57.7%, functions 61.8%, lines 70.5% — up from the 2026-06-12
  // baseline as DX/contract tests landed) — raise them as coverage grows; never
  // lower them.
  collectCoverageFrom: [
    'src/**/*.ts',
    '!src/tests/**',
  ],
  testPathIgnorePatterns: [
    ".js"
  ],
  coverageThreshold: {
    global: {
      statements: 70,
      branches: 57,
      functions: 61,
      lines: 70,
    },
  },
}
