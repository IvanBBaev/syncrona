// SPDX-License-Identifier: GPL-3.0-or-later
// Property-based coverage for the run_workspace_command confirmation gate.
//
// The example-based suites (mcp-policyRev191, mcp-policyRev192, branchRisk.safety,
// destructive-contract) pin the specific bypasses that were found by hand — one
// concrete argv per regression. That leaves the question the examples cannot
// answer: does the gate hold for argv shapes nobody thought to write down?
//
// safetyPolicy is a pure decision function over (command, args), so it is the
// cheapest place in the repo to state the gate as invariants and let fast-check
// search the argv space. The four properties below are the ones that survived
// probing; the deliberately NON-property at the end pins a shape that looks like
// an invariant, is not one, and must not be "fixed" into one later.
const test = require('node:test');
const assert = require('node:assert/strict');
const fc = require('fast-check');

const {
  requiresConfirmation,
  isUnsafeWorkspaceCommand,
  isDestructiveWorkspaceCommand,
  findSyncroCliSubcommand,
  isMutatingTool,
} = require('../dist/safetyPolicy.js');

// ---------------------------------------------------------------------------
// Arbitraries
// ---------------------------------------------------------------------------

// git main options that redirect git at another repository, worktree, config or
// helper binary. Every one of them turns a "read-only" verb into an arbitrary
// filesystem/program reach, so none may ever appear in the main-option region of
// an unconfirmed command.
const GIT_REDIRECT_MAIN_OPTIONS = [
  '--exec-path',
  '-C',
  '--git-dir',
  '--work-tree',
  '--namespace',
  '--super-prefix',
  '-c',
  '--config-env',
];

// The forms a redirect flag can take on a real command line, plus the forms an
// attacker reaches for when probing a string-matching gate: `=`-vs-space, an
// empty value, case flips, and whitespace padding.
function redirectSpellings(flag) {
  return [
    flag,
    `${flag}=/tmp/x`,
    `${flag}=`,
    flag.toUpperCase(),
    `${flag.toUpperCase()}=/tmp/x`,
    `${flag} `,
    ` ${flag}`,
    `\t${flag}`,
  ];
}

const redirectToken = fc.constantFrom(
  ...GIT_REDIRECT_MAIN_OPTIONS.flatMap(redirectSpellings)
);

// Main options the gate does allow, so the redirect flag has to be found among
// legitimate neighbours rather than sitting alone at argv[0]. Mirrors
// GIT_SAFE_MAIN_OPTIONS in src/safetyPolicy.ts; the mirror is guarded by its own
// test below rather than trusted.
const SAFE_MAIN_OPTIONS = new Set([
  '--version',
  '--html-path',
  '--man-path',
  '--info-path',
  '--no-pager',
  '-P',
  '--no-replace-objects',
  '--literal-pathspecs',
  '--no-literal-pathspecs',
  '--glob-pathspecs',
  '--noglob-pathspecs',
  '--icase-pathspecs',
  '--no-optional-locks',
]);

const safeMainOption = fc.constantFrom(...SAFE_MAIN_OPTIONS);

const readOnlyVerb = fc.constantFrom(
  'status',
  'log',
  'diff',
  'show',
  'grep',
  'blame',
  'ls-files',
  'ls-remote',
  'rev-parse',
  'describe',
  'shortlog',
  'cat-file',
  'help'
);

const subcommandToken = fc.constantFrom(
  '--oneline',
  '--stat',
  '--all',
  '-n',
  '-p',
  '-z',
  '--',
  'HEAD',
  'file.txt',
  'origin/main'
);

// A token universe wide enough to reach the gate's branch boundaries: safe and
// unsafe options, verbs, the `--` sentinel, a bare `-`, empty and whitespace-only
// tokens, and unconstrained strings.
const anyToken = fc.oneof(
  { arbitrary: safeMainOption, weight: 3 },
  { arbitrary: readOnlyVerb, weight: 3 },
  { arbitrary: subcommandToken, weight: 3 },
  { arbitrary: redirectToken, weight: 2 },
  { arbitrary: fc.constantFrom('--', '-', '', ' ', '\n', '--upload-pack=x', '-O/tmp/x'), weight: 2 },
  { arbitrary: fc.string({ maxLength: 8 }), weight: 1 }
);

// ---------------------------------------------------------------------------
// Property 1 — default-deny in the git main-option region
// ---------------------------------------------------------------------------

test('a git redirect main option always requires confirmation, at any position and in any spelling', () => {
  fc.assert(
    fc.property(
      fc.array(safeMainOption, { maxLength: 3 }),
      redirectToken,
      fc.array(safeMainOption, { maxLength: 3 }),
      fc.array(redirectToken, { maxLength: 2 }),
      readOnlyVerb,
      fc.array(subcommandToken, { maxLength: 4 }),
      (before, redirect, between, repeats, verb, tail) => {
        const args = [...before, redirect, ...between, ...repeats, verb, ...tail];
        return requiresConfirmation('git', args) === true;
      }
    ),
    { numRuns: 3000 }
  );
});

test('any unrecognized option in the git main-option region requires confirmation', () => {
  // The general form of the property above: the main-option region is
  // default-deny, so the gate must not depend on knowing which flags are
  // dangerous — only on which few are known safe.
  fc.assert(
    fc.property(
      fc.array(safeMainOption, { maxLength: 2 }),
      fc.string({ minLength: 1, maxLength: 12 }),
      fc.array(anyToken, { maxLength: 4 }),
      (before, raw, tail) => {
        const token = `-${raw}`;
        // `--` is the end-of-options sentinel, not an option; fast-check found it
        // by shrinking this property to [[], "-", []].
        fc.pre(token !== "--");
        fc.pre(!SAFE_MAIN_OPTIONS.has(token));
        return requiresConfirmation('git', [...before, token, ...tail]) === true;
      }
    ),
    { numRuns: 3000 }
  );
});

test('every option this suite believes is a safe git main option really is accepted', () => {
  // Guards the mirror above: if src adds to or removes from GIT_SAFE_MAIN_OPTIONS
  // without this list following, the fc.pre() filter would silently start
  // excluding (or wrongly asserting on) the wrong tokens and the default-deny
  // property would weaken without failing.
  for (const option of SAFE_MAIN_OPTIONS) {
    assert.equal(
      requiresConfirmation('git', [option, 'status']),
      false,
      `${option} should be an accepted git main option`
    );
  }
});

// ---------------------------------------------------------------------------
// Property 2 — appending arguments never relaxes the gate
// ---------------------------------------------------------------------------

test('appending arguments never turns a confirmed git command into an unconfirmed one', () => {
  fc.assert(
    fc.property(
      fc.array(anyToken, { maxLength: 6 }),
      fc.array(anyToken, { maxLength: 3 }),
      (base, extra) => {
        fc.pre(requiresConfirmation('git', base) === true);
        return requiresConfirmation('git', [...base, ...extra]) === true;
      }
    ),
    { numRuns: 5000 }
  );
});

// ---------------------------------------------------------------------------
// Property 3 — totality
// ---------------------------------------------------------------------------

test('every workspace-command policy decision is total for arbitrary command and args', () => {
  const junk = fc.oneof(
    fc.string(),
    fc.string({ unit: 'binary' }),
    fc.constantFrom('', ' ', '\n', '\\', '/', '-', '--', '.', '..', 'git', 'GIT', 'git.exe', './git')
  );

  fc.assert(
    fc.property(junk, fc.array(junk, { maxLength: 6 }), (command, args) => {
      // Each decision must produce a value of its declared type rather than
      // throwing: the caller in workspaceHandlers has no try/catch around the
      // gate, so a throw here is a crash on the request path.
      assert.equal(typeof requiresConfirmation(command, args), 'boolean');
      assert.equal(typeof isUnsafeWorkspaceCommand(command, args), 'boolean');
      assert.equal(typeof isDestructiveWorkspaceCommand(command, args), 'boolean');
      const sub = findSyncroCliSubcommand(command, args);
      assert.ok(sub === null || typeof sub === 'string');
      assert.equal(typeof isMutatingTool(command, { command, args }), 'boolean');
      return true;
    }),
    { numRuns: 3000 }
  );
});

test('the binary allowlist is matched on the whole command, so any path-qualified binary requires confirmation', () => {
  // REV-141: allowlisting by basename let `./git status` and `/tmp/evil/git status`
  // run an attacker-planted binary unconfirmed.
  fc.assert(
    fc.property(
      fc.array(fc.string({ maxLength: 6 }), { maxLength: 3 }),
      fc.constantFrom('/', '\\'),
      fc.constantFrom('git', 'ls', 'cat', 'pwd', 'echo', 'syncrona'),
      fc.array(anyToken, { maxLength: 3 }),
      (dirs, sep, base, args) => {
        const command = [...dirs, base].join(sep);
        fc.pre(command !== base);
        return requiresConfirmation(command, args) === true;
      }
    ),
    { numRuns: 2000 }
  );
});

// ---------------------------------------------------------------------------
// Property 4 — the destructive CLI subcommands are never unconfirmed
// ---------------------------------------------------------------------------

test('a syncrona push, deploy or download always requires confirmation whatever surrounds it', () => {
  fc.assert(
    fc.property(
      fc.constantFrom('syncrona', 'SYNCRONA', 'Syncrona', 'syncrona.cmd', 'syncrona.CMD', 'syncrona.exe'),
      fc.array(fc.constantFrom('--ci', '-v', '--logLevel', 'debug'), { maxLength: 3 }),
      fc.constantFrom('push', 'deploy', 'download', 'PUSH', 'Deploy', 'DOWNLOAD'),
      fc.array(fc.constantFrom('--ci', '-v', '--', '-', 'scope'), { maxLength: 3 }),
      (bin, before, sub, after) =>
        requiresConfirmation(bin, [...before, sub, ...after]) === true
    ),
    { numRuns: 2000 }
  );
});

// ---------------------------------------------------------------------------
// Known NON-invariants — pinned so they are not mistaken for properties
// ---------------------------------------------------------------------------

test('known limitation: the gate is NOT monotone under insertion, only under appending', () => {
  // Probed as a property and disproved. fast-check shrank it to
  //   base ["--oneline"], insert "status" at index 0
  //   { seed: -1096303284, path: "252:1:0:1:1" }
  // and the counterexample is correct behaviour, not a bug: `git --oneline` is a
  // rejected unknown main option, while `git status --oneline` is a read-only verb
  // with one of its own safe options. Prepending a verb legitimately completes a
  // command that was incomplete, so only the append direction is a real invariant
  // and Property 2 is stated in that direction on purpose.
  assert.equal(requiresConfirmation('git', ['--oneline']), true);
  assert.equal(requiresConfirmation('git', ['status', '--oneline']), false);
});

test('known limitation: --git-dir is a rejected main option but an allowed rev-parse query flag', () => {
  // The task-level phrasing "--git-dir is always rejected" is true only for the
  // main-option region. After a read-only verb, `--git-dir` is a rev-parse query
  // that prints the resolved path and is deliberately in
  // GIT_SAFE_SUBCOMMAND_OPTIONS, so Property 1 is scoped to the main-option
  // region rather than to the whole argv.
  assert.equal(requiresConfirmation('git', ['--git-dir=/tmp/x', 'status']), true);
  assert.equal(requiresConfirmation('git', ['rev-parse', '--git-dir']), false);
});
