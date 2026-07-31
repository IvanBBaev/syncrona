// SPDX-License-Identifier: GPL-3.0-or-later
//
// Mutation-driven contract tests for the PARSING logic of src/safetyPolicy.ts —
// the companion to safetyPolicy.tableCompleteness.test.js, which covers the tables.
//
// WHY THIS FILE EXISTS
// Re-measuring safetyPolicy.ts after the table-completeness suite landed moved the
// mutation score from 63.14% to 94.90% (985 killed / 53 survived). Emptying a table
// entry was no longer survivable, so what remained was a different shape: mutants of
// the code that DECIDES WHICH TABLE TO CONSULT. Every case below was read off that
// survivor list, and each one is a security decision that no test pinned:
//
//   * how an invocation is recognised as reaching the CLI at all (a package runner
//     `npx syncrona push` vs. a package manager `npm exec syncrona push` vs. a
//     manager subcommand that is not exec at all, `npm install syncrona`);
//   * where the CLI package token sits in argv, and what happens when it is absent;
//   * which spelling of a per-verb dangerous git option is recognised;
//   * whether an option that merely LOOKS like a safe one is treated as safe;
//   * whether a caller-supplied budget override is trusted.
//
// A survivor here fails OPEN in most cases — a mutating invocation stops being
// recognised as mutating and runs without confirmation.
//
// WHAT IS DELIBERATELY NOT HERE: the survivors that are EQUIVALENT mutants, i.e.
// source edits that cannot change behaviour, so no test can kill them. Chasing them
// would mean writing assertions that pass for the wrong reason. They are listed at
// the bottom of this file with the argument for why each is unreachable, so the next
// person to read a survivor list does not re-litigate them.

const test = require("node:test");
const assert = require("node:assert/strict");

const {
  isDestructiveWorkspaceCommand,
  requiresConfirmation,
  evaluateMinimalFootprint,
  getApprovalRequirements,
  isApprovalSatisfied,
} = require("../dist/safetyPolicy.js");

// ---------------------------------------------------------------------------
// Reaching the CLI: binary normalisation
// ---------------------------------------------------------------------------

test("a whitespace-padded binary name still resolves to the runner", () => {
  // normalizeBinaryName trims before taking the basename. Without that trim the
  // base is " npx " rather than "npx", no package runner matches, cliOperands
  // returns null, and `syncrona push` is no longer seen as mutating at all.
  assert.equal(isDestructiveWorkspaceCommand(" npx ", ["syncrona", "push"]), true);
  assert.equal(isDestructiveWorkspaceCommand("npx\t", ["syncrona", "deploy"]), true);
});

test("only a TRAILING launcher extension is stripped from a binary name", () => {
  // The `.cmd|.exe|.bat|.ps1` strip is anchored at the end on purpose. Unanchored,
  // it would delete the substring wherever it appears — and "gi.exet" would collapse
  // to "git", handing an arbitrary attacker-named executable git's allowlisted,
  // read-only-verb treatment. Anchored, it is simply not on the allowlist.
  assert.equal(requiresConfirmation("gi.exet", ["status"]), true);
  assert.equal(requiresConfirmation("git.exe", ["status"]), false, "a real launcher suffix still strips");
});

// ---------------------------------------------------------------------------
// Reaching the CLI: runners vs. managers
// ---------------------------------------------------------------------------

test("a package MANAGER only reaches the CLI through an exec-style subcommand", () => {
  // `npm exec syncrona push` runs the CLI; `npm install syncrona` merely installs it
  // and runs nothing. Treating every manager subcommand as exec would report an
  // install as a destructive instance operation.
  assert.equal(isDestructiveWorkspaceCommand("npm", ["exec", "syncrona", "push"]), true);
  assert.equal(isDestructiveWorkspaceCommand("npm", ["install", "syncrona"]), false);
  assert.equal(isDestructiveWorkspaceCommand("npm", ["ci", "syncrona", "push"]), false);
});

test("an unknown binary is neither a runner nor a manager", () => {
  // If an unrecognised base name fell through to the manager branch, any wrapper
  // could be made to look like it invokes the CLI — or, worse, a real CLI
  // invocation behind an unknown wrapper would be parsed with the wrong grammar.
  assert.equal(isDestructiveWorkspaceCommand("foo", ["run", "syncrona", "push"]), false);
  assert.equal(isDestructiveWorkspaceCommand("definitely-not-npx", ["syncrona", "push"]), false);
});

test("a manager invocation with no operand at all is handled, not crashed", () => {
  // firstOperandIndex returns -1 when every token is a flag. Indexing argv with that
  // -1 yields undefined and calling .toLowerCase() on it throws — a TypeError raised
  // inside the safety policy, which is the gate failing rather than answering.
  assert.equal(isDestructiveWorkspaceCommand("npm", ["-v"]), false);
  assert.equal(isDestructiveWorkspaceCommand("npm", ["--version", "--silent"]), false);
  assert.equal(isDestructiveWorkspaceCommand("npm", []), false);
});

// ---------------------------------------------------------------------------
// Reaching the CLI: locating the package token in argv
// ---------------------------------------------------------------------------

test("no CLI package token in argv means the invocation does not reach the CLI", () => {
  // The scan starts at -1 precisely so that "not found" stays negative and the
  // parse bails out. Seeded with a non-negative index instead, an unrelated command
  // whose argv merely CONTAINS the word "push" is reported as a destructive CLI run.
  assert.equal(isDestructiveWorkspaceCommand("npx", ["push"]), false);
  assert.equal(isDestructiveWorkspaceCommand("npx", ["eslint", "push", "--dry-run"]), false);
  assert.equal(isDestructiveWorkspaceCommand("npx", ["eslint", "."]), false);
});

test("operands are taken from after the CLI token, not from the end of argv", () => {
  // Scanning right-to-left finds the binary token that actually precedes the
  // subcommand (so `npx --package syncrona syncrona push` works), but the operand
  // region is everything AFTER it. Anchoring the index at the last token instead
  // would slice an empty operand list and silently clear the subcommand.
  assert.equal(isDestructiveWorkspaceCommand("npx", ["syncrona", "push", "extra"]), true);
  assert.equal(isDestructiveWorkspaceCommand("npx", ["--package", "syncrona", "syncrona", "push"]), true);
  assert.equal(isDestructiveWorkspaceCommand("npx", ["-y", "syncrona", "deploy"]), true);
});

// ---------------------------------------------------------------------------
// git: per-verb dangerous options
// ---------------------------------------------------------------------------

test("every spelling of a per-verb dangerous git option confirms", () => {
  // `git help -w` opens a browser through web.browser; `-m`/`-i` hand the argument
  // to man/info. Each has a long spelling that reaches exactly the same code, and
  // only the short ones were pinned — so the long form of a browser-launching flag
  // could be dropped from the table without a single test noticing.
  for (const option of ["-w", "--web", "-m", "--man", "-i", "--info"]) {
    assert.equal(requiresConfirmation("git", ["help", option]), true, `git help ${option}`);
  }
  // The same flags are ordinary read-only options for other verbs, which is why the
  // table is keyed per verb rather than applied globally.
  assert.equal(requiresConfirmation("git", ["diff", "-w"]), false);
  assert.equal(requiresConfirmation("git", ["grep", "-i", "needle"]), false);
});

test("an unknown long git option is not made safe by embedding a safe one", () => {
  // The `--no-<x>` rule negates a boolean by re-checking `--<x>` against the
  // allowlist. Losing its prefix guard turns that into "strip five characters and
  // look it up", so `--abcstat` would be accepted on the strength of `--stat`.
  assert.equal(requiresConfirmation("git", ["log", "--abcstat"]), true);
  assert.equal(requiresConfirmation("git", ["log", "--no-color"]), false, "a real --no- negation is safe");
});

test("a numeric git count is recognised only as a whole token", () => {
  // `git log -5` is a count, not an option name — but the pattern is anchored at
  // both ends. Unanchored at the front, ANY short-flag cluster ending in a digit
  // would be waved through, and `-O` (--open-files-in-pager) EXECUTES its value:
  // `git grep -O9 …` would become a green light for arbitrary code execution.
  assert.equal(requiresConfirmation("git", ["log", "-5"]), false);
  assert.equal(requiresConfirmation("git", ["grep", "-O", "x"]), true);
  assert.equal(requiresConfirmation("git", ["grep", "-O9", "x"]), true);
});

test("git's end-of-options separator stops the subcommand walk", () => {
  // After `--` there is no subcommand and nothing that follows carries option
  // meaning, so the walk stops and answers "no confirmation needed". Removing that
  // stop would make the walk read a pathspec as if it were an injected main option.
  assert.equal(requiresConfirmation("git", ["--", "--exec-path=/x"]), false);
  assert.equal(requiresConfirmation("git", ["--exec-path=/x"]), true, "without the separator it is injection");
});

// ---------------------------------------------------------------------------
// Caller-supplied budgets
// ---------------------------------------------------------------------------

test("a non-numeric budget override falls back to the default", () => {
  // The override reaches this function from a model-supplied tool argument, so its
  // declared type guarantees nothing. Trusting a string would put it straight into
  // Math.floor — "1" would silently become a budget of 1, and a NaN-producing value
  // would neuter the comparison entirely.
  const changes = [{ filePath: "a" }, { filePath: "b" }];
  const withJunk = evaluateMinimalFootprint(changes, { maxFiles: "1" });
  assert.equal(withJunk.budget.maxFiles, 5);
  assert.equal(withJunk.withinBudget, true);

  const withNaN = evaluateMinimalFootprint(changes, { maxFiles: Number.NaN });
  assert.equal(withNaN.budget.maxFiles, 5);
  const withInfinity = evaluateMinimalFootprint(changes, { maxFiles: Number.POSITIVE_INFINITY });
  assert.equal(withInfinity.budget.maxFiles, 5);
  const withNegative = evaluateMinimalFootprint(changes, { maxFiles: -1 });
  assert.equal(withNegative.budget.maxFiles, 5);
});

test("a budget override of zero is honoured, not treated as unusable", () => {
  // Zero is a legitimate budget — "this change may touch no files" — and it is the
  // boundary between the rejected negatives and the accepted positives. Rejecting
  // it as unusable would replace the strictest possible budget with the default,
  // i.e. loosen the gate exactly where a caller asked to tighten it.
  const result = evaluateMinimalFootprint([{ filePath: "a" }, { filePath: "b" }], { maxFiles: 0 });
  assert.equal(result.budget.maxFiles, 0);
  assert.equal(result.withinBudget, false);
  assert.deepEqual(result.violations, ["changedFiles exceeds budget (2/0)"]);
});

test("a non-numeric estimatedLines contributes nothing to the line count", () => {
  // Same untrusted-input argument on the metric side. Math.floor("5") is 5, so
  // dropping the type guard would let a string inflate — or, with a NaN-producing
  // value, poison — the total that the budget is compared against.
  assert.equal(
    evaluateMinimalFootprint([{ filePath: "a", estimatedLines: "5" }]).metrics.changedLines,
    0
  );
  assert.equal(
    evaluateMinimalFootprint([{ filePath: "a", estimatedLines: Number.NaN }]).metrics.changedLines,
    0
  );
  assert.equal(
    evaluateMinimalFootprint([{ filePath: "a", estimatedLines: 5 }]).metrics.changedLines,
    5
  );
});

// ---------------------------------------------------------------------------
// Approval requirements: the fail-safe default
// ---------------------------------------------------------------------------

test("an unrecognised risk level requires approval rather than skipping it", () => {
  // riskLevel is typed, but it is parsed from a tool argument, and the switch has no
  // exhaustiveness check at runtime. The default branch deliberately mirrors the
  // "medium" requirement so an unknown level fails CLOSED. This assertion cannot be
  // killed by a mutant (see the equivalence note below) — it pins the intent.
  assert.deepEqual(getApprovalRequirements("nope"), {
    required: true,
    minimumApprovers: 1,
    roles: ["reviewer"],
  });
  assert.equal(isApprovalSatisfied({}, "nope"), false);
  assert.equal(isApprovalSatisfied({ approvalId: "A-1", approvers: ["x"] }, "nope"), true);
});

// ---------------------------------------------------------------------------
// EQUIVALENT MUTANTS — surviving, and correctly so
// ---------------------------------------------------------------------------
//
// Each of these is a mutation of safetyPolicy.ts that no test can kill, because the
// mutated source cannot produce different behaviour. They are recorded so the next
// survivor list is read in a minute rather than an afternoon.
//
//   asRecord's non-object guard. Its only call site passes the return value of
//     getApprovalRequirements, whose switch has a `default` branch, so it always
//     receives an object. The guard is defence in depth against a future caller.
//
//   `case "medium"` in getApprovalRequirements. The `default` branch returns a
//     structurally identical object, so removing the case changes nothing. That is
//     the fail-safe design, not an oversight — asserted directly above.
//
//   The `minimumApprovers` fallback in isApprovalSatisfied. Same reason: every
//     branch of the switch sets it to a number, so the `: 1` arm is unreachable.
//
//   The `token === "--"` checks in operandsOf and firstOperandIndex. `--` also
//     starts with `-`, so the general flag check that follows already skips it.
//
//   packageNameOf's `at > 0` guard and its .trim(). CLI_PACKAGE_NAMES holds one
//     bare name with no `@`, and every token reaching it was trimmed by the caller.
//     Both would become killable the moment a scoped package name is added.
//
//   The `eq >= 0` split in isSafeGitSubcommandOption. It is only ever called with a
//     token starting with `-`, so indexOf("=") can never be 0.
//
//   The `arg === "-"` check in the subcommand walk. A bare `-` reaches
//     isSafeGitSubcommandOption as an empty flag cluster and is judged safe anyway.
//
//   requiresConfirmation's outer .trim(). normalizeBinaryName trims again, and the
//     path-separator test that runs in between is unaffected by surrounding space.
//
//   The `.trim()`/`""`/array fallbacks in isDestructiveWorkspaceInvocation. Every
//     junk value they guard against also fails to resolve to a CLI package token,
//     so the answer is false either way.
//
//   `>` vs `>=` in maxRiskLevel. Ranks are unique per level, so an equal-rank
//     replacement assigns the value that is already there.
//
//   The unanchored/partial variants of the `-\d+` count pattern other than the one
//     asserted above: a token whose cluster starts with a digit already returns
//     early at the first non-letter, so widening the pattern there changes nothing.
