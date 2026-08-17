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
  // the suite still looks green from the outside. Reproduced in this package with a
  // throwaway fixture before the flag was added; see packages/core/jest.config.cjs
  // for the full mechanism and the pinning test.
  waitForUnhandledRejections: true,
  collectCoverageFrom: ['src/**/*.ts'],
  // Ratchet: floors sit just under the measured coverage (97/88/100/97). The
  // optional keychain native module is virtually mocked (see keychainBackend.test),
  // so these numbers are platform-independent — no macOS-vs-Linux branch drift.
  // This crypto/key-material code is security-critical, so it must be gated, not
  // merely measured.
  coverageThreshold: {
    global: {
      statements: 94,
      branches: 83,
      functions: 100,
      lines: 94,
    },
  },
}
