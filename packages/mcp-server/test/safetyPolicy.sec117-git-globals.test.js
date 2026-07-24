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

test('REV-117: requiresConfirmation allows read-only "git -C /repo status"', () => {
  assert.equal(requiresConfirmation('git', ['-C', '/repo', 'status']), false);
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
