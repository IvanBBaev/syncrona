// SPDX-License-Identifier: GPL-3.0-or-later
// SEC-3 follow-up (REV-149) regression pins.
//
// run_workspace_command and run_node_code destructured `dryRun` from the tool
// context and then never read it: after the unsafe-command / confirmDestructive
// gates they executed unconditionally. Because the `requireDryRun` guardrail is
// enforced by REFUSING any call that does not set dryRun=true, an operator who
// locked these two tools down to "plan only" got the exact inversion of what they
// configured — the only invocation shape the policy still accepted was the one
// that really spawned the process.
//
// These tests fail against that old code (runCommand is invoked) and pass now
// (the handler returns a dry-run audit response and never spawns anything).
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

test('REV-149: run_workspace_command under dryRun plans instead of spawning the process', async () => {
  const spawned = [];
  const audited = [];
  const context = makeContext({
    dryRun: true,
    runCommand: async (command, args) => {
      spawned.push({ command, args });
      return makeCmdResult();
    },
    auditMutatingTool: (toolName) => audited.push(toolName),
  });

  const res = await handleWorkspaceTool(
    'run_workspace_command',
    { command: 'syncrona', args: ['push', '--ci'], confirmDestructive: true },
    context
  );

  assert.deepEqual(spawned, [], 'a dry run must not spawn the child process');
  assert.deepEqual(audited, [], 'nothing was mutated, so no mutation audit entry');
  assert.equal(res.isError, false);
  assert.match(res.content[0].text, /^DRY_RUN:run_workspace_command:/);
  const details = JSON.parse(res.content[0].text.replace('DRY_RUN:run_workspace_command:', ''));
  assert.equal(details.command, 'syncrona');
  assert.deepEqual(details.args, ['push', '--ci']);
  assert.equal(details.confirmDestructive, true);
});

test('REV-149: run_workspace_command without dryRun still executes', async () => {
  const spawned = [];
  const context = makeContext({
    dryRun: false,
    runCommand: async (command, args) => {
      spawned.push({ command, args });
      return makeCmdResult();
    },
  });

  const res = await handleWorkspaceTool(
    'run_workspace_command',
    { command: 'syncrona', args: ['push', '--ci'], confirmDestructive: true },
    context
  );

  assert.equal(spawned.length, 1, 'a real run must still reach the runner');
  assert.equal(res.isError, false);
});

test('REV-149: run_node_code under dryRun plans instead of running Node', async () => {
  const spawned = [];
  const context = makeContext({
    dryRun: true,
    allowFullNodeAccess: true,
    runCommand: async (command, args) => {
      spawned.push({ command, args });
      return makeCmdResult();
    },
  });

  const res = await handleWorkspaceTool(
    'run_node_code',
    { code: 'require("fs").writeFileSync("/tmp/pwned", "x")', confirmDestructive: true },
    context
  );

  assert.deepEqual(spawned, [], 'a dry run must not spawn node');
  assert.equal(res.isError, false);
  assert.match(res.content[0].text, /^DRY_RUN:run_node_code:/);
  const details = JSON.parse(res.content[0].text.replace('DRY_RUN:run_node_code:', ''));
  assert.equal(details.codeLength, 'require("fs").writeFileSync("/tmp/pwned", "x")'.length);
  assert.equal(details.confirmDestructive, true);
});

test('REV-149: a dry run cannot probe whether allowFullNodeAccess is enabled', async () => {
  // The dryRun branch sits AFTER the allowFullNodeAccess gate on purpose: a dry
  // run must not become an oracle for the host-access opt-in.
  const context = makeContext({ dryRun: true, allowFullNodeAccess: false });

  const res = await handleWorkspaceTool(
    'run_node_code',
    { code: 'process.exit(0)', confirmDestructive: true },
    context
  );

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /run_node_code is disabled/);
});

test('REV-149: dryRun does not soften the confirmDestructive gate on run_node_code', async () => {
  const context = makeContext({ dryRun: true, allowFullNodeAccess: true });

  const res = await handleWorkspaceTool('run_node_code', { code: 'process.exit(0)' }, context);

  assert.equal(res.isError, true);
  assert.match(res.content[0].text, /confirmDestructive=true/);
});
