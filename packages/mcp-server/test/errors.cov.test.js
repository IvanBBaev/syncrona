// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const { McpError, normalizeMcpError } = require('../dist/errors.js');

test('McpError: constructor keeps message, code, details and cause', () => {
  const cause = new Error('boom');
  const err = new McpError('bad input', {
    code: 'INVALID_ARGUMENTS',
    details: { field: 'table' },
    cause,
  });
  assert.ok(err instanceof Error);
  assert.equal(err.name, 'McpError');
  assert.equal(err.message, 'bad input');
  assert.equal(err.code, 'INVALID_ARGUMENTS');
  assert.deepEqual(err.details, { field: 'table' });
  assert.equal(err.cause, cause);
});

test('McpError: missing details defaults to an empty object', () => {
  const err = new McpError('no details', { code: 'UNKNOWN' });
  assert.deepEqual(err.details, {});
  assert.equal(err.cause, undefined);
});

test('normalizeMcpError: an existing McpError is returned unchanged', () => {
  const original = new McpError('already normalized', { code: 'POLICY_VIOLATION' });
  assert.equal(normalizeMcpError(original), original);
});

test('normalizeMcpError: a plain Error becomes a TOOL_EXECUTION McpError with the original as cause', () => {
  const source = new Error('kaboom');
  const err = normalizeMcpError(source);
  assert.ok(err instanceof McpError);
  assert.equal(err.code, 'TOOL_EXECUTION');
  assert.equal(err.message, 'kaboom');
  assert.equal(err.cause, source);
  assert.deepEqual(err.details, {});
});

test('normalizeMcpError: a string becomes an UNKNOWN McpError carrying the string as message and cause', () => {
  const err = normalizeMcpError('just a string');
  assert.ok(err instanceof McpError);
  assert.equal(err.code, 'UNKNOWN');
  assert.equal(err.message, 'just a string');
  assert.equal(err.cause, 'just a string');
});

test('normalizeMcpError: an object with a string message keeps it and preserves the object as details', () => {
  const payload = { message: 'structured failure', status: 500 };
  const err = normalizeMcpError(payload);
  assert.equal(err.code, 'UNKNOWN');
  assert.equal(err.message, 'structured failure');
  assert.deepEqual(err.details, payload);
  assert.equal(err.cause, payload);
});

test('normalizeMcpError: an object without a string message falls back to "Unknown error"', () => {
  const err = normalizeMcpError({ status: 500 });
  assert.equal(err.message, 'Unknown error');
  assert.equal(err.code, 'UNKNOWN');
});

test('normalizeMcpError: null and non-object primitives fall back to "Unknown error" with empty details', () => {
  const err = normalizeMcpError(null);
  assert.equal(err.message, 'Unknown error');
  assert.equal(err.code, 'UNKNOWN');
  assert.deepEqual(err.details, {});

  const numeric = normalizeMcpError(42);
  assert.equal(numeric.message, 'Unknown error');
  assert.deepEqual(numeric.details, {});
});
