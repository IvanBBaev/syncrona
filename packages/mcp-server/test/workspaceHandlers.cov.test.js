// SPDX-License-Identifier: GPL-3.0-or-later
const test = require('node:test');
const assert = require('node:assert/strict');

const { handleWorkspaceTool } = require('../dist/handlers/workspaceHandlers.js');

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

test('unknown tool returns null so dispatch can fall through', async () => {
  const res = await handleWorkspaceTool('not_a_real_tool', {}, makeContext());
  assert.equal(res, null);
});

// --- sync_status ---

test('sync_status: happy path uses default logLevel and reports success', async () => {
  let captured = null;
  const ctx = makeContext({
    runSyncroCliCommand: async (subcommand, args, timeoutMs) => {
      captured = { subcommand, args, timeoutMs };
      return makeCmdResult({ exitCode: 0, stdout: 'status ok' });
    },
  });
  const res = await handleWorkspaceTool('sync_status', {}, ctx);
  assert.equal(res.isError, false);
  assert.deepEqual(captured, { subcommand: 'status', args: ['--logLevel', 'info'], timeoutMs: 1000 });
  assert.match(res.content[0].text, /status ok/);
});

test('sync_status: honors custom logLevel and surfaces non-zero exit as error', async () => {
  let captured = null;
  const ctx = makeContext({
    runSyncroCliCommand: async (subcommand, args) => {
      captured = args;
      return makeCmdResult({ exitCode: 2, stderr: 'boom' });
    },
  });
  const res = await handleWorkspaceTool('sync_status', { logLevel: 'debug' }, ctx);
  assert.equal(res.isError, true);
  assert.deepEqual(captured, ['--logLevel', 'debug']);
  assert.match(res.content[0].text, /boom/);
});

// --- sync_refresh ---

test('sync_refresh: happy path with default logLevel', async () => {
  let captured = null;
  const ctx = makeContext({
    runSyncroCliCommand: async (subcommand, args) => {
      captured = { subcommand, args };
      return makeCmdResult({ exitCode: 0 });
    },
  });
  const res = await handleWorkspaceTool('sync_refresh', {}, ctx);
  assert.equal(res.isError, false);
  assert.deepEqual(captured, { subcommand: 'refresh', args: ['--logLevel', 'info'] });
});

test('sync_refresh: non-string logLevel falls back to info', async () => {
  let captured = null;
  const ctx = makeContext({
    runSyncroCliCommand: async (subcommand, args) => {
      captured = args;
      return makeCmdResult();
    },
  });
  await handleWorkspaceTool('sync_refresh', { logLevel: 42 }, ctx);
  assert.deepEqual(captured, ['--logLevel', 'info']);
});

// --- sync_build ---

test('sync_build: without diff omits --diff flag', async () => {
  let captured = null;
  const ctx = makeContext({
    runSyncroCliCommand: async (subcommand, args) => {
      captured = { subcommand, args };
      return makeCmdResult();
    },
  });
  const res = await handleWorkspaceTool('sync_build', {}, ctx);
  assert.equal(res.isError, false);
  assert.deepEqual(captured, { subcommand: 'build', args: ['--logLevel', 'info'] });
});

test('sync_build: with diff appends --diff flag, trims whitespace', async () => {
  let captured = null;
  const ctx = makeContext({
    runSyncroCliCommand: async (subcommand, args) => {
      captured = args;
      return makeCmdResult();
    },
  });
  await handleWorkspaceTool('sync_build', { logLevel: 'warn', diff: '  HEAD~1  ' }, ctx);
  assert.deepEqual(captured, ['--logLevel', 'warn', '--diff', 'HEAD~1']);
});

test('sync_build: blank diff string is treated as absent', async () => {
  let captured = null;
  const ctx = makeContext({
    runSyncroCliCommand: async (subcommand, args) => {
      captured = args;
      return makeCmdResult();
    },
  });
  await handleWorkspaceTool('sync_build', { diff: '   ' }, ctx);
  assert.deepEqual(captured, ['--logLevel', 'info']);
});

// --- sync_push ---

test('sync_push: without confirmDestructive is rejected and does not run command', async () => {
  let called = false;
  const ctx = makeContext({
    runSyncroCliCommand: async () => {
      called = true;
      return makeCmdResult();
    },
  });
  const res = await handleWorkspaceTool('sync_push', {}, ctx);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /confirmDestructive=true/);
  assert.equal(called, false);
});

test('sync_push: dryRun true returns audit response without running the command', async () => {
  let called = false;
  let auditArgs = null;
  const ctx = makeContext({
    dryRun: true,
    runSyncroCliCommand: async () => {
      called = true;
      return makeCmdResult();
    },
    makeDryRunAuditResponse: (toolName, args, details) => {
      auditArgs = { toolName, args, details };
      return { isError: false, content: [{ type: 'text', text: 'dry-run-ok' }] };
    },
  });
  const res = await handleWorkspaceTool(
    'sync_push',
    { confirmDestructive: true, target: '  incident  ', diff: ' d1 ', updateSet: ' us1 ', scopeSwap: true },
    ctx
  );
  assert.equal(called, false);
  assert.equal(res.content[0].text, 'dry-run-ok');
  assert.equal(auditArgs.toolName, 'sync_push');
  assert.deepEqual(auditArgs.details, {
    target: 'incident',
    diff: 'd1',
    updateSet: 'us1',
    scopeSwap: true,
  });
});

test('sync_push: full happy path builds all cli flags and audits mutation', async () => {
  let captured = null;
  let auditCall = null;
  const ctx = makeContext({
    runSyncroCliCommand: async (subcommand, args) => {
      captured = { subcommand, args };
      return makeCmdResult({ exitCode: 0 });
    },
    auditMutatingTool: (toolName, args, outcome, durationMs) => {
      auditCall = { toolName, outcome, durationMs };
    },
  });
  const res = await handleWorkspaceTool(
    'sync_push',
    {
      confirmDestructive: true,
      logLevel: 'trace',
      target: 'x_app_util',
      diff: 'main..HEAD',
      updateSet: 'US001',
      scopeSwap: true,
    },
    ctx
  );
  assert.equal(res.isError, false);
  assert.deepEqual(captured, {
    subcommand: 'push',
    args: [
      '--ci',
      '--logLevel',
      'trace',
      'x_app_util',
      '--diff',
      'main..HEAD',
      '--scopeSwap',
      '--updateSet',
      'US001',
    ],
  });
  assert.equal(auditCall.toolName, 'sync_push');
  assert.deepEqual(auditCall.outcome, { exitCode: 0, timedOut: false });
  assert.equal(typeof auditCall.durationMs, 'number');
});

test('sync_push: minimal confirmed push omits optional flags and reports failure exit code', async () => {
  let captured = null;
  const ctx = makeContext({
    runSyncroCliCommand: async (subcommand, args) => {
      captured = args;
      return makeCmdResult({ exitCode: 1, stderr: 'push failed' });
    },
  });
  const res = await handleWorkspaceTool('sync_push', { confirmDestructive: true }, ctx);
  assert.equal(res.isError, true);
  assert.deepEqual(captured, ['--ci', '--logLevel', 'info']);
});

// --- run_workspace_command ---

test('run_workspace_command: missing command is rejected', async () => {
  const res = await handleWorkspaceTool('run_workspace_command', {}, makeContext());
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Missing required field: command/);
});

test('run_workspace_command: blank command string is rejected', async () => {
  const res = await handleWorkspaceTool('run_workspace_command', { command: '   ' }, makeContext());
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Missing required field: command/);
});

test('run_workspace_command: unsafe command is blocked before execution', async () => {
  let called = false;
  const ctx = makeContext({
    isUnsafeWorkspaceCommand: () => true,
    runCommand: async () => {
      called = true;
      return makeCmdResult();
    },
  });
  const res = await handleWorkspaceTool('run_workspace_command', { command: 'bash', args: ['-c', 'echo hi'] }, ctx);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Blocked unsafe command/);
  assert.equal(called, false);
});

test('run_workspace_command: non-array args field is treated as empty args', async () => {
  let capturedArgs = null;
  const ctx = makeContext({
    runCommand: async (command, cmdArgs) => {
      capturedArgs = cmdArgs;
      return makeCmdResult();
    },
  });
  await handleWorkspaceTool('run_workspace_command', { command: 'echo', args: 'not-an-array' }, ctx);
  assert.deepEqual(capturedArgs, []);
});

test('run_workspace_command: non-string entries in args array are filtered out', async () => {
  let capturedArgs = null;
  const ctx = makeContext({
    runCommand: async (command, cmdArgs) => {
      capturedArgs = cmdArgs;
      return makeCmdResult();
    },
  });
  await handleWorkspaceTool('run_workspace_command', { command: 'echo', args: ['a', 1, null, 'b', {}] }, ctx);
  assert.deepEqual(capturedArgs, ['a', 'b']);
});

test('run_workspace_command: seemingly destructive command without confirmDestructive is rejected', async () => {
  let called = false;
  const ctx = makeContext({
    runCommand: async () => {
      called = true;
      return makeCmdResult();
    },
  });
  const res = await handleWorkspaceTool(
    'run_workspace_command',
    { command: 'npx', args: ['syncrona', 'sync', 'push'] },
    ctx
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /may modify instance state/);
  assert.equal(called, false);
});

test('run_workspace_command: destructive command with confirmDestructive=true is allowed to run', async () => {
  let captured = null;
  const ctx = makeContext({
    runCommand: async (command, cmdArgs, timeoutMs) => {
      captured = { command, cmdArgs, timeoutMs };
      return makeCmdResult({ exitCode: 0, stdout: 'pushed' });
    },
  });
  const res = await handleWorkspaceTool(
    'run_workspace_command',
    { command: 'npx', args: ['syncrona', 'sync', 'deploy'], confirmDestructive: true },
    ctx
  );
  assert.equal(res.isError, false);
  assert.deepEqual(captured, { command: 'npx', cmdArgs: ['syncrona', 'sync', 'deploy'], timeoutMs: 1000 });
});

test('run_workspace_command: "sync download" phrase is treated as destructive', async () => {
  const ctx = makeContext({
    runCommand: async () => makeCmdResult(),
  });
  const res = await handleWorkspaceTool(
    'run_workspace_command',
    { command: 'sync', args: ['download'] },
    ctx
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /may modify instance state/);
});

test('run_workspace_command: safe command with real process execution succeeds', async () => {
  const { spawnSync } = require('node:child_process');
  const ctx = makeContext({
    runCommand: async (command, cmdArgs, timeoutMs) => {
      const res = spawnSync(command, cmdArgs, { timeout: timeoutMs, encoding: 'utf8' });
      return {
        exitCode: res.status === null ? 1 : res.status,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
        timedOut: !!res.error && res.error.code === 'ETIMEDOUT',
      };
    },
  });
  const res = await handleWorkspaceTool(
    'run_workspace_command',
    { command: process.execPath, args: ['-e', 'console.log("hello-from-real-process")'] },
    ctx
  );
  assert.equal(res.isError, false);
  assert.match(res.content[0].text, /hello-from-real-process/);
});

test('run_workspace_command: non-zero exit from runCommand is surfaced as error', async () => {
  const ctx = makeContext({
    runCommand: async () => makeCmdResult({ exitCode: 1, stderr: 'failure' }),
  });
  const res = await handleWorkspaceTool('run_workspace_command', { command: 'false' }, ctx);
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /failure/);
});

// --- run_node_code ---

test('run_node_code: missing code is rejected', async () => {
  const res = await handleWorkspaceTool('run_node_code', {}, makeContext());
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Missing required field: code/);
});

test('run_node_code: blank code is rejected', async () => {
  const res = await handleWorkspaceTool('run_node_code', { code: '   \n  ' }, makeContext());
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Missing required field: code/);
});

test('run_node_code: without confirmDestructive is rejected', async () => {
  const res = await handleWorkspaceTool('run_node_code', { code: '1+1' }, makeContext());
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /confirmDestructive=true/);
});

test('run_node_code: unsafe command guard blocks execution even when confirmed', async () => {
  let capturedCall = null;
  const ctx = makeContext({
    isUnsafeWorkspaceCommand: (cmd, cmdArgs) => {
      capturedCall = { cmd, cmdArgs };
      return true;
    },
  });
  const res = await handleWorkspaceTool(
    'run_node_code',
    { code: 'console.log(1)', confirmDestructive: true },
    ctx
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Blocked unsafe command/);
  assert.deepEqual(capturedCall, { cmd: 'node', cmdArgs: ['-e', 'console.log(1)'] });
});

test('run_node_code: sandboxed execution (default, no allowFullNodeAccess) runs console.log output', async () => {
  const ctx = makeContext();
  const res = await handleWorkspaceTool(
    'run_node_code',
    { code: 'console.log("sandboxed-hello")', confirmDestructive: true },
    ctx
  );
  assert.equal(res.isError, false);
  assert.match(res.content[0].text, /sandboxed-hello/);
});

test('run_node_code: sandboxed execution captures console.warn/error into stderr and non-zero handling', async () => {
  const ctx = makeContext();
  const res = await handleWorkspaceTool(
    'run_node_code',
    { code: 'console.warn("careful"); console.error("bad"); throw new Error("kaboom");', confirmDestructive: true },
    ctx
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /kaboom/);
});

test('run_node_code: sandboxed execution rejects returning a promise (async result unsupported)', async () => {
  const ctx = makeContext();
  const res = await handleWorkspaceTool(
    'run_node_code',
    { code: 'Promise.resolve(42)', confirmDestructive: true },
    ctx
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /Async results are not supported/);
});

test('run_node_code: sandboxed execution times out on an infinite loop', async () => {
  const ctx = makeContext({ timeoutMs: 100 });
  const res = await handleWorkspaceTool(
    'run_node_code',
    { code: 'while (true) {}', confirmDestructive: true },
    ctx
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /timedOut: true/);
  assert.match(res.content[0].text, /Sandboxed code execution timed out/);
});

test('run_node_code: sandboxed execution cannot reach process/require (no host access)', async () => {
  const ctx = makeContext();
  const res = await handleWorkspaceTool(
    'run_node_code',
    { code: 'console.log(typeof process, typeof require)', confirmDestructive: true },
    ctx
  );
  assert.equal(res.isError, false);
  assert.match(res.content[0].text, /undefined undefined/);
});

test('run_node_code: sandboxed console.info stringifies non-string values, including circular-reference fallback', async () => {
  const ctx = makeContext();
  const res = await handleWorkspaceTool(
    'run_node_code',
    {
      code:
        'console.info(42, {a:1}); ' +
        'const c = {}; c.self = c; console.info(c);',
      confirmDestructive: true,
    },
    ctx
  );
  assert.equal(res.isError, false);
  assert.match(res.content[0].text, /42 \{"a":1\}/);
  assert.match(res.content[0].text, /\[object Object\]/);
});

test('run_node_code: allowFullNodeAccess=true delegates to context.runCommand with real process', async () => {
  const { spawnSync } = require('node:child_process');
  let capturedCall = null;
  const ctx = makeContext({
    allowFullNodeAccess: true,
    runCommand: async (command, cmdArgs, timeoutMs) => {
      capturedCall = { command, cmdArgs };
      const res = spawnSync(command, cmdArgs, { timeout: timeoutMs, encoding: 'utf8' });
      return {
        exitCode: res.status === null ? 1 : res.status,
        stdout: res.stdout || '',
        stderr: res.stderr || '',
        timedOut: false,
      };
    },
  });
  const res = await handleWorkspaceTool(
    'run_node_code',
    { code: 'console.log("full-access-real-process")', confirmDestructive: true },
    ctx
  );
  assert.equal(res.isError, false);
  assert.equal(capturedCall.command, 'node');
  assert.deepEqual(capturedCall.cmdArgs, ['-e', 'console.log("full-access-real-process")']);
  assert.match(res.content[0].text, /full-access-real-process/);
});
