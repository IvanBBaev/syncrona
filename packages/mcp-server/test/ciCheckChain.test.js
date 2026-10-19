// SPDX-License-Identifier: GPL-3.0-or-later
//
// REV-133 — the CI `check` job does not run `npm run check`; it hand-replicates
// the chain step by step (so each link gets its own annotated step and its own
// timing). That duplication silently drifted: `verify:pack` — the only gate that
// inspects tarball CONTENTS (secret files, stray sources, missing bin/dist,
// undeclared runtime deps) — was never added, so a `files:`/`bin:` regression
// could reach the release branch with CI fully green.
//
// This test re-derives the chain from the root package.json and asserts every
// link is executed by the workflow, either directly or through all of its
// sub-scripts.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const repoRoot = path.resolve(__dirname, '..', '..', '..');
const rootPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, 'package.json'), 'utf8'));
const ciYaml = fs.readFileSync(path.join(repoRoot, '.github', 'workflows', 'ci.yml'), 'utf8');

/**
 * REV-204: extract the commands the workflow actually EXECUTES.
 *
 * The original matcher regexed the whole file text, which meant a commented-out step
 * still satisfied it — the guard stopped guarding at exactly the moment it mattered.
 * That was not hypothetical: `ci.yml` explains the hand-replicated chain in prose, so
 * the strings `npm run build` and `npm run check` appear in comments several lines
 * above the steps that run them. Deleting `run: npm run build` would have left the
 * test green.
 *
 * So collect the value of every `run:` key instead of matching the file as a blob:
 *   - lines whose first non-blank character is `#` are skipped. At YAML level those
 *     are comments; inside a shell block scalar they are shell comments, i.e. also
 *     not executed — so the same rule is correct in both contexts.
 *   - `run: <cmd>` contributes `<cmd>`.
 *   - `run: |` / `run: >` (with any chomping indicator) opens a block scalar; every
 *     following line indented deeper than the `run:` key belongs to it.
 *
 * Honest limitation: this is a line scanner, not a YAML lexer. It does not understand
 * quoted keys, flow mappings, anchors/aliases, or a `#` that begins a line *inside* a
 * quoted multi-line scalar. None of those appear in this workflow, and
 * `assertScannerSawTheWorkflow` below fails loudly if a rewrite ever introduces a
 * shape the scanner cannot read, rather than letting every assertion pass vacuously.
 */
function executedCommands(yamlText) {
  const commands = [];
  const lines = yamlText.split('\n');
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (trimmed.length === 0 || trimmed.startsWith('#')) continue;

    const match = /^(\s*)(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (!match) continue;
    const indent = match[1].length;
    const rest = match[2].trim();

    if (!/^[|>][+-]?\d*$/.test(rest)) {
      // Inline scalar: `run: npm run build`.
      if (rest.length > 0) commands.push(rest);
      continue;
    }

    // Block scalar: consume the more-indented lines that follow.
    for (let j = i + 1; j < lines.length; j += 1) {
      const blockLine = lines[j];
      const blockTrimmed = blockLine.trim();
      if (blockTrimmed.length === 0) continue;
      const blockIndent = blockLine.length - blockLine.trimStart().length;
      if (blockIndent <= indent) {
        i = j - 1;
        break;
      }
      if (!blockTrimmed.startsWith('#')) commands.push(blockTrimmed);
      if (j === lines.length - 1) i = j;
    }
  }
  return commands;
}

const CI_COMMANDS = executedCommands(ciYaml);
/** One searchable blob of executed command text, newline-separated. */
const CI_EXECUTED = CI_COMMANDS.join('\n');

/** The `npm run <script>` tokens a script body invokes. */
function subScriptsOf(script) {
  const body = rootPkg.scripts[script] || '';
  return [...body.matchAll(/npm run ([\w:-]+)/g)].map((m) => m[1]);
}

/** Does the workflow invoke this exact script? (`test` must not match `test:core`.) */
function runsDirectly(script, haystack = CI_EXECUTED) {
  const escaped = script.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`npm run ${escaped}(?![\\w:-])`).test(haystack);
}

/**
 * The scanner's own tripwire. Every assertion below is of the form "CI runs X", so a
 * scanner that silently read nothing would make all of them fail — but a scanner that
 * read *most* of the file could still hide a gap. Pin the two invariants that prove it
 * parsed both scalar styles: the inline `npm ci` step, and `node -e` from the `run: |`
 * block in the pack-verification job.
 */
function assertScannerSawTheWorkflow() {
  assert.ok(
    CI_COMMANDS.length >= 8,
    `the run: scanner found only ${CI_COMMANDS.length} commands — ci.yml likely uses a YAML shape it cannot read`,
  );
  assert.ok(
    CI_COMMANDS.some((c) => /^npm ci\b/.test(c)),
    'expected the inline `npm ci` step to be picked up',
  );
  assert.ok(
    CI_COMMANDS.some((c) => c.includes('node -e')),
    'expected a `run: |` block scalar body to be picked up',
  );
}

/** A link is covered when CI runs it, or runs every one of its sub-scripts. */
function isCovered(script, seen = new Set()) {
  if (seen.has(script)) return true;
  seen.add(script);
  if (runsDirectly(script)) return true;
  const subs = subScriptsOf(script);
  return subs.length > 0 && subs.every((sub) => isCovered(sub, seen));
}

test('every link of the root `check` chain is executed by the CI check job', () => {
  const chain = subScriptsOf('check');
  assert.ok(chain.length >= 5, `expected the check chain to be composed of npm scripts, got ${chain.join(', ')}`);
  const uncovered = chain.filter((script) => !isCovered(script));
  assert.deepEqual(
    uncovered,
    [],
    `these links of \`npm run check\` have no CI step: ${uncovered.join(', ')}`,
  );
});

test('`verify:pack` is part of the check chain and runs in CI', () => {
  // Pinned separately: it is the newest link and the one that went missing.
  assert.ok(subScriptsOf('check').includes('verify:pack'), 'verify:pack must stay in `npm run check`');
  assert.ok(runsDirectly('verify:pack'), 'the CI check job must run `npm run verify:pack`');
});

test('the coverage helper cannot pass as a substring of another script name', () => {
  // Guards the matcher itself: CI runs `npm run test:core`, which must NOT be
  // read as coverage for the umbrella `npm run test` script.
  assert.equal(runsDirectly('test'), false);
  assert.ok(runsDirectly('test:core'));
});

test('the run: scanner reads the real workflow, so the assertions above are not vacuous', () => {
  assertScannerSawTheWorkflow();
});

// REV-204: the matcher used to search the whole file, so prose that merely *names* a
// script satisfied it. `ci.yml` documents its hand-replicated chain in comments, which
// means `npm run build` and `npm run check` appear there in full — deleting the steps
// that run them would have left this suite green. These fixtures pin the distinction
// directly, so the guard cannot regress back to a blob match without failing.
test('a commented-out step does not count as executed', () => {
  const yaml = [
    'jobs:',
    '  check:',
    '    steps:',
    '      # We used to run `npm run build` here, and the chain still explains it.',
    '      - name: Install',
    '        run: npm ci',
    '      # - name: Build',
    '      #   run: npm run build',
  ].join('\n');
  const commands = executedCommands(yaml);

  assert.deepEqual(commands, ['npm ci']);
  assert.equal(runsDirectly('build', commands.join('\n')), false);
});

test('an inline step and a block-scalar step both count as executed', () => {
  const yaml = [
    'jobs:',
    '  check:',
    '    steps:',
    '      - name: Build',
    '        run: npm run build',
    '      - name: Smoke',
    '        run: |',
    '          set -euo pipefail',
    '          # npm run lint is deliberately NOT part of the smoke',
    '          npm run verify:pack',
    '',
    '      - name: Upload',
    '        uses: actions/upload-artifact@v7',
    '        with:',
    '          path: coverage',
  ].join('\n');
  const commands = executedCommands(yaml);
  const haystack = commands.join('\n');

  assert.ok(runsDirectly('build', haystack), 'inline scalar must be read');
  assert.ok(runsDirectly('verify:pack', haystack), 'block scalar body must be read');
  // The shell comment inside the block is not executed, and the scanner must stop at
  // the next step rather than swallowing the `with:` mapping that follows it.
  assert.equal(runsDirectly('lint', haystack), false);
  assert.equal(
    commands.includes('path: coverage'),
    false,
    'the block scalar must end at the dedented step',
  );
});
