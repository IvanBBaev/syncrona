// SPDX-License-Identifier: GPL-3.0-or-later
// SEC-1 follow-up (REV-116): run_workspace_command spawned children with the full,
// unscrubbed process.env. run_node_code's full mode already passed
// scrubSecretsFromEnv(process.env) as the base env to runCommand, but the sibling
// run_workspace_command tool called runCommand with only three arguments — so
// `run_workspace_command {command:"node", args:["-e", ...], confirmDestructive:true}`
// inherited SYNCRONA_STORE_KEY, SN_PASSWORD, etc., trivially bypassing the scrub.
//
// These tests pin the fix:
//   - isSecretEnvKey/scrubSecretsFromEnv now also strip _PASSWD/_PASSPHRASE
//     suffixes, PASSWORD/PASSWD/PASSPHRASE/SECRET/TOKEN/APIKEY/API_KEY/CREDENTIAL
//     substrings, and the well-known AWS credential keys;
//   - run_workspace_command passes a credential-scrubbed base env as the 6th
//     argument to context.runCommand.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  handleWorkspaceTool,
  scrubSecretsFromEnv,
} = require('../dist/handlers/workspaceHandlers.js');

function makeCmdResult(overrides = {}) {
  return {
    exitCode: 0,
    stdout: 'ok',
    stderr: '',
    timedOut: false,
    ...overrides,
  };
}

function makeContext(overrides = {}) {
  return {
    timeoutMs: 1000,
    dryRun: false,
    startedAt: Date.now(),
    allowFullNodeAccess: false,
    runSyncroCliCommand: async () => makeCmdResult(),
    runCommand: async () => makeCmdResult(),
    isUnsafeWorkspaceCommand: () => false,
    makeDryRunAuditResponse: (toolName, args, details) => ({
      isError: false,
      content: [{ type: 'text', text: `DRY_RUN:${toolName}:${JSON.stringify(details)}` }],
    }),
    auditMutatingTool: () => {},
    ...overrides,
  };
}

test('REV-116: scrubSecretsFromEnv strips every newly-covered secret key shape', () => {
  const input = {
    SYNCRONA_STORE_KEY: 'x',
    SN_PASSWORD: 'x',
    MY_PASSWD: 'x',
    DB_PASSPHRASE: 'x',
    PASSWORD: 'x',
    GH_TOKEN: 'x',
    APIKEY: 'x',
    AWS_ACCESS_KEY_ID: 'x',
    PATH: '/bin',
    HOME: '/h',
  };
  const scrubbed = scrubSecretsFromEnv(input);
  // Kept.
  assert.equal(scrubbed.PATH, '/bin');
  assert.equal(scrubbed.HOME, '/h');
  // Stripped.
  for (const key of [
    'SYNCRONA_STORE_KEY',
    'SN_PASSWORD',
    'MY_PASSWD',
    'DB_PASSPHRASE',
    'PASSWORD',
    'GH_TOKEN',
    'APIKEY',
    'AWS_ACCESS_KEY_ID',
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(scrubbed, key),
      false,
      `secret key ${key} must be stripped`
    );
  }
});

test('REV-116: run_workspace_command spawns with a credential-scrubbed base env', async () => {
  const prev = process.env.SYNCRONA_STORE_KEY;
  process.env.SYNCRONA_STORE_KEY = 'secret';
  try {
    let captured = null;
    const ctx = makeContext({
      runCommand: async (command, cmdArgs, timeoutMs, cwd, extraEnv, envBase) => {
        captured = { command, cmdArgs, timeoutMs, cwd, extraEnv, envBase };
        return makeCmdResult();
      },
    });
    const res = await handleWorkspaceTool(
      'run_workspace_command',
      { command: 'node', args: ['-e', '1'], confirmDestructive: true },
      ctx
    );
    assert.equal(res.isError, false);
    assert.ok(captured, 'the command must reach context.runCommand');
    assert.equal(captured.command, 'node');
    assert.deepEqual(captured.cmdArgs, ['-e', '1']);
    assert.ok(
      captured.envBase && typeof captured.envBase === 'object',
      'runCommand must receive a base env as its 6th argument'
    );
    assert.equal(
      Object.prototype.hasOwnProperty.call(captured.envBase, 'SYNCRONA_STORE_KEY'),
      false,
      'the base env must not contain SYNCRONA_STORE_KEY'
    );
  } finally {
    if (prev === undefined) {
      delete process.env.SYNCRONA_STORE_KEY;
    } else {
      process.env.SYNCRONA_STORE_KEY = prev;
    }
  }
});
