// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  isValidScopeCode,
  autoPullAllScopesAndData,
} = require('../dist/scopeBootstrap.js');

const AUTO_PULL_ENV = 'SYNCRONA_MCP_AUTO_PULL_ALL_SCOPES';

// ---------------------------------------------------------------------------
// isValidScopeCode — pure function, exercise both sides of the regex branch.
// ---------------------------------------------------------------------------

test('isValidScopeCode: accepts a well-formed x_<vendor>_<app> scope code', () => {
  assert.equal(isValidScopeCode('x_a_b'), true);
});

test('isValidScopeCode: accepts digits and multiple underscores', () => {
  assert.equal(isValidScopeCode('x_acme_my_app_2'), true);
  assert.equal(isValidScopeCode('x_123_456'), true);
});

test('isValidScopeCode: accepts the shortest possible x_ prefix with trailing chars', () => {
  assert.equal(isValidScopeCode('x_a'), true);
});

test('isValidScopeCode: rejects a value with a path traversal segment', () => {
  assert.equal(isValidScopeCode('x_a../../etc'), false);
  assert.equal(isValidScopeCode('../x_a_b'), false);
});

test('isValidScopeCode: rejects an absolute path', () => {
  assert.equal(isValidScopeCode('/etc/passwd'), false);
  assert.equal(isValidScopeCode('x_/etc/passwd'), false);
});

test('isValidScopeCode: rejects uppercase letters', () => {
  assert.equal(isValidScopeCode('X_A_B'), false);
  assert.equal(isValidScopeCode('x_A_b'), false);
});

test('isValidScopeCode: rejects an empty string', () => {
  assert.equal(isValidScopeCode(''), false);
});

test('isValidScopeCode: rejects a value missing the x_ prefix', () => {
  assert.equal(isValidScopeCode('a_b_c'), false);
  assert.equal(isValidScopeCode('global'), false);
});

test('isValidScopeCode: rejects values with disallowed characters (dot, space, dash)', () => {
  assert.equal(isValidScopeCode('x_a.b'), false);
  assert.equal(isValidScopeCode('x_a b'), false);
  assert.equal(isValidScopeCode('x_a-b'), false);
});

test('isValidScopeCode: rejects "x_" alone (no vendor/app segment)', () => {
  assert.equal(isValidScopeCode('x_'), false);
});

test('isValidScopeCode: rejects a bare "x" with no separator', () => {
  assert.equal(isValidScopeCode('x'), false);
});

// ---------------------------------------------------------------------------
// autoPullAllScopesAndData — only the disabled short-circuit is exercised
// here. It is the one deterministic, network-free branch: the env toggle is
// read before any filesystem write, credential resolution or child-process
// spawn, so driving it does not risk touching a real ServiceNow instance
// (this machine may have a real credential store entry configured) or the
// filesystem outside what the function itself decides to touch (nothing, on
// this path).
// ---------------------------------------------------------------------------

function snapshotEnv(key) {
  return Object.prototype.hasOwnProperty.call(process.env, key) ? process.env[key] : undefined;
}

function restoreEnv(key, value) {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}

for (const offValue of ['0', 'false', 'no', 'off', 'OFF', 'False']) {
  test(`autoPullAllScopesAndData: skips when ${AUTO_PULL_ENV}=${offValue}`, async () => {
    const prev = snapshotEnv(AUTO_PULL_ENV);
    const origConsoleError = console.error;
    const messages = [];
    console.error = (msg) => messages.push(msg);
    try {
      process.env[AUTO_PULL_ENV] = offValue;
      const result = await autoPullAllScopesAndData(50);
      assert.equal(result, undefined);
      assert.ok(
        messages.some((m) => String(m).includes('Auto scope pull skipped')),
        `expected a "skipped" log message, got: ${JSON.stringify(messages)}`
      );
    } finally {
      console.error = origConsoleError;
      restoreEnv(AUTO_PULL_ENV, prev);
    }
  });
}

test('autoPullAllScopesAndData: resolves (does not throw) when the toggle is off, using default timeout', async () => {
  const prev = snapshotEnv(AUTO_PULL_ENV);
  const origConsoleError = console.error;
  console.error = () => {};
  try {
    process.env[AUTO_PULL_ENV] = '0';
    await assert.doesNotReject(async () => {
      await autoPullAllScopesAndData();
    });
  } finally {
    console.error = origConsoleError;
    restoreEnv(AUTO_PULL_ENV, prev);
  }
});

test('shouldAutoPullAllScopes truthiness: whitespace-padded off value still skips (trim + lowercase)', async () => {
  const prev = snapshotEnv(AUTO_PULL_ENV);
  const origConsoleError = console.error;
  const messages = [];
  console.error = (msg) => messages.push(msg);
  try {
    process.env[AUTO_PULL_ENV] = '  OFF  ';
    await autoPullAllScopesAndData(50);
    assert.ok(messages.some((m) => String(m).includes('Auto scope pull skipped')));
  } finally {
    console.error = origConsoleError;
    restoreEnv(AUTO_PULL_ENV, prev);
  }
});
