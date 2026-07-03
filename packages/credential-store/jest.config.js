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
