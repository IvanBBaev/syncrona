// SPDX-License-Identifier: GPL-3.0-or-later
// REV-82 (SEC-1): run_node_code's vm "sandbox" was a false security boundary.
//
// The former executeSandboxedNodeCode ran caller code in a vm.createContext whose
// only escape hatch (console.log.constructor -> host-realm Function) reached the
// real `process`, giving host RCE, secret exfiltration, and host prototype
// pollution (see docs/ai/repro/sec1-vm-escape.cjs). These tests pin the fix:
//   - safe mode (default, no allowFullNodeAccess) refuses honestly instead of
//     pretending to sandbox — so the exfil payload can no longer print a secret;
//   - full mode (explicit allowFullNodeAccess) runs a real child process and passes
//     --disallow-code-generation-from-strings as the FIRST argument;
//   - the removed isUnsafeWorkspaceCommand("node", ["-e", code]) pre-check no longer
//     gates execution;
//   - scrubSecretsFromEnv exists and strips credential-bearing env keys.
//
// Each assertion below fails against the pre-fix behavior and passes against the fix.
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

// Payloads copied from docs/ai/repro/sec1-vm-escape.cjs — the exact strings that
// escaped the old sandbox.
const EXFIL_PAYLOAD =
  'console.log(console.log.constructor("return process")().env.SN_PASSWORD)';
const RCE_PAYLOAD =
  'console.log(console.log.constructor("return process")().mainModule.require("child_process").execSync("id").toString())';

test('REV-82: safe mode (default) refuses run_node_code instead of faking a sandbox', async () => {
  let ran = false;
  const ctx = makeContext({
    runCommand: async () => {
      ran = true;
      return makeCmdResult();
    },
  });
  const res = await handleWorkspaceTool(
    'run_node_code',
    { code: 'console.log("sandboxed-hello")', confirmDestructive: true },
    ctx
  );
  assert.equal(res.isError, true, 'safe mode must refuse, not execute');
  assert.match(res.content[0].text, /disabled/i);
  assert.match(res.content[0].text, /allowFullNodeAccess/);
  assert.doesNotMatch(res.content[0].text, /sandboxed-hello/, 'code must not have executed');
  assert.equal(ran, false, 'safe mode must not reach the child-process runner');
});

test('REV-82: safe mode cannot exfiltrate a host secret via the old vm escape', async () => {
  const prev = process.env.SN_PASSWORD;
  process.env.SN_PASSWORD = 'REV82-SENTINEL-SECRET';
  try {
    const res = await handleWorkspaceTool(
      'run_node_code',
      { code: EXFIL_PAYLOAD, confirmDestructive: true },
      makeContext()
    );
    assert.equal(res.isError, true);
    // On the old sandbox this printed the secret; the honest refusal never does.
    assert.doesNotMatch(res.content[0].text, /REV82-SENTINEL-SECRET/);
  } finally {
    if (prev === undefined) {
      delete process.env.SN_PASSWORD;
    } else {
      process.env.SN_PASSWORD = prev;
    }
  }
});

test('REV-82: full mode runs a real child process with --disallow-code-generation-from-strings first', async () => {
  let captured = null;
  const ctx = makeContext({
    allowFullNodeAccess: true,
    runCommand: async (command, cmdArgs, timeoutMs) => {
      captured = { command, cmdArgs, timeoutMs };
      return makeCmdResult({ stdout: 'full-mode-ran' });
    },
  });
  const res = await handleWorkspaceTool(
    'run_node_code',
    { code: 'console.log("x")', confirmDestructive: true },
    ctx
  );
  assert.equal(res.isError, false);
  assert.ok(captured, 'full mode must delegate to context.runCommand');
  assert.equal(captured.command, 'node');
  assert.equal(
    captured.cmdArgs[0],
    '--disallow-code-generation-from-strings',
    'hardening flag must be the first argument'
  );
  assert.deepEqual(captured.cmdArgs, [
    '--disallow-code-generation-from-strings',
    '-e',
    'console.log("x")',
  ]);
});

test('REV-82: the isUnsafeWorkspaceCommand("node", ...) pre-check is gone (full mode still runs)', async () => {
  let ran = false;
  const ctx = makeContext({
    allowFullNodeAccess: true,
    // Old code consulted this and blocked when it returned true; the pre-check is
    // deleted, so a true here must no longer block execution.
    isUnsafeWorkspaceCommand: () => true,
    runCommand: async () => {
      ran = true;
      return makeCmdResult({ stdout: 'still-ran' });
    },
  });
  const res = await handleWorkspaceTool(
    'run_node_code',
    { code: RCE_PAYLOAD, confirmDestructive: true },
    ctx
  );
  assert.equal(ran, true, 'the removed pre-check must not gate full-mode execution');
  assert.equal(res.isError, false);
  assert.doesNotMatch(res.content[0].text, /Blocked unsafe command/);
});

test('REV-82: full mode still requires confirmDestructive', async () => {
  let ran = false;
  const ctx = makeContext({
    allowFullNodeAccess: true,
    runCommand: async () => {
      ran = true;
      return makeCmdResult();
    },
  });
  const res = await handleWorkspaceTool('run_node_code', { code: '1+1' }, ctx);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /confirmDestructive=true/);
  assert.equal(ran, false);
});

test('REV-82: scrubSecretsFromEnv strips credential-bearing keys (case-insensitive)', () => {
  assert.equal(typeof scrubSecretsFromEnv, 'function', 'helper must be exported');
  const input = {
    PATH: '/usr/bin',
    HOME: '/home/dev',
    LANG: 'en_US.UTF-8',
    SN_PASSWORD: 'a',
    SN_INSTANCE: 'dev123',
    sn_lowercase: 'b',
    SYNCRONA_STORE_KEY: 'c',
    SYNCRONA_ANYTHING: 'd',
    MY_ACCESS_TOKEN: 'e',
    SOME_SECRET: 'f',
    DB_PASSWORD: 'g',
    API_KEY: 'h',
    aws_secret: 'i',
  };
  const scrubbed = scrubSecretsFromEnv(input);
  // Kept.
  assert.equal(scrubbed.PATH, '/usr/bin');
  assert.equal(scrubbed.HOME, '/home/dev');
  assert.equal(scrubbed.LANG, 'en_US.UTF-8');
  // Stripped.
  for (const key of [
    'SN_PASSWORD',
    'SN_INSTANCE',
    'sn_lowercase',
    'SYNCRONA_STORE_KEY',
    'SYNCRONA_ANYTHING',
    'MY_ACCESS_TOKEN',
    'SOME_SECRET',
    'DB_PASSWORD',
    'API_KEY',
    'aws_secret',
  ]) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(scrubbed, key),
      false,
      `secret key ${key} must be stripped`
    );
  }
});

test('REV-82: scrubSecretsFromEnv defaults to process.env and does not mutate the source', () => {
  const prev = process.env.SN_PASSWORD;
  process.env.SN_PASSWORD = 'do-not-leak';
  try {
    const scrubbed = scrubSecretsFromEnv();
    assert.equal(
      Object.prototype.hasOwnProperty.call(scrubbed, 'SN_PASSWORD'),
      false
    );
    // Source untouched.
    assert.equal(process.env.SN_PASSWORD, 'do-not-leak');
  } finally {
    if (prev === undefined) {
      delete process.env.SN_PASSWORD;
    } else {
      process.env.SN_PASSWORD = prev;
    }
  }
});
