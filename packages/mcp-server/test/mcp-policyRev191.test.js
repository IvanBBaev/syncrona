// SPDX-License-Identifier: GPL-3.0-or-later
// SEC-2 follow-up (REV-140/REV-141/REV-191): the run_workspace_command confirmation gate
// used to reason about a git invocation only up to its SUBCOMMAND, and to allowlist a
// binary by BASENAME. Both let an unconfirmed invocation execute an arbitrary program:
//
//   REV-140 — a read-only verb's own options were never inspected, so
//     `git ls-remote --upload-pack='touch X' .`   (runs X),
//     `git grep -O'touch X' hello`                (runs X via the pager),
//     `git diff --output=/path/victim HEAD`       (truncates an arbitrary file)
//     all reported requiresConfirmation() === false.
//   REV-191 — the follow-up scan still bailed out of a combined short-flag cluster at the
//     first flag believed to take a value, and that belief is verb-dependent: `-n` is
//     value-taking for `log` but the boolean --line-number for `grep`, so
//     `git grep -nO'touch X' hello` slipped through the REV-140 guard as well. Reproduced
//     against git 2.50.1: the file was created while the gate said "no confirmation".
//   REV-141 — the allowlist matched `normalizeBinaryName(command)`, so `./git status` or
//     `/tmp/evil/git status` ran an attacker-planted binary unconfirmed.
//
// Every MUST_CONFIRM case below is false (ungated) against the pre-fix code.
const test = require('node:test');
const assert = require('node:assert/strict');

const { requiresConfirmation } = require('../dist/safetyPolicy.js');

const MUST_CONFIRM = [
  // REV-140: options of a read-only verb that name a program to run.
  ['git', ['ls-remote', '--upload-pack=touch /tmp/PWN', '.']],
  ['git', ['ls-remote', '--upload-pack', 'touch /tmp/PWN', '.']],
  ['git', ['grep', '-Otouch /tmp/PWN', 'hello']],
  ['git', ['grep', '-O', 'touch /tmp/PWN', 'hello']],
  ['git', ['log', '--exec-path=/tmp/evil']],
  // REV-140: options of a read-only verb that overwrite an arbitrary file.
  ['git', ['diff', '--output=/tmp/victim', 'HEAD']],
  ['git', ['show', '--output=/tmp/victim', 'HEAD']],
  ['git', ['log', '--output', '/tmp/victim']],
  // REV-140: `git help -w` / -m / -i hand the topic to an external viewer.
  ['git', ['help', '-w', 'git']],
  ['git', ['help', '--web', 'git']],
  // REV-191: the dangerous flag hides behind a flag that is value-taking for SOME verb.
  ['git', ['grep', '-nOtouch /tmp/PWN', 'hello']],
  ['git', ['grep', '-inOtouch /tmp/PWN', 'hello']],
  ['git', ['log', '-nOtouch /tmp/PWN']],
  // REV-141: an allowlisted NAME at a caller-chosen PATH is not the allowlisted program.
  ['/tmp/evil/git', ['status']],
  ['./git', ['status']],
  ['../git', ['log']],
  ['/usr/bin/ls', ['-la']],
  ['./syncrona', ['status']],
  ['.\\git', ['status']],
  ['bin\\git.exe', ['status']],
];

for (const [command, args] of MUST_CONFIRM) {
  test(`REV-191: gates "${command} ${args.join(' ')}"`, () => {
    assert.equal(requiresConfirmation(command, args), true);
  });
}

// Genuinely read-only invocations must stay ungated — the fix is default-deny, so this
// half of the contract is what keeps it from degenerating into "confirm everything".
const NO_CONFIRM = [
  ['git', ['status']],
  ['git', ['status', '--porcelain', '-b']],
  ['git', ['log', '--oneline', '-5']],
  ['git', ['log', '-n', '5', '--pretty=format:%H']],
  ['git', ['log', '-n5']],
  ['git', ['diff', '--stat', 'HEAD~1', '--', 'src/']],
  ['git', ['show', 'HEAD', '--name-only']],
  ['git', ['grep', '-n', '-e', 'needle', '--', 'src/']],
  ['git', ['ls-remote', '--heads', '.']],
  ['git', ['rev-parse', '--abbrev-ref', 'HEAD']],
  ['git', ['blame', '-L', '10,20', 'file.txt']],
  // `['git', ['-C', '/repo', 'status', '--short']]` was here until REV-194 made the
  // pre-subcommand region default-deny; a repository redirect confirms now (see
  // safetyPolicy.rev124-git-hardening.test.js).
  ['git', ['help', 'log']],
  ['git', ['--version']],
  ['git', ['--no-pager', 'log', '--oneline']],
  ['ls', ['-la']],
  ['cat', ['README.md']],
  ['syncrona', ['status']],
];

for (const [command, args] of NO_CONFIRM) {
  test(`REV-191: allows read-only "${command} ${args.join(' ')}"`, () => {
    assert.equal(requiresConfirmation(command, args), false);
  });
}
