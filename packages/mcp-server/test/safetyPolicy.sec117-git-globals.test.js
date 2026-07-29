// SPDX-License-Identifier: GPL-3.0-or-later
// SEC-2 (REV-117): git global options take space-separated *values*
// (`git -C <path> reset`, `git -c a=b commit`, `git --git-dir <dir> push`).
// firstOperand() returned that value token as the "subcommand", so a mutating
// verb hidden behind a global option (`git -C /repo reset --hard`) slipped past
// the confirmation gate. requiresConfirmation now resolves the real subcommand
// via a git-aware scanner (gitSubcommand) that skips each global option and the
// value token it consumes.
//
// Also pins maxRiskLevel (SEC-7, REV-122): composing a caller-supplied risk
// level with the analyzer-computed one must always take the HIGHER.
const test = require('node:test');
const assert = require('node:assert/strict');

const { requiresConfirmation, maxRiskLevel } = require('../dist/safetyPolicy.js');

// --- requiresConfirmation: mutating verbs behind git global options are gated ---

const MUST_CONFIRM = [
  ['git', ['-C', '/repo', 'reset', '--hard']],
  ['git', ['-c', 'user.name=x', 'commit', '-m', 'y']],
  ['git', ['--git-dir', '/repo/.git', 'push']],
];

for (const [command, args] of MUST_CONFIRM) {
  test(`REV-117: requiresConfirmation gates "${command} ${args.join(' ')}"`, () => {
    assert.equal(requiresConfirmation(command, args), true);
  });
}

// --- requiresConfirmation: read-only verbs stay ungated, with or without a global option ---

test('REV-117: requiresConfirmation allows read-only "git status"', () => {
  assert.equal(requiresConfirmation('git', ['status']), false);
});

// REV-194 inverted this case. REV-117's point was that a mutating verb must not hide
// behind a global option; it asserted `-C … status` stays open as the read-only
// counterpart. The redirect itself turned out to be the vector: run_workspace_command
// has no cwd input, so `-C <dir>` is the only way to make git read an untrusted
// .git/config — whose core.fsmonitor `git status` executes. The pre-subcommand region
// is default-deny now, so the read-only verb behind it no longer decides.
test('REV-194: requiresConfirmation gates "git -C /repo status" (the redirect is the vector)', () => {
  assert.equal(requiresConfirmation('git', ['-C', '/repo', 'status']), true);
});

test('REV-194: an inert main option keeps a read-only verb open', () => {
  assert.equal(requiresConfirmation('git', ['--no-pager', 'log', '--oneline']), false);
});

test('REV-194: --exec-path before a read-only verb now confirms', () => {
  assert.equal(
    requiresConfirmation('git', ['--exec-path=/tmp/evil', 'ls-remote', 'https://host/r']),
    true
  );
  assert.equal(
    requiresConfirmation('git', ['--exec-path', '/tmp/evil', 'ls-remote', 'https://host/r']),
    true
  );
});

// --- maxRiskLevel: always composes to the HIGHER level (REV-122) ---

test('REV-122: maxRiskLevel("low", "high") is "high"', () => {
  assert.equal(maxRiskLevel('low', 'high'), 'high');
});

test('REV-122: maxRiskLevel(null, "medium") is "medium"', () => {
  assert.equal(maxRiskLevel(null, 'medium'), 'medium');
});

test('REV-122: maxRiskLevel("critical", "low") is "critical" — a caller cannot lower the risk', () => {
  assert.equal(maxRiskLevel('critical', 'low'), 'critical');
});

test('REV-122: maxRiskLevel(null, null) defaults to "low"', () => {
  assert.equal(maxRiskLevel(null, null), 'low');
});
