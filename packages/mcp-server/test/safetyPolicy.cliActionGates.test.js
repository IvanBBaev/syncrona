// SPDX-License-Identifier: GPL-3.0-or-later
//
// Action-aware confirmation gate for CLI subcommands reached through
// run_workspace_command.
//
// The gate used to recognize exactly push/deploy/download, so `syncrona cicd
// rollback`, `syncrona fluent install`, `syncrona init --new` and `syncrona repair
// --apply --prune` all changed the instance (or deleted workspace files) with no
// confirmDestructive and no mutation audit record — bypassing the confirmation
// sync_cicd_run demands for the same API. Each writing form is pinned here next to
// its read-only counterpart, through both requiresConfirmation (the gate) and
// isMutatingTool (the audit decision).
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  requiresConfirmation,
  isDestructiveWorkspaceCommand,
  isMutatingTool,
} = require('../dist/safetyPolicy.js');

/**
 * Asserts the gate and the audit agree on one invocation. A runner (`npx`, `npm`)
 * is not on the read-only allowlist and always confirms, so for those only the
 * CLI recognizer and the audit decision are meaningful.
 */
function assertGate(command, args, expected) {
  const label = `${command} ${args.join(' ')}`;
  if (command === 'syncrona') {
    assert.equal(requiresConfirmation(command, args), expected, `${label}: requiresConfirmation`);
  } else {
    assert.equal(requiresConfirmation(command, args), true, `${label}: runners always confirm`);
  }
  assert.equal(isDestructiveWorkspaceCommand(command, args), expected, `${label}: destructive`);
  assert.equal(
    isMutatingTool('run_workspace_command', { command, args }),
    expected,
    `${label}: isMutatingTool`
  );
}

const WRITING = [
  ['cicd', 'run-suite', '--suite-name', 'Smoke tests'],
  ['cicd', 'run-test', '--test-id', 'abc'],
  ['cicd', 'install', '--scope', 'x_acme_app', '--app-version', '1.2.0'],
  ['cicd', 'publish', '--scope', 'x_acme_app', '--app-version', '1.3.0'],
  ['cicd', 'rollback', '--scope', 'x_acme_app', '--app-version', '1.2.0'],
  // A resume only polls, but it is still the cicd verb; over-confirming is the safe side.
  ['cicd', 'install', '--progress-id', 'abc'],
  ['fluent', 'install', '--ci'],
  ['fluent', 'install', '--reinstall'],
  ['fluent', 'move-to-app', '--ids', 'a,b'],
  ['fluent', 'build'],
  ['fluent', 'pack'],
  ['fluent', 'transform', '--paths', 'src'],
  ['fluent', 'init', '--name', 'App', '--scope', 'x_acme_app'],
  ['fluent', 'run', '--script', 'build'],
  ['fluent', 'dependencies', '--table', 'sys_script', '--scope', 'x_acme_app'],
  ['fluent', 'types', '--native', '--out', 'types/x.d.ts'],
  ['fluent', 'types', '--out=types/x.d.ts'],
  ['init', '--new', '--name', 'Asset Tracker'],
  ['init', '--new=true'],
  ['--new', 'init'],
  ['repair', '--apply'],
  ['repair', '--apply', '--prune', '--ci'],
  ['repair', '--apply=true'],
  ['dev'],
  ['dev', '--refresh-interval', '30'],
  ['refresh'],
  ['refresh', '--logLevel', 'debug'],
];

const READ_ONLY = [
  ['fluent', 'status'],
  ['fluent', 'explain', 'table'],
  ['fluent', 'explain', '--list'],
  ['fluent', 'types'],
  ['fluent', 'types', '--native'],
  ['fluent', 'types', '--scripts', '--fluent'],
  ['init'],
  ['init', '--ci'],
  ['init', '--no-new'],
  ['repair'],
  ['repair', '--prune'],
  ['repair', '--no-apply'],
  ['query', 'incident', '--limit', '5'],
  ['status'],
  ['doctor'],
  // Local-only writers, deliberately outside the gate.
  ['mirror', 'status'],
  ['docs'],
];

test('every instance- or workspace-writing CLI form confirms and is audited', () => {
  for (const args of WRITING) {
    assertGate('syncrona', args, true);
    assertGate('npx', ['-y', 'syncrona', ...args], true);
    assertGate('npm', ['exec', 'syncrona', '--', ...args], true);
  }
});

test('every read-only counterpart runs unconfirmed and unaudited', () => {
  for (const args of READ_ONLY) {
    assertGate('syncrona', args, false);
    assertGate('npx', ['syncrona', ...args], false);
  }
});

test('a --dry-run form confirms exactly as push --dry-run does', () => {
  assertGate('syncrona', ['push', '--dry-run'], true);
  for (const args of [
    ['cicd', 'rollback', '--dry-run'],
    ['fluent', 'install', '--dry-run'],
    ['fluent', 'build', '--dry-run'],
    ['init', '--new', '--dry-run'],
    ['repair', '--apply', '--dry-run'],
  ]) {
    assertGate('syncrona', args, true);
  }
});

test('a global option value before the subcommand cannot hide it', () => {
  assertGate('syncrona', ['--logLevel', 'debug', 'cicd', 'rollback'], true);
  assertGate('syncrona', ['--instance-profile', 'dev', 'init', '--new'], true);
  assertGate('syncrona', ['-d', 'main', 'repair', '--apply'], true);
  assertGate('syncrona', ['--logLevel', 'debug', 'fluent', 'install'], true);
  assertGate('syncrona', ['--logLevel', 'debug', 'fluent', 'status'], false);
});

test('the fluent action is read from the position yargs binds it to', () => {
  // An option between `fluent` and the action takes that position, so a read-only
  // word after it may be the option's value: `--scope status install` runs install.
  assertGate('syncrona', ['fluent', '--scope', 'status', 'install'], true);
  assertGate('syncrona', ['fluent', '--json', 'status'], true);
  assertGate('syncrona', ['fluent', '--', 'status'], true);
  // A missing action confirms (default-deny), and so does an unknown one.
  assertGate('syncrona', ['fluent'], true);
  assertGate('syncrona', ['fluent', 'future-action'], true);
  // A read-only action whose free-form topic names a writer stays read-only.
  assertGate('syncrona', ['fluent', 'explain', 'install'], false);
  // Every `fluent` operand is checked, so a value spelled `fluent` cannot shadow it.
  assertGate('syncrona', ['--instance-profile', 'fluent', 'fluent', 'install'], true);
  // `--fluent` is a types flag, not the fluent command.
  assertGate('syncrona', ['fluent', 'types', '--fluent'], false);
});
