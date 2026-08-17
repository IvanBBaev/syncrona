// SPDX-License-Identifier: GPL-3.0-or-later
// ts-jest lives in the workspace root node_modules (hoisted); resolve it
// explicitly so this package can run jest without its own copy.
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': [require.resolve('ts-jest'), { tsconfig: { types: ['node', 'jest'] } }],
  },
  testMatch: ['**/test/**/*.test.ts'],
  // An unhandled promise rejection must fail a test, not kill the worker. Node 22
  // defaults to `--unhandled-rejections=throw`, and without this flag jest-circus
  // removes its own listener at `teardown` before yielding to the event loop, so a
  // rejection that becomes unhandled in the same turn the test settles kills the
  // process mid-file — every test it had not reached yet silently never runs and
  // the suite still looks green from the outside. Reproduced in sibling packages
  // with a throwaway fixture before the flag was added; see
  // packages/core/jest.config.cjs for the full mechanism and the pinning test.
  waitForUnhandledRejections: true,
  collectCoverageFrom: ['src/**/*.ts'],
  // Ratchet: this package is pure, IO-free, branch-dense detection code and the
  // corpus suite exercises every pattern from both sides (a true positive and a
  // near-miss false positive per rule) — measured coverage is 100/100/100/100.
  // The floors are set AT the measurement rather than just under it, which is the
  // right call for exactly this file set: there are no platform branches to drift
  // across OSes, so any drop is a real, newly untested branch in a security
  // primitive. Every other package here keeps a small gap because it has platform
  // or optional-dependency branches; this one has none.
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
}
