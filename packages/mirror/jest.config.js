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
  // the suite still looks green from the outside. See packages/core/jest.config.cjs
  // for the full mechanism and the pinning test.
  waitForUnhandledRejections: true,
  collectCoverageFrom: ['src/**/*.ts'],
  // Ratchet, now at the ceiling. Everything in `src/` is written against an
  // injected seam: the serializer is a pure function of (row, catalog entry) —
  // INV-7 — the config loader is a pure function of its input, the HTTP client
  // takes its transport, clock, sleep and RNG as parameters, and the writer takes
  // its filesystem. So there is no I/O, no wall time and no network anywhere in
  // this package that a test cannot stand in front of, and every branch is
  // reachable from a fixture.
  //
  // Measured across all 25 suites (875 tests): 100/100/100/100. Because that is
  // reachable here, the floor is set AT it rather than just under it, and the
  // difference matters — a floor of 98 in a package measuring 100 is a budget for
  // two percent of untested new code, which is spent silently. At 100 the only way
  // to add an untested branch is to say so out loud, in an `istanbul ignore` that
  // carries a reason. There are ten of those in this package and every one of them
  // names an input the platform cannot produce — a race against a directory this
  // process just created, a key the enumerator cannot emit, an errno `node:fs`
  // does not raise.
  //
  // If a future stage genuinely cannot be driven to 100, the honest move is the
  // ignore comment with its justification, not a lower number here. These only
  // ever move up.
  coverageThreshold: {
    global: {
      statements: 100,
      branches: 100,
      functions: 100,
      lines: 100,
    },
  },
}
