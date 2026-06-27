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
  // Ratchet: floors sit just under the measured coverage (95/75/97/96) so a
  // regression fails CI, while ADF edge nodes keep a little branch headroom.
  coverageThreshold: {
    global: {
      statements: 92,
      branches: 72,
      functions: 92,
      lines: 92,
    },
  },
}
