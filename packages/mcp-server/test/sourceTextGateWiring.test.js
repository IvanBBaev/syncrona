// SPDX-License-Identifier: GPL-3.0-or-later
//
// `scripts/check-source-text.mjs` rejects control and invisible characters in source
// files. It exists because six files in this repository carried raw NUL or U+200B
// bytes that every gate passed: tsc, eslint, the full test suite and the boundary
// cruiser were all happy, while `grep` silently reported "no matches" in a file it
// had classified as binary. A reviewer grepping such a file for a security pattern
// got a clean answer from a search that never ran.
//
// The script proves itself on every invocation (its own probes must all fire before
// it will scan anything), so what it cannot prove is that it is still WIRED — remove
// `lint:text` from the root `lint` chain and the gate stops running with no test
// anywhere turning red. That is the same failure mode REV-133 found in `verify:pack`,
// and this file closes it the same way: re-derive the chain from the root
// package.json and assert the script is reachable from `npm run check`.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));

const GATE_REL_PATH = 'scripts/check-source-text.mjs';

/**
 * Expand a root npm script into the full text of everything it runs, following
 * `npm run <name>` references into the sibling scripts they name.
 *
 * `visited` makes a cyclic or diamond-shaped chain terminate instead of recursing
 * forever; a diamond is normal here (`check` reaches `build:deps` through both
 * `build` and `typecheck:all`), so revisiting is not an error, just a no-op.
 */
function expandScript(name, visited = new Set()) {
  if (visited.has(name)) return '';
  visited.add(name);
  const body = rootPkg.scripts[name];
  if (typeof body !== 'string') return '';

  const parts = [body];
  for (const match of body.matchAll(/npm run ([\w:-]+)/g)) {
    parts.push(expandScript(match[1], visited));
  }
  return parts.join('\n');
}

test('the source-text gate exists at the path the chain names', () => {
  assert.ok(
    fs.existsSync(path.join(repoRoot, GATE_REL_PATH)),
    `${GATE_REL_PATH} is referenced by the lint chain but is not on disk`,
  );
});

test('`npm run check` reaches the source-text gate', () => {
  const chain = expandScript('check');
  assert.ok(
    chain.includes(GATE_REL_PATH),
    'check no longer runs check-source-text.mjs — the invisible-character gate is dead code',
  );
});

test('`npm run lint` is the link that carries it, so CI runs it as its own step', () => {
  // CI hand-replicates the chain step by step (see ciCheckChain.test.js) and runs
  // `npm run lint` as one of those steps. Pinning the gate to `lint` specifically —
  // not merely to `check` — is what makes the CI step above cover it too.
  assert.ok(expandScript('lint').includes(GATE_REL_PATH));
});

// REV-204's lesson, applied here: a reachability check that matches too loosely
// passes for the wrong reason. These pin that `expandScript` really does walk the
// chain and really can return false.
test('the chain expander is neither vacuous nor unconditionally true', () => {
  const check = expandScript('check');
  assert.ok(check.includes('npm run lint'), 'expander must return the top-level body');
  assert.ok(
    check.includes(GATE_REL_PATH),
    'expander must follow `npm run lint` two levels down into lint:text',
  );
  assert.equal(
    check.includes('scripts/no-such-gate.mjs'),
    false,
    'expander must not report a script the chain does not name',
  );
});

test('the gate self-test passes, so a scan it reports clean is a scan that ran', () => {
  const result = spawnSync(process.execPath, [GATE_REL_PATH, '--self-test-only'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  assert.equal(
    result.status,
    0,
    `self-test failed:\n${result.stdout}\n${result.stderr}`,
  );
});
