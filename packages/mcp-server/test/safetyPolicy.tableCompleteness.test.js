// SPDX-License-Identifier: GPL-3.0-or-later
//
// Mutation-driven contract tests for every policy table in src/safetyPolicy.ts.
//
// WHY THIS FILE EXISTS
// A Stryker run over safetyPolicy.ts scored 63.14% (607 killed / 383 survived).
// 327 of those 383 survivors — 85% — were StringLiteral mutants of the SAME shape:
// one entry of one policy Set replaced by "". The module's behaviour is almost
// entirely encoded in those tables, and no test asserted per-entry, so emptying
// an entry changed a real security decision while the suite stayed green.
//
// The consequence of a dropped entry depends on which side of the gate the table
// sits on:
//   * a DENYLIST / recognizer entry (BLOCKED_*, DESTRUCTIVE_CLI_SUBCOMMANDS,
//     PACKAGE_*, CLI_PACKAGE_NAMES, MUTATING_TOOLS, DRY_RUN_AWARE_TOOLS,
//     GIT_VERB_DANGEROUS_OPTIONS) fails OPEN — the invocation stops being
//     recognized as dangerous and runs unconfirmed, or an audit record claims a
//     simulation of a run that really happened. Security-critical.
//   * an ALLOWLIST entry (READONLY_ALLOWLIST, GIT_SAFE_*, GIT_READONLY_SUBCOMMANDS)
//     fails CLOSED — the gate over-confirms. Safe direction, but still a real
//     regression: it breaks a read-only agent workflow that used to work.
// Both are pinned here.
//
// DESIGN CONSTRAINT — the fixtures below MUST stay literal lists in this file.
// Deriving them from safetyPolicy.ts at runtime (importing the Sets, reading and
// parsing the source) makes every one of these assertions a tautology under
// mutation: the StringLiteral mutant would rewrite the source AND the expectation
// together, the assertion would still hold, and the mutant would survive. A
// duplicated list is the point, not an oversight. The trade is one-directional and
// deliberate: adding an entry to safetyPolicy.ts does not fail these tests (the
// per-entry contract tests for a new entry belong with the change that adds it),
// but silently losing or corrupting one does.
//
// Assertions go through the PUBLIC API only — the observable policy decision, not
// Set membership — so they also pin the walk that consumes each table.
//
// SPLIT WITH policy.cov.test.js: the tables reached through the CLI-invocation
// parser (MUTATING_TOOLS, the PACKAGE_MANAGERS × PACKAGE_MANAGER_EXEC_SUBCOMMANDS
// matrix, the Windows launcher spellings, the minimal-footprint budget boundary)
// are pinned there, next to the rest of that parser's coverage. This file owns the
// tables consumed by the git and command-name walks, plus the argument forms of a
// CLI package token. Nothing is asserted in both places.
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  requiresConfirmation,
  isDestructiveWorkspaceCommand,
  isUnsafeWorkspaceCommand,
  toolImplementsDryRun,
  isEffectiveDryRun,
} = require('../dist/safetyPolicy.js');

// --- Fixtures (literal by design — see the header) -------------------------

const BLOCKED_COMMANDS = ['rm', 'sudo', 'dd', 'mkfs', 'shutdown', 'reboot', 'killall', 'pkill'];

const BLOCKED_SHELL_INTERPRETERS = ['bash', 'sh', 'zsh', 'fish'];

const BLOCKED_SHELL_TOKENS = ['&&', '||', ';', '|', '`', '$(', '>', '<'];

const DESTRUCTIVE_CLI_SUBCOMMANDS = ['push', 'deploy', 'download'];

const CLI_PACKAGE_NAMES = ['syncrona'];

const PACKAGE_RUNNERS = ['npx', 'pnpx', 'bunx'];

const DRY_RUN_AWARE_TOOLS = [
  'sync_set_scope',
  'sync_set_update_set',
  'sync_prepare_session',
  'sync_push',
  'run_workspace_command',
  'run_node_code',
  'sn_create_record',
  'sn_execute_background_script',
  'sync_create_script_include',
  'sync_create_script_include_and_sync',
  'sn_update_metadata_record',
  'sn_autonomous_remediation_workflow',
  'sync_unified_change_workflow',
  'sync_run_atf_tests',
  'sync_generate_scope_knowledge',
  'sync_generate_scope_docs',
  'sync_scope_knowledge_auto_update',
  'sync_generate_table_dependency_report',
];

const READONLY_ALLOWLIST = ['git', 'ls', 'cat', 'pwd', 'echo', 'syncrona'];

const GIT_SAFE_MAIN_OPTIONS = [
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
];

const GIT_READONLY_SUBCOMMANDS = [
  'status', 'log', 'show', 'diff', 'shortlog', 'describe', 'blame', 'annotate',
  'grep', 'ls-files', 'ls-tree', 'ls-remote', 'cat-file', 'rev-parse', 'rev-list',
  'name-rev', 'for-each-ref', 'show-ref', 'merge-base', 'cherry', 'whatchanged',
  'count-objects', 'verify-commit', 'verify-tag', 'var', 'version', 'help',
];

const GIT_SAFE_SUBCOMMAND_OPTIONS = [
  "--oneline", "--pretty", "--format", "--abbrev-commit", "--abbrev",
  "--date", "--graph", "--decorate", "--decorate-refs", "--decorate-refs-exclude",
  "--color", "--color-words", "--stat", "--numstat", "--shortstat",
  "--dirstat", "--summary", "--compact-summary", "--patch", "--patch-with-stat",
  "--patch-with-raw", "--raw", "--name-only", "--name-status", "--word-diff",
  "--word-diff-regex", "--unified", "--inter-hunk-context", "--function-context", "--src-prefix",
  "--dst-prefix", "--prefix", "--line-prefix", "--relative", "--full-index",
  "--binary", "--check", "--ws-error-highlight", "--find-renames", "--renames",
  "--rename-empty", "--find-copies", "--find-copies-harder", "--find-object", "--break-rewrites",
  "--irreversible-delete", "--diff-filter", "--diff-algorithm", "--anchored", "--histogram",
  "--patience", "--minimal", "--indent-heuristic", "--ignore-all-space", "--ignore-space-change",
  "--ignore-space-at-eol", "--ignore-blank-lines", "--ignore-cr-at-eol", "--ignore-matching-lines", "--ignore-submodules",
  "--text", "--exit-code", "--quiet", "--cached", "--staged",
  "--merge-base", "--index", "--submodule", "--stat-width", "--stat-name-width",
  "--stat-count", "--pickaxe-all", "--pickaxe-regex", "--combined-all-paths", "--cc",
  "--diff-merges", "--remerge-diff", "--output-indicator-new", "--output-indicator-old", "--output-indicator-context",
  "--expand-tabs", "--encoding", "--progress", "--column", "--null",
  "--shell", "--perl", "--python", "--tcl", "--sq",
  "--sq-quote", "--omit-empty", "--all", "--branches", "--tags",
  "--remotes", "--glob", "--exclude", "--exclude-hidden", "--not",
  "--since", "--since-as-filter", "--after", "--until", "--before",
  "--author", "--committer", "--grep", "--grep-reflog", "--all-match",
  "--invert-grep", "--regexp-ignore-case", "--basic-regexp", "--extended-regexp", "--fixed-strings",
  "--perl-regexp", "--remove-empty", "--merges", "--min-parents", "--max-parents",
  "--first-parent", "--exclude-first-parent-only", "--ancestry-path", "--skip", "--max-count",
  "--max-age", "--min-age", "--reverse", "--topo-order", "--date-order",
  "--author-date-order", "--walk", "--do-walk", "--follow", "--full-history",
  "--full-diff", "--simplify-merges", "--simplify-by-decoration", "--sparse", "--dense",
  "--left-right", "--left-only", "--right-only", "--cherry", "--cherry-mark",
  "--cherry-pick", "--boundary", "--children", "--parents", "--show-signature",
  "--notes", "--show-notes", "--walk-reflogs", "--reflog", "--single-worktree",
  "--stdin", "--end-of-options", "--bisect", "--mailmap", "--use-mailmap",
  "--source", "--log-size", "--header", "--objects", "--missing",
  "--in-commit-order", "--object-names", "--disk-usage", "--filter", "--count",
  "--sort", "--points-at", "--merged", "--contains", "--exact-match",
  "--candidates", "--dirty", "--broken", "--always", "--long",
  "--short", "--match", "--debug", "--verify", "--symbolic",
  "--symbolic-full-name", "--abbrev-ref", "--git-dir", "--git-common-dir", "--absolute-git-dir",
  "--show-toplevel", "--show-prefix", "--show-cdup", "--show-object-format", "--show-superproject-working-tree",
  "--is-inside-work-tree", "--is-bare-repository", "--is-inside-git-dir", "--is-shallow-repository", "--git-path",
  "--path-format", "--revs-only", "--revs", "--flags", "--default",
  "--local-env-vars", "--shared-index-path", "--resolve-git-dir", "--parseopt", "--keep-dashdash",
  "--stop-at-non-option", "--deleted", "--modified", "--others", "--ignored",
  "--stage", "--unmerged", "--killed", "--directory", "--empty-directory",
  "--exclude-standard", "--exclude-per-directory", "--exclude-from", "--error-unmatch", "--full-name",
  "--full-tree", "--object-only", "--recurse-submodules", "--eol", "--with-tree",
  "--deduplicate", "--heads", "--refs", "--get-url", "--symref",
  "--server-option", "--dereference", "--hash", "--exclude-existing", "--exists",
  "--batch", "--batch-check", "--batch-command", "--batch-all-objects", "--batch-size",
  "--buffer", "--follow-symlinks", "--unordered", "--allow-unknown-type", "--line-number",
  "--files-with-matches", "--files-without-match", "--word-regexp", "--invert-match", "--ignore-case",
  "--untracked", "--max-depth", "--context", "--after-context", "--before-context",
  "--heading", "--break", "--only-matching", "--show-function", "--threads",
  "--and", "--or", "--porcelain", "--line-porcelain", "--incremental",
  "--show-email", "--show-name", "--show-number", "--show-stats", "--root",
  "--score-debug", "--ignore-rev", "--ignore-revs-file", "--color-lines", "--color-by-age",
  "--contents", "--numbered", "--email", "--group", "--octopus",
  "--independent", "--is-ancestor", "--fork-point", "--verbose", "--human-readable",
  "--build-options", "--branch", "--show-stash", "--untracked-files", "--ahead-behind",
  "--annotate-stdin", "--undefined", "--guides", "--config", "--aliases",
  "--external-commands", "--include-root-refs",
];

const GIT_SAFE_SHORT_FLAGS = [
  ...'abcdefghijklmnopqrstuvwxyz'.split(''),
  'A', 'B', 'C', 'E', 'F', 'G', 'H', 'I', 'L', 'M', 'P', 'R', 'S', 'U', 'W',
];

// The uppercase letters deliberately NOT on the safe list. `-O` is the one that
// matters most (git grep --open-files-in-pager EXECUTES its value); the rest are
// held out because default-deny is the model, not because each is known dangerous.
const GIT_UNSAFE_SHORT_FLAGS = ['D', 'J', 'K', 'N', 'O', 'Q', 'T', 'V', 'X', 'Y', 'Z'];

const GIT_HELP_DANGEROUS_OPTIONS = ['-w', '--web', '-m', '--man', '-i', '--info'];

// --- Fixture inventory ----------------------------------------------------

// Guards against a fixture list being truncated by an editing accident: a lost
// entry would silently stop pinning its policy row and every remaining assertion
// would still pass. Counts are asserted, not derived.
test('policy fixtures have their expected sizes', () => {
  const sizes = [
    ['BLOCKED_COMMANDS', BLOCKED_COMMANDS, 8],
    ['BLOCKED_SHELL_INTERPRETERS', BLOCKED_SHELL_INTERPRETERS, 4],
    ['BLOCKED_SHELL_TOKENS', BLOCKED_SHELL_TOKENS, 8],
    ['DESTRUCTIVE_CLI_SUBCOMMANDS', DESTRUCTIVE_CLI_SUBCOMMANDS, 3],
    ['CLI_PACKAGE_NAMES', CLI_PACKAGE_NAMES, 1],
    ['PACKAGE_RUNNERS', PACKAGE_RUNNERS, 3],
    ['DRY_RUN_AWARE_TOOLS', DRY_RUN_AWARE_TOOLS, 18],
    ['READONLY_ALLOWLIST', READONLY_ALLOWLIST, 6],
    ['GIT_SAFE_MAIN_OPTIONS', GIT_SAFE_MAIN_OPTIONS, 13],
    ['GIT_READONLY_SUBCOMMANDS', GIT_READONLY_SUBCOMMANDS, 27],
    ['GIT_SAFE_SUBCOMMAND_OPTIONS', GIT_SAFE_SUBCOMMAND_OPTIONS, 302],
    ['GIT_SAFE_SHORT_FLAGS', GIT_SAFE_SHORT_FLAGS, 41],
    ['GIT_HELP_DANGEROUS_OPTIONS', GIT_HELP_DANGEROUS_OPTIONS, 6],
  ];
  for (const [name, list, expected] of sizes) {
    assert.equal(list.length, expected, `${name} should hold ${expected} entries`);
    assert.equal(new Set(list).size, expected, `${name} should hold no duplicates`);
  }
});

// --- Fail-OPEN tables: a dropped entry is a security hole ------------------

test('every blocked command stays unsafe, qualified or not', () => {
  for (const command of BLOCKED_COMMANDS) {
    assert.equal(isUnsafeWorkspaceCommand(command, []), true, `${command} must be blocked`);
    // commandBaseName strips a leading directory, so a qualified path cannot bypass it.
    assert.equal(
      isUnsafeWorkspaceCommand(`/usr/bin/${command}`, []),
      true,
      `/usr/bin/${command} must be blocked`
    );
    assert.equal(
      isUnsafeWorkspaceCommand(`..\\${command}`, []),
      true,
      `..\\${command} must be blocked`
    );
    // Not on the read-only allowlist either, so the confirmation gate also fires.
    assert.equal(requiresConfirmation(command, []), true, `${command} must require confirmation`);
  }
});

test('every blocked shell interpreter stays unsafe when handed an inline command', () => {
  for (const shell of BLOCKED_SHELL_INTERPRETERS) {
    for (const flag of ['-c', '--command']) {
      assert.equal(
        isUnsafeWorkspaceCommand(shell, [flag, 'echo hi']),
        true,
        `${shell} ${flag} must be blocked`
      );
    }
    // Without an inline-command flag it is not "unsafe", but it is still not
    // allowlisted, so it can never run unconfirmed.
    assert.equal(requiresConfirmation(shell, []), true, `${shell} must require confirmation`);
  }
});

test('every blocked shell token stays unsafe wherever it appears in an argument', () => {
  for (const token of BLOCKED_SHELL_TOKENS) {
    assert.equal(
      isUnsafeWorkspaceCommand('ls', [token]),
      true,
      `a bare ${token} argument must be blocked`
    );
    assert.equal(
      isUnsafeWorkspaceCommand('ls', [`-la${token}suffix`]),
      true,
      `an embedded ${token} must be blocked`
    );
  }
});

test('every destructive CLI subcommand confirms, whatever the operand position', () => {
  for (const subcommand of DESTRUCTIVE_CLI_SUBCOMMANDS) {
    assert.equal(
      isDestructiveWorkspaceCommand('syncrona', [subcommand]),
      true,
      `syncrona ${subcommand} must be destructive`
    );
    assert.equal(
      requiresConfirmation('syncrona', [subcommand]),
      true,
      `syncrona ${subcommand} must require confirmation`
    );
    // Every operand is checked, so a space-separated global option value cannot
    // push the real subcommand out of first position (see isDestructiveWorkspaceCommand).
    assert.equal(
      isDestructiveWorkspaceCommand('syncrona', ['--logLevel', 'debug', subcommand]),
      true,
      `syncrona --logLevel debug ${subcommand} must be destructive`
    );
    // Case-insensitive: operands are lowercased before the lookup.
    assert.equal(
      isDestructiveWorkspaceCommand('syncrona', [subcommand.toUpperCase()]),
      true,
      `syncrona ${subcommand.toUpperCase()} must be destructive`
    );
  }
  // Contrast: a read-only subcommand does not confirm, so the table is doing the
  // deciding rather than the command name.
  for (const readOnly of ['status', 'doctor', 'plugins']) {
    assert.equal(
      requiresConfirmation('syncrona', [readOnly]),
      false,
      `syncrona ${readOnly} must not require confirmation`
    );
  }
});

// The bare `<runner> syncrona <verb>` form is pinned in policy.cov.test.js; what is
// pinned here are the argument SHAPES a runner accepts around the package token,
// each of which is its own way to lose the invocation.
test('every package runner reaches the CLI through every argument shape', () => {
  for (const runner of PACKAGE_RUNNERS) {
    assert.equal(
      isDestructiveWorkspaceCommand(runner, ['-y', 'syncrona', 'push']),
      true,
      `${runner} -y syncrona push must be destructive`
    );
    // Scan-from-the-right: a `--package <name>` value must not shadow the binary
    // token that actually precedes the subcommand.
    assert.equal(
      isDestructiveWorkspaceCommand(runner, ['--package', 'syncrona', 'syncrona', 'push']),
      true,
      `${runner} --package syncrona syncrona push must be destructive`
    );
    // A version or dist-tag suffix is stripped before the package lookup.
    assert.equal(
      isDestructiveWorkspaceCommand(runner, ['syncrona@1.2.3', 'push']),
      true,
      `${runner} syncrona@1.2.3 push must be destructive`
    );
  }
});

test('every CLI package name is recognized as the CLI binary and as a runner argument', () => {
  for (const name of CLI_PACKAGE_NAMES) {
    assert.equal(
      isDestructiveWorkspaceCommand(name, ['push']),
      true,
      `${name} push must be destructive`
    );
    assert.equal(
      isDestructiveWorkspaceCommand('npx', [name, 'push']),
      true,
      `npx ${name} push must be destructive`
    );
    // A Windows launcher extension is stripped before the lookup.
    assert.equal(
      isDestructiveWorkspaceCommand(`${name}.cmd`, ['push']),
      true,
      `${name}.cmd push must be destructive`
    );
  }
});

test('every dry-run-aware tool reports an honest effective dry run', () => {
  for (const toolName of DRY_RUN_AWARE_TOOLS) {
    assert.equal(toolImplementsDryRun(toolName), true, `${toolName} must honor dryRun`);
    assert.equal(
      isEffectiveDryRun(toolName, { dryRun: true }),
      true,
      `${toolName} dryRun:true must be an effective dry run`
    );
    assert.equal(
      isEffectiveDryRun(toolName, { dryRun: false }),
      false,
      `${toolName} dryRun:false must not be a dry run`
    );
  }
  // A tool that does not branch on dryRun must never be recorded as simulated,
  // however the caller asks — that was the REV-151 forensic-divergence bug.
  assert.equal(toolImplementsDryRun('sn_query_table'), false);
  assert.equal(isEffectiveDryRun('sn_query_table', { dryRun: true }), false);
});

test('every git help option that hands its argument to a viewer confirms', () => {
  for (const option of GIT_HELP_DANGEROUS_OPTIONS) {
    assert.equal(
      requiresConfirmation('git', ['help', option]),
      true,
      `git help ${option} must require confirmation`
    );
  }
  // Clustered short form is caught too: every letter of the cluster is checked.
  assert.equal(requiresConfirmation('git', ['help', '-wq']), true);
  // The same flags are ordinary read-only options for other verbs, which is why
  // they are gated per verb rather than globally.
  assert.equal(requiresConfirmation('git', ['diff', '-w']), false);
  assert.equal(requiresConfirmation('git', ['grep', '-i', 'needle']), false);
  assert.equal(requiresConfirmation('git', ['log', '-m']), false);
});

// --- Fail-CLOSED tables: a dropped entry breaks a read-only workflow -------

test('every allowlisted read-only command runs unconfirmed', () => {
  for (const command of READONLY_ALLOWLIST) {
    assert.equal(requiresConfirmation(command, []), false, `${command} must not confirm`);
  }
  // Contrast: the interpreters and wrappers the old denylist missed.
  for (const command of ['node', 'python3', 'perl', 'ruby', 'php', 'env', 'find', 'xargs']) {
    assert.equal(requiresConfirmation(command, []), true, `${command} must confirm`);
  }
  // An allowlisted NAME carrying a path separator is a caller-chosen executable,
  // not the PATH-resolved binary, so it confirms (REV-141).
  for (const command of READONLY_ALLOWLIST) {
    assert.equal(requiresConfirmation(`./${command}`, []), true, `./${command} must confirm`);
    assert.equal(
      requiresConfirmation(`C:\\tmp\\${command}`, []),
      true,
      `C:\\tmp\\${command} must confirm`
    );
  }
});

test('every read-only git subcommand runs unconfirmed', () => {
  for (const verb of GIT_READONLY_SUBCOMMANDS) {
    assert.equal(requiresConfirmation('git', [verb]), false, `git ${verb} must not confirm`);
    // The verb is lowercased before the lookup.
    assert.equal(
      requiresConfirmation('git', [verb.toUpperCase()]),
      false,
      `git ${verb.toUpperCase()} must not confirm`
    );
  }
  // Contrast: writers, sub-moded verbs and aliases all confirm (default-deny).
  const confirming = [
    'commit', 'push', 'pull', 'fetch', 'clone', 'checkout', 'switch', 'branch',
    'reset', 'rebase', 'merge', 'stash', 'config', 'remote', 'gc', 'prune',
    'worktree', 'submodule', 'filter-branch', 'update-ref', 'apply', 'am',
    'revert', 'cherry-pick', 'tag', 'init', 'add', 'rm', 'mv', 'notes', 'reflog',
    'bisect', 'my-alias',
  ];
  for (const verb of confirming) {
    assert.equal(requiresConfirmation('git', [verb]), true, `git ${verb} must confirm`);
  }
});

test('every safe git main option runs unconfirmed before a read-only verb', () => {
  for (const option of GIT_SAFE_MAIN_OPTIONS) {
    assert.equal(
      requiresConfirmation('git', [option, 'status']),
      false,
      `git ${option} status must not confirm`
    );
    assert.equal(requiresConfirmation('git', [option]), false, `git ${option} must not confirm`);
  }
  // Contrast: every main option that names a program, a repository or a config
  // value confirms — including `--git-dir`, which IS safe as a rev-parse query
  // AFTER the subcommand but is a repository redirect before it.
  const confirming = [
    '-C', '--git-dir', '--work-tree', '--namespace', '--super-prefix', '--exec-path',
    '--exec-path=/tmp/evil', '-c', '--config-env', '--bare', '--paginate', '-p',
  ];
  for (const option of confirming) {
    assert.equal(
      requiresConfirmation('git', [option, 'status']),
      true,
      `git ${option} status must confirm`
    );
  }
  assert.equal(requiresConfirmation('git', ['rev-parse', '--git-dir']), false);
});

test('every safe git subcommand option runs unconfirmed after a read-only verb', () => {
  for (const option of GIT_SAFE_SUBCOMMAND_OPTIONS) {
    assert.equal(
      requiresConfirmation('git', ['log', option]),
      false,
      `git log ${option} must not confirm`
    );
    // The `--name=value` spelling resolves to the same option name.
    assert.equal(
      requiresConfirmation('git', ['log', `${option}=value`]),
      false,
      `git log ${option}=value must not confirm`
    );
  }
  // Contrast: the flags that run a program or clobber a path (REV-140).
  for (const option of ['--upload-pack', '--output', '--output=/etc/victim', '--ext-diff']) {
    assert.equal(
      requiresConfirmation('git', ['ls-remote', option]),
      true,
      `git ls-remote ${option} must confirm`
    );
  }
});

test('every safe git short flag runs unconfirmed, and held-out uppercase flags confirm', () => {
  for (const flag of GIT_SAFE_SHORT_FLAGS) {
    assert.equal(
      requiresConfirmation('git', ['log', `-${flag}`]),
      false,
      `git log -${flag} must not confirm`
    );
  }
  for (const flag of GIT_UNSAFE_SHORT_FLAGS) {
    assert.equal(
      requiresConfirmation('git', ['log', `-${flag}`]),
      true,
      `git log -${flag} must confirm`
    );
    // And behind a safe letter in a cluster — every letter is checked (REV-191).
    assert.equal(
      requiresConfirmation('git', ['grep', `-n${flag}touch /tmp/PWN`, 'needle']),
      true,
      `git grep -n${flag}… must confirm`
    );
  }
  // An attached value that begins with a non-letter ends the cluster, so ordinary
  // spellings are unaffected.
  for (const token of ['-5', '-n5', '-L10,20', '-S=text']) {
    assert.equal(
      requiresConfirmation('git', ['log', token]),
      false,
      `git log ${token} must not confirm`
    );
  }
});

test('a --no- negation is safe exactly when the positive option is', () => {
  for (const option of ['--color', '--patch', '--follow', '--merges']) {
    assert.equal(
      requiresConfirmation('git', ['log', `--no-${option.slice(2)}`]),
      false,
      `git log --no-${option.slice(2)} must not confirm`
    );
  }
  // Negating an option the allowlist does not hold is still not allowlisted, and
  // `--no-` on nothing at all resolves to the empty option name, which no table
  // holds either. Both must fall through to the default-deny branch.
  assert.equal(requiresConfirmation('git', ['log', '--no-upload-pack']), true);
  assert.equal(requiresConfirmation('git', ['log', '--no-']), true);
});
