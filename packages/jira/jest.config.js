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
  // Ratchet: floors sit just under the measured coverage (96.8/83.5/97.2/97) so
  // a regression fails CI, while ADF edge nodes keep a little branch headroom.
  coverageThreshold: {
    global: {
      statements: 95,
      branches: 80,
      functions: 95,
      lines: 95,
    },
  },
}
