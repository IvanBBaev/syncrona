// SPDX-License-Identifier: GPL-3.0-or-later
// ts-jest lives in the workspace root node_modules (hoisted); resolve it
// explicitly so this package can run jest without its own copy.
module.exports = {
  testEnvironment: 'node',
  transform: {
    '^.+\\.ts$': [require.resolve('ts-jest'), { tsconfig: { types: ['node', 'jest'] } }],
  },
  testMatch: ['**/test/**/*.test.ts'],
  collectCoverageFrom: ['src/**/*.ts'],
  // Ratchet: this is pure, IO-free policy + OAuth-token-manager code with no
  // platform branches, and the suite now fully exercises it — measured coverage
  // is 100/100/100/100 (the no-refresh-token forceRefresh path is now covered).
  // Floors sit just under the measured numbers so an untested new branch trips
  // the gate while an incidental defensive line does not.
  coverageThreshold: {
    global: {
      statements: 98,
      branches: 95,
      functions: 100,
      lines: 98,
    },
  },
}
