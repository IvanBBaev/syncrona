// SPDX-License-Identifier: GPL-3.0-or-later
// ts-jest lives in the workspace root node_modules (hoisted); resolve it
// explicitly so this package can run jest without its own copy.
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': [require.resolve('ts-jest'), { tsconfig: { types: ['node', 'jest'] } }],
  },
  testMatch: ['**/test/**/*.test.ts'],
  // See packages/mirror/jest.config.js and packages/core/jest.config.cjs: an
  // unhandled rejection must fail a test, not kill the worker mid-file.
  waitForUnhandledRejections: true,
  collectCoverageFrom: ['src/**/*.ts'],
  // Every SDK and network touchpoint here is injected: the SDK through the
  // `loadSdk` seam, the UI-session login through a `fetch` parameter. The tests
  // drive a fake SDK and a scripted fetch, so no branch needs the real SDK or an
  // instance. Measured across all 4 suites (42 tests): 100/100/100/100, so the
  // floor sits at it; an untested branch must be an `istanbul ignore` with a reason.
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
}
