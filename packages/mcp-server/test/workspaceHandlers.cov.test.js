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

test('run_workspace_command: destructive command without confirmDestructive is rejected', async () => {
  let called = false;
  const ctx = makeContext({
    runCommand: async () => {
      called = true;
      return makeCmdResult();
    },
  });
  const res = await handleWorkspaceTool(
    'run_workspace_command',
    { command: 'npx', args: ['syncrona', 'push', '--ci'] },
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
    { command: 'npx', args: ['syncrona', 'deploy'], confirmDestructive: true },
    ctx
  );
  assert.equal(res.isError, false);
  assert.deepEqual(captured, { command: 'npx', cmdArgs: ['syncrona', 'deploy'], timeoutMs: 1000 });
});

test('run_workspace_command: bare "syncrona download" is treated as destructive', async () => {
  const ctx = makeContext({
    runCommand: async () => makeCmdResult(),
  });
  const res = await handleWorkspaceTool(
    'run_workspace_command',
    { command: 'syncrona', args: ['download'] },
    ctx
  );
  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /may modify instance state/);
});

// --- run_workspace_command: mutation audit ---
// A confirmed destructive invocation reaches the instance exactly like sync_push
// and must leave the same audit trail; the handler previously executed it with no
// auditMutatingTool call at all.

test('run_workspace_command: a confirmed destructive invocation is audited as a mutation', async () => {
  const audited = [];
  const ctx = makeContext({
    startedAt: Date.now() - 25,
    runCommand: async () => makeCmdResult({ exitCode: 0, stdout: 'pushed' }),
    auditMutatingTool: (toolName, args, outcome, durationMs) => {
      audited.push({ toolName, args, outcome, durationMs });
    },
  });
  const args = { command: 'npx', args: ['syncrona', 'push', '--ci'], confirmDestructive: true };
  const res = await handleWorkspaceTool('run_workspace_command', args, ctx);

  assert.equal(res.isError, false);
  assert.equal(audited.length, 1, 'destructive invocation must produce exactly one audit call');
  assert.equal(audited[0].toolName, 'run_workspace_command');
  assert.deepEqual(audited[0].args, args);
  assert.deepEqual(audited[0].outcome, { exitCode: 0, timedOut: false });
  assert.ok(audited[0].durationMs >= 25, 'duration is measured from startedAt');
});

test('run_workspace_command: a failed destructive invocation still reports its real outcome', async () => {
  const audited = [];
  const ctx = makeContext({
    runCommand: async () => makeCmdResult({ exitCode: 1, timedOut: true, stderr: 'boom' }),
    auditMutatingTool: (toolName, args, outcome, durationMs) => {
      audited.push({ toolName, args, outcome, durationMs });
    },
  });
  const res = await handleWorkspaceTool(
    'run_workspace_command',
    { command: 'syncrona', args: ['deploy'], confirmDestructive: true },
    ctx
  );

  assert.equal(res.isError, true);
  assert.equal(audited.length, 1);
  assert.deepEqual(audited[0].outcome, { exitCode: 1, timedOut: true });
});

test('run_workspace_command: a destructive invocation blocked by the gate is not audited', async () => {
  const audited = [];
  const ctx = makeContext({
    auditMutatingTool: (toolName) => audited.push(toolName),
  });
  const res = await handleWorkspaceTool(
    'run_workspace_command',
    { command: 'syncrona', args: ['push'] },
    ctx
  );

  assert.equal(res.isError, true);
  assert.deepEqual(audited, [], 'a command that never ran must not be audited as a mutation');
});

// --- run_workspace_command: destructive gate parses the invocation structurally ---
// The gate previously substring-matched "sync push"/"sync deploy"/"sync download",
// which never occurs in a real invocation of the `syncrona` binary, so every form
// below executed ungated.

const REAL_DESTRUCTIVE_INVOCATIONS = [
  ['npx', ['syncrona', 'push', '--ci']],
  ['npx', ['-y', 'syncrona', 'push']],
  ['npx', ['--package', 'syncrona', 'syncrona', 'deploy']],
  ['npx', ['syncrona@latest', 'download']],
  ['syncrona', ['push']],
  ['syncrona', ['deploy', '--scopeSwap']],
  ['/usr/local/bin/syncrona', ['download']],
  ['syncrona.cmd', ['push']],
  ['pnpm', ['dlx', 'syncrona', 'push']],
  ['yarn', ['dlx', 'syncrona', 'deploy']],
  ['npm', ['exec', 'syncrona', '--', 'download']],
];

for (const [command, args] of REAL_DESTRUCTIVE_INVOCATIONS) {
  test(`run_workspace_command: gates real invocation "${command} ${args.join(' ')}"`, async () => {
    let called = false;
    const ctx = makeContext({
      runCommand: async () => {
        called = true;
        return makeCmdResult();
      },
    });
    const res = await handleWorkspaceTool('run_workspace_command', { command, args }, ctx);
    assert.equal(res.isError, true, 'destructive invocation must be gated');
    assert.match(res.content[0].text, /may modify instance state/);
    assert.equal(called, false, 'destructive invocation must not execute ungated');
  });
}

// REV-83 (SEC-2): default-deny. Any base name not on the read-only allowlist
// (npx/npm wrappers, node, an arbitrary CLI) requires confirmDestructive, as does
// an allowlisted command running a mutating subcommand (git push). None of these
// is a syncrona push/deploy/download, yet each is gated by the allowlist policy —
// the old base-name denylist silently ran every one of them ungated.
const DEFAULT_DENY_INVOCATIONS = [
  ['npx', ['syncrona', 'status']],
  ['npx', ['syncrona', 'build']],
  ['npx', ['some-other-cli', 'push']],
  ['git', ['push']],
  ['npm', ['run', 'build']],
  ['node', ['-e', 'console.log(1)']],
];

for (const [command, args] of DEFAULT_DENY_INVOCATIONS) {
  test(`run_workspace_command: default-deny gates "${command} ${args.join(' ')}"`, async () => {
    let called = false;
    const ctx = makeContext({
      runCommand: async () => {
        called = true;
        return makeCmdResult();
      },
    });
    const res = await handleWorkspaceTool('run_workspace_command', { command, args }, ctx);
    assert.equal(res.isError, true, 'non-allowlisted command must be gated');
    assert.match(res.content[0].text, /may modify instance state/);
    assert.equal(called, false, 'gated command must not execute without confirmDestructive');
  });
}

// Genuinely read-only, allowlisted commands (and allowlisted commands running a
// read-only subcommand) run without confirmDestructive.
const NON_DESTRUCTIVE_INVOCATIONS = [
  ['syncrona', ['doctor']],
  ['echo', ['syncrona push']],
  ['git', ['status']],
  ['ls', ['-la']],
  ['cat', ['README.md']],
  ['pwd', []],
];

for (const [command, args] of NON_DESTRUCTIVE_INVOCATIONS) {
  test(`run_workspace_command: does not gate "${command} ${args.join(' ')}"`, async () => {
    let called = false;
    const ctx = makeContext({
      runCommand: async () => {
        called = true;
        return makeCmdResult();
      },
    });
    const res = await handleWorkspaceTool('run_workspace_command', { command, args }, ctx);
    assert.equal(res.isError, false);
    assert.equal(called, true, 'non-destructive invocation must run without confirmDestructive');
  });
}

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
  // `node` is not on the read-only allowlist, so SEC-2 requires confirmDestructive;
  // with it, the invocation reaches the real runCommand and executes.
  const res = await handleWorkspaceTool(
    'run_workspace_command',
    {
      command: process.execPath,
      args: ['-e', 'console.log("hello-from-real-process")'],
      confirmDestructive: true,
    },
    ctx
  );
  assert.equal(res.isError, false);
  assert.match(res.content[0].text, /hello-from-real-process/);
});

test('run_workspace_command: non-zero exit from runCommand is surfaced as error', async () => {
  const ctx = makeContext({
    runCommand: async () => makeCmdResult({ exitCode: 1, stderr: 'failure' }),
  });
  // `false` is not allowlisted; confirmDestructive lets it through the SEC-2 gate
  // so the non-zero exit from runCommand is what surfaces (not the gate message).
  const res = await handleWorkspaceTool(
    'run_workspace_command',
    { command: 'false', confirmDestructive: true },
    ctx
  );
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

// REV-82 (SEC-1): the former in-process "sandbox" tests (default-mode console
// capture, promise rejection, infinite-loop timeout, process/require isolation,
// circular-reference stringify, and the isUnsafeWorkspaceCommand("node", ...)
// pre-check) asserted the behaviour of a vm.createContext boundary that has been
// removed — it was never a real boundary (host RCE via console.log.constructor).
// Safe mode now refuses honestly and full mode runs a real subprocess; that
// contract is covered by the "REV-82:" suite in index.test.js. Only the full-mode
// delegation test survives here, updated for the subprocess model.

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
  assert.deepEqual(capturedCall.cmdArgs, [
    '--disallow-code-generation-from-strings',
    '-e',
    'console.log("full-access-real-process")',
  ]);
  assert.match(res.content[0].text, /full-access-real-process/);
});
