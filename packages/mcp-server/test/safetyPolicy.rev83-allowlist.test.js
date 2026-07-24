// SPDX-License-Identifier: GPL-3.0-or-later
// REV-83 (SEC-2): run_workspace_command's destructive gate was a base-name
// DENYLIST (isDestructiveWorkspaceCommand), so every command not on it — node,
// python3, perl, ruby, php, env, find, xargs, bash, sh, and any other interpreter
// or wrapper — executed unsandboxed with no confirmation. The fix inverts this to
// a default-deny allowlist (requiresConfirmation): anything not on the read-only
// allowlist requires confirmDestructive=true.
//
// These tests pin both the pure policy function and the end-to-end gate. The
// interpreter cases fail against the pre-fix denylist (which let them run ungated)
// and pass against the allowlist.
const test = require('node:test');
const assert = require('node:assert/strict');

const { requiresConfirmation } = require('../dist/safetyPolicy.js');
const { handleWorkspaceTool } = require('../dist/handlers/workspaceHandlers.js');

function makeCmdResult(overrides = {}) {
  return { exitCode: 0, stdout: 'ok', stderr: '', timedOut: false, ...overrides };
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
    makeDryRunAuditResponse: () => ({ isError: false, content: [{ type: 'text', text: 'dry' }] }),
    auditMutatingTool: () => {},
    ...overrides,
  };
}

// --- requiresConfirmation: default-deny for interpreters/wrappers ---

const MUST_CONFIRM = [
  ['node', ['-e', 'console.log(1)']],
  ['python3', ['-c', 'import os']],
  ['python', ['script.py']],
  ['perl', ['-e', '1']],
  ['ruby', ['-e', '1']],
  ['php', ['-r', '1']],
  ['env', ['node', '-e', '1']],
  ['find', ['.', '-exec', 'rm', '{}', ';']],
  ['xargs', ['rm']],
  ['bash', ['-c', 'rm -rf /']],
  ['sh', ['-c', 'echo hi']],
  ['/usr/bin/node', ['-e', '1']],
  ['npm', ['run', 'build']],
  ['npx', ['some-cli']],
];

for (const [command, args] of MUST_CONFIRM) {
  test(`REV-83: requiresConfirmation gates "${command}" (not on the read-only allowlist)`, () => {
    assert.equal(requiresConfirmation(command, args), true);
  });
}

// --- requiresConfirmation: allowlisted read-only commands do NOT require confirmation ---

const NO_CONFIRM = [
  ['git', ['status']],
  ['git', ['log', '--oneline']],
  ['git', ['diff']],
  ['git', ['show', 'HEAD']],
  ['ls', ['-la']],
  ['cat', ['README.md']],
  ['pwd', []],
  ['echo', ['syncrona push']], // a literal argument is not a subcommand
  ['syncrona', ['status']],
  ['syncrona', ['doctor']],
  ['syncrona', ['refresh']],
];

for (const [command, args] of NO_CONFIRM) {
  test(`REV-83: requiresConfirmation allows read-only "${command} ${args.join(' ')}"`, () => {
    assert.equal(requiresConfirmation(command, args), false);
  });
}

// --- requiresConfirmation: mutating subcommands of allowlisted binaries ---

const MUTATING_GIT = ['push', 'reset', 'clean', 'checkout', 'commit', 'rebase', 'merge', 'restore'];
for (const sub of MUTATING_GIT) {
  test(`REV-83: requiresConfirmation gates "git ${sub}"`, () => {
    assert.equal(requiresConfirmation('git', [sub]), true);
  });
}

const DESTRUCTIVE_SYNCRONA = ['push', 'deploy', 'download'];
for (const sub of DESTRUCTIVE_SYNCRONA) {
  test(`REV-83: requiresConfirmation gates "syncrona ${sub}"`, () => {
    assert.equal(requiresConfirmation('syncrona', [sub]), true);
  });
}

// --- end-to-end: the run_workspace_command gate now blocks interpreters ---

test('REV-83: run_workspace_command blocks "node -e" without confirmDestructive', async () => {
  let ran = false;
  const ctx = makeContext({
    runCommand: async () => {
      ran = true;
      return makeCmdResult();
    },
  });
  const res = await handleWorkspaceTool(
    'run_workspace_command',
    { command: 'node', args: ['-e', 'require("child_process").execSync("id")'] },
    ctx
  );
  assert.equal(res.isError, true, 'interpreter must be gated (old denylist let it run)');
  assert.match(res.content[0].text, /may modify instance state/);
  assert.equal(ran, false, 'the command must not execute ungated');
});

test('REV-83: run_workspace_command blocks "python3 -c" without confirmDestructive', async () => {
  let ran = false;
  const ctx = makeContext({
    runCommand: async () => {
      ran = true;
      return makeCmdResult();
    },
  });
  const res = await handleWorkspaceTool(
    'run_workspace_command',
    { command: 'python3', args: ['-c', 'import os; os.system("id")'] },
    ctx
  );
  assert.equal(res.isError, true);
  assert.equal(ran, false);
});

test('REV-83: run_workspace_command runs an interpreter once confirmDestructive=true', async () => {
  let ran = false;
  const ctx = makeContext({
    runCommand: async () => {
      ran = true;
      return makeCmdResult({ stdout: 'ran' });
    },
  });
  const res = await handleWorkspaceTool(
    'run_workspace_command',
    { command: 'node', args: ['-e', '1'], confirmDestructive: true },
    ctx
  );
  assert.equal(res.isError, false);
  assert.equal(ran, true, 'explicit confirmation must allow execution');
});

test('REV-83: run_workspace_command still allows a read-only allowlisted command ungated', async () => {
  let ran = false;
  const ctx = makeContext({
    runCommand: async () => {
      ran = true;
      return makeCmdResult({ stdout: 'clean' });
    },
  });
  const res = await handleWorkspaceTool(
    'run_workspace_command',
    { command: 'git', args: ['status'] },
    ctx
  );
  assert.equal(res.isError, false);
  assert.equal(ran, true);
});
