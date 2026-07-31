// SPDX-License-Identifier: GPL-3.0-or-later
import path from "node:path";

export type RiskLevel = "low" | "medium" | "high" | "critical";

type MinimalFootprintBudget = {
  maxFiles: number;
  maxLines: number;
  maxObjects: number;
};

type MinimalFootprintMetrics = {
  changedFiles: number;
  changedLines: number;
  changedObjects: number;
};

const DEFAULT_MINIMAL_FOOTPRINT_BUDGET: MinimalFootprintBudget = {
  maxFiles: 5,
  maxLines: 200,
  maxObjects: 10,
};

// Upper bound for a caller-supplied budget. Anything larger is treated as an
// attempt (deliberate or accidental) to disable the minimal-footprint gate.
const MAX_MINIMAL_FOOTPRINT_BUDGET = 10_000;

const BLOCKED_COMMANDS = new Set([
  "rm",
  "sudo",
  "dd",
  "mkfs",
  "shutdown",
  "reboot",
  "killall",
  "pkill",
]);

const BLOCKED_SHELL_INTERPRETERS = new Set(["bash", "sh", "zsh", "fish"]);
const BLOCKED_SHELL_TOKENS = ["&&", "||", ";", "|", "`", "$(", ">", "<"];

// CLI subcommands that mutate the connected ServiceNow instance and therefore
// require confirmDestructive when reached through run_workspace_command.
const DESTRUCTIVE_CLI_SUBCOMMANDS = new Set(["push", "deploy", "download"]);
// npm identifiers that resolve to the CLI (see packages/core/package.json).
const CLI_PACKAGE_NAMES = new Set(["syncrona"]);
// Runners that take the package name as their first non-flag argument.
const PACKAGE_RUNNERS = new Set(["npx", "pnpx", "bunx"]);
// Package managers whose exec-style subcommand is followed by the package name.
const PACKAGE_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);
const PACKAGE_MANAGER_EXEC_SUBCOMMANDS = new Set(["exec", "dlx", "run"]);

// Tools whose mutating-ness is decided per invocation rather than by name.
const ARGS_DEPENDENT_MUTATING_TOOLS = new Set(["run_workspace_command"]);

const MUTATING_TOOLS = new Set([
  "sync_set_scope",
  "sync_set_update_set",
  "sync_prepare_session",
  "sync_push",
  "sn_create_record",
  "sn_execute_background_script",
  "sync_create_script_include",
  "sync_create_script_include_and_sync",
  "sn_update_metadata_record",
  "sn_autonomous_remediation_workflow",
  "sync_unified_change_workflow",
  // Triggers ATF execution via a background script — a side effect on the
  // instance — so it must go through the same preflight/audit/confirm gates.
  "sync_run_atf_tests",
]);

// SEC-6 follow-up (REV-151): tools whose handler actually BRANCHES on `dryRun` and returns
// a plan instead of doing the work. The audit record and the semantic-index invalidation
// used to read `args.dryRun === true` as proof that nothing happened — but that is only a
// REQUEST. On a tool that ignores the flag (as run_workspace_command, run_node_code and
// sync_unified_change_workflow all did before REV-149/REV-150) the run was real while the
// audit trail claimed a simulation and the stale-index invalidation was skipped, so the
// forensic record and the workspace state both silently diverged from reality. Deriving
// from this list keeps that class of bug from re-appearing when a new tool is added: a tool
// that is not listed is treated as having executed for real, which is the safe default.
const DRY_RUN_AWARE_TOOLS = new Set([
  "sync_set_scope",
  "sync_set_update_set",
  "sync_prepare_session",
  "sync_push",
  "run_workspace_command",
  "run_node_code",
  "sn_create_record",
  "sn_execute_background_script",
  "sync_create_script_include",
  "sync_create_script_include_and_sync",
  "sn_update_metadata_record",
  "sn_autonomous_remediation_workflow",
  "sync_unified_change_workflow",
  "sync_run_atf_tests",
  // SEC-3 follow-up (REV-195): these four declare `dryRun` in their public input
  // schema AND branch on it (scopeKnowledgeHandlers.ts:252, :407, :458, :507), but
  // were never added here — so isEffectiveDryRun said false and auditToolCall stamped
  // `dryRun: false` on a run that wrote nothing. A forensic reader saw a real write
  // where a simulation happened. dryRunAwareTools.contract.test.js now derives the
  // expected membership from the tool schemas, so this list cannot drift again.
  "sync_generate_scope_knowledge",
  "sync_generate_scope_docs",
  "sync_scope_knowledge_auto_update",
  "sync_generate_table_dependency_report",
]);

/** True when `toolName`'s handler honors `dryRun` (i.e. dryRun really means "did nothing"). */
export function toolImplementsDryRun(toolName: string): boolean {
  return DRY_RUN_AWARE_TOOLS.has(toolName);
}

/** True when this invocation asked for a dry run AND the tool actually honors it. */
export function isEffectiveDryRun(
  toolName: string,
  args?: Record<string, unknown>
): boolean {
  return !!args && args.dryRun === true && toolImplementsDryRun(toolName);
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }
  return value as Record<string, unknown>;
}

function hasUnsafeShellArg(args: string[]): boolean {
  return args.some((arg) => arg === "-c" || arg === "--command");
}

function commandBaseName(command: string): string {
  // Strip any leading directory so a path to a blocked binary ("/bin/rm",
  // "..\\rm", "./sudo") is still recognised — an exact-string blocklist alone
  // is trivially bypassed by qualifying the command. Handle both separators
  // regardless of host OS, and drop surrounding whitespace.
  const normalized = command.trim().replace(/\\/g, "/");
  return normalized.slice(normalized.lastIndexOf("/") + 1);
}

/** Basename of an executable path, without a Windows launcher extension. */
function normalizeBinaryName(value: string): string {
  const base = path.basename(value.trim().replace(/\\/g, "/")).toLowerCase();
  return base.replace(/\.(cmd|exe|bat|ps1)$/, "");
}

/** Strips a version or dist-tag suffix: `syncrona@1.2.3` -> `syncrona`. */
function packageNameOf(token: string): string {
  const normalized = token.trim().toLowerCase();
  const at = normalized.lastIndexOf("@");
  return at > 0 ? normalized.slice(0, at) : normalized;
}

function isCliPackageToken(token: string): boolean {
  return CLI_PACKAGE_NAMES.has(packageNameOf(token));
}

/** Every token that is not a flag (and not the `--` separator), lowercased. */
function operandsOf(tokens: string[]): string[] {
  const operands: string[] = [];
  for (const token of tokens) {
    if (token === "--") {
      continue;
    }
    if (token.startsWith("-")) {
      continue;
    }
    operands.push(token.toLowerCase());
  }
  return operands;
}

/** Index of the first operand in `tokens`, or -1. */
function firstOperandIndex(tokens: string[]): number {
  return tokens.findIndex((token) => token !== "--" && !token.startsWith("-"));
}

/**
 * The operand region of an invocation that reaches the CLI, or null when the
 * invocation does not reach the CLI at all. Parsed structurally rather than by
 * free-text substring search: the binary is `syncrona`, so a phrase like
 * "sync push" never occurs in a real invocation and matching it gates nothing.
 */
function cliOperands(command: string, args: string[]): string[] | null {
  const base = normalizeBinaryName(command);
  const tokens = args.map((token) => token.trim()).filter((token) => token.length > 0);

  if (isCliPackageToken(base)) {
    return operandsOf(tokens);
  }

  let rest: string[] | null = null;
  if (PACKAGE_RUNNERS.has(base)) {
    rest = tokens;
  } else if (PACKAGE_MANAGERS.has(base)) {
    // Index first, then lowercase: `tokens.indexOf(lowercased)` missed a
    // mixed-case `Run`/`EXEC` token and sliced from -1, re-scanning the whole argv.
    const at = firstOperandIndex(tokens);
    const first = at >= 0 ? (tokens[at] as string).toLowerCase() : null;
    if (first && PACKAGE_MANAGER_EXEC_SUBCOMMANDS.has(first)) {
      rest = tokens.slice(at + 1);
    }
  }
  if (!rest) {
    return null;
  }

  // `npx --package syncrona syncrona push` and `npx -y syncrona push` both reach
  // the CLI: locate the package token, then take the following operands. Scan from
  // the right so a `--package syncrona` value does not shadow the binary token
  // that actually precedes the subcommand.
  let cliIndex = -1;
  for (let i = rest.length - 1; i >= 0; i -= 1) {
    const token = rest[i];
    if (token !== undefined && isCliPackageToken(token)) {
      cliIndex = i;
      break;
    }
  }
  if (cliIndex < 0) {
    return null;
  }
  return operandsOf(rest.slice(cliIndex + 1));
}

/**
 * Resolves the CLI subcommand an invocation would most likely run, or null when
 * the invocation does not reach the CLI at all.
 *
 * Best-effort by construction: yargs registers the shared options per command, so
 * the subcommand is normally the first operand — but a space-separated global
 * option value (`syncrona --logLevel debug push`) occupies that position instead.
 * Use {@link isDestructiveWorkspaceCommand} for any security decision; it does not
 * depend on picking the right operand.
 */
export function findSyncroCliSubcommand(command: string, args: string[]): string | null {
  const operands = cliOperands(command, args);
  if (operands === null) {
    return null;
  }
  return operands[0] ?? null;
}

/**
 * True when the invocation runs a CLI subcommand that mutates the instance.
 *
 * Checks EVERY operand, not just the first. Resolving "the" subcommand means
 * knowing which tokens are option values, and that is a per-option question:
 * `--logLevel debug push`, `--instance-profile dev push` and `-d main push` all
 * put a value where the first operand would be, and all three really run push
 * (verified against the CLI's yargs registration). Deciding the gate on the first
 * operand therefore reported `requiresConfirmation === false` for a live push to a
 * ServiceNow instance. An enumeration of the value-taking options would re-open
 * every time the CLI grows one, so this is default-deny in the same way the git
 * option regions are: any destructive verb anywhere in the operand region confirms.
 * The cost is over-confirming a read-only command that happens to take
 * "push"/"deploy"/"download" as a positional argument, which is the safe direction.
 */
export function isDestructiveWorkspaceCommand(command: string, args: string[]): boolean {
  const operands = cliOperands(command, args);
  if (operands === null) {
    return false;
  }
  return operands.some((operand) => DESTRUCTIVE_CLI_SUBCOMMANDS.has(operand));
}

// REV-83 (SEC-2): read-only command allowlist for run_workspace_command.
//
// A base-name *denylist* (BLOCKED_COMMANDS) is the wrong model: every command
// not on it — node, python3, perl, ruby, php, env, find, xargs, timeout, nohup,
// setsid, and any other interpreter or wrapper — is implicitly allowed and can
// run arbitrary code unsandboxed, while the old confirmation gate only fired on
// a literal "syncrona push/deploy/download". Enumerate the known-safe read-only
// commands instead; everything else must be explicitly confirmed.
const READONLY_ALLOWLIST = new Set(["git", "ls", "cat", "pwd", "echo", "syncrona"]);

// SEC-2 follow-up (REV-194): git MAIN options (the region before the subcommand)
// that provably name no program, no repository and no file — each either prints and
// exits or flips an inert parsing mode. Everything else confirms.
//
// This region is default-deny for the same reason REV-124 made the verb list one and
// REV-140 made the post-subcommand region one: an enumeration of the flags known to be
// dangerous silently re-opens each time git grows a new one. It was the last region
// still running on the opposite model — REV-117's GIT_VALUE_OPTIONS merely SKIPPED the
// value of a redirect flag so the real subcommand could be found, then let the
// invocation through if that subcommand was read-only. The redirect itself is the
// vector, and read-only verbs are exactly where it lands:
//   --exec-path=<dir>   git resolves its helper binaries there, so
//                       `git --exec-path=/tmp/evil ls-remote https://host/r` executes
//                       /tmp/evil/git-remote-https. `ls-remote` is on the read-only
//                       verb list, so the old walk returned false.
//   -C <dir>, --git-dir, --work-tree, --namespace, --super-prefix
//                       point git at a repository the caller chose. run_workspace_command
//                       has no `cwd` input, so these flags are the only way to make git
//                       read an untrusted .git/config — whose core.fsmonitor (run by
//                       `status`), core.pager and alias.* entries git executes.
//   -c, --config-env    inline config injection, already always confirmed (REV-124)
//                       and kept so by the default-deny below rather than by a
//                       special case.
// Cost of the inversion: a legitimate `git -C ../other status` now needs
// confirmDestructive=true. That is a UX cost; the alternative is unconfirmed RCE.
const GIT_SAFE_MAIN_OPTIONS = new Set([
  "--version",
  "--html-path",
  "--man-path",
  "--info-path",
  "--no-pager",
  "-P",
  "--no-replace-objects",
  "--literal-pathspecs",
  "--no-literal-pathspecs",
  "--glob-pathspecs",
  "--noglob-pathspecs",
  "--icase-pathspecs",
  "--no-optional-locks",
]);

// SEC-2 (REV-124): the previous denylist of mutating verbs was unsound two ways.
// (1) A git ALIAS (`git -c alias.x='!sh -c …' x`) runs an arbitrary shell command
// under a subcommand name that is on no denylist, so it was never gated — an RCE.
// (2) The denylist enumerated only a handful of writers, so any mutating verb it did
// not list (switch, pull, branch, worktree, update-ref, filter-branch, gc, prune,
// fetch, submodule, config, …) also slipped through. Invert to an ALLOWLIST of
// unambiguously read-only verbs: anything not on it — every alias and every unlisted
// verb — requires confirmation. Keep it conservative; a verb with a mutating sub-mode
// (reflog, stash, notes, remote, config) is intentionally absent so it confirms.
const GIT_READONLY_SUBCOMMANDS = new Set([
  "status",
  "log",
  "show",
  "diff",
  "shortlog",
  "describe",
  "blame",
  "annotate",
  "grep",
  "ls-files",
  "ls-tree",
  "ls-remote",
  "cat-file",
  "rev-parse",
  "rev-list",
  "name-rev",
  "for-each-ref",
  "show-ref",
  "merge-base",
  "cherry",
  "whatchanged",
  "count-objects",
  "verify-commit",
  "verify-tag",
  "var",
  "version",
  "help",
]);

// SEC-2 follow-up (REV-140): options a read-only git verb accepts WITHOUT naming a
// program to run or a file to overwrite. The region after the subcommand is
// default-deny for the same reason the verb list is (REV-124): a denylist of the
// currently-known dangerous flags silently re-opens as git grows new ones. Anything
// not listed here confirms — over-confirming an exotic formatting flag is a UX cost,
// missing `--upload-pack` is arbitrary code execution.
const GIT_SAFE_SUBCOMMAND_OPTIONS = new Set([
  // Output / diff formatting
  "--oneline", "--pretty", "--format", "--abbrev-commit", "--abbrev", "--date",
  "--graph", "--decorate", "--decorate-refs", "--decorate-refs-exclude", "--color",
  "--color-words", "--stat", "--numstat", "--shortstat", "--dirstat", "--summary",
  "--compact-summary", "--patch", "--patch-with-stat", "--patch-with-raw", "--raw",
  "--name-only", "--name-status", "--word-diff", "--word-diff-regex", "--unified",
  "--inter-hunk-context", "--function-context", "--src-prefix", "--dst-prefix",
  "--prefix", "--line-prefix", "--relative", "--full-index", "--binary", "--check",
  "--ws-error-highlight", "--find-renames", "--renames", "--rename-empty",
  "--find-copies", "--find-copies-harder", "--find-object", "--break-rewrites",
  "--irreversible-delete", "--diff-filter", "--diff-algorithm", "--anchored",
  "--histogram", "--patience", "--minimal", "--indent-heuristic", "--ignore-all-space",
  "--ignore-space-change", "--ignore-space-at-eol", "--ignore-blank-lines",
  "--ignore-cr-at-eol", "--ignore-matching-lines", "--ignore-submodules", "--text",
  "--exit-code", "--quiet", "--cached", "--staged", "--merge-base", "--index",
  "--submodule", "--stat-width", "--stat-name-width", "--stat-count", "--pickaxe-all",
  "--pickaxe-regex", "--combined-all-paths", "--cc", "--diff-merges", "--remerge-diff",
  "--output-indicator-new", "--output-indicator-old", "--output-indicator-context",
  "--expand-tabs", "--encoding", "--progress", "--column", "--null", "--shell",
  "--perl", "--python", "--tcl", "--sq", "--sq-quote", "--omit-empty",
  // Revision selection / filtering
  "--all", "--branches", "--tags", "--remotes", "--glob", "--exclude",
  "--exclude-hidden", "--not", "--since", "--since-as-filter", "--after", "--until",
  "--before", "--author", "--committer", "--grep", "--grep-reflog", "--all-match",
  "--invert-grep", "--regexp-ignore-case", "--basic-regexp", "--extended-regexp",
  "--fixed-strings", "--perl-regexp", "--remove-empty", "--merges", "--min-parents",
  "--max-parents", "--first-parent", "--exclude-first-parent-only", "--ancestry-path",
  "--skip", "--max-count", "--max-age", "--min-age", "--reverse", "--topo-order",
  "--date-order", "--author-date-order", "--walk", "--do-walk", "--follow",
  "--full-history", "--full-diff", "--simplify-merges", "--simplify-by-decoration",
  "--sparse", "--dense", "--left-right", "--left-only", "--right-only", "--cherry",
  "--cherry-mark", "--cherry-pick", "--boundary", "--children", "--parents",
  "--show-signature", "--notes", "--show-notes", "--walk-reflogs", "--reflog",
  "--single-worktree", "--stdin", "--end-of-options", "--bisect", "--mailmap",
  "--use-mailmap", "--source", "--log-size", "--header", "--objects", "--missing",
  "--in-commit-order", "--object-names", "--disk-usage", "--filter", "--count",
  "--sort", "--points-at", "--merged", "--contains", "--exact-match", "--candidates",
  "--dirty", "--broken", "--always", "--long", "--short", "--match", "--debug",
  // Path / ref queries (rev-parse, ls-*, show-ref, cat-file, status, blame, …)
  "--verify", "--symbolic", "--symbolic-full-name", "--abbrev-ref", "--git-dir",
  "--git-common-dir", "--absolute-git-dir", "--show-toplevel", "--show-prefix",
  "--show-cdup", "--show-object-format", "--show-superproject-working-tree",
  "--is-inside-work-tree", "--is-bare-repository", "--is-inside-git-dir",
  "--is-shallow-repository", "--git-path", "--path-format", "--revs-only", "--revs",
  "--flags", "--default", "--local-env-vars", "--shared-index-path",
  "--resolve-git-dir", "--parseopt", "--keep-dashdash", "--stop-at-non-option",
  "--deleted", "--modified", "--others", "--ignored", "--stage", "--unmerged",
  "--killed", "--directory", "--empty-directory", "--exclude-standard",
  "--exclude-per-directory", "--exclude-from", "--error-unmatch", "--full-name",
  "--full-tree", "--object-only", "--recurse-submodules", "--eol", "--with-tree",
  "--deduplicate", "--heads", "--refs", "--get-url", "--symref", "--server-option",
  "--dereference", "--hash", "--exclude-existing", "--exists", "--batch",
  "--batch-check", "--batch-command", "--batch-all-objects", "--batch-size",
  "--buffer", "--follow-symlinks", "--unordered", "--allow-unknown-type",
  "--line-number", "--files-with-matches", "--files-without-match", "--word-regexp",
  "--invert-match", "--ignore-case", "--untracked", "--max-depth", "--context",
  "--after-context", "--before-context", "--heading", "--break", "--only-matching",
  "--show-function", "--threads", "--and", "--or", "--porcelain", "--line-porcelain",
  "--incremental", "--show-email", "--show-name", "--show-number", "--show-stats",
  "--root", "--score-debug", "--ignore-rev", "--ignore-revs-file", "--color-lines",
  "--color-by-age", "--contents", "--numbered", "--email", "--group", "--octopus",
  "--independent", "--is-ancestor", "--fork-point", "--verbose", "--human-readable",
  "--build-options", "--branch", "--show-stash", "--untracked-files",
  "--ahead-behind", "--annotate-stdin", "--undefined", "--guides", "--config",
  "--aliases", "--external-commands", "--include-root-refs",
]);

// SEC-2 follow-up (REV-140): short flags a read-only verb may carry. Every LOWERCASE
// letter is safe across these verbs (patterns, counts, ranges, formatting); of the
// uppercase ones only this set is — notably `-O` (git grep --open-files-in-pager)
// is absent because it EXECUTES its value.
const GIT_SAFE_SHORT_FLAGS = new Set([
  ..."abcdefghijklmnopqrstuvwxyz".split(""),
  "A", "B", "C", "E", "F", "G", "H", "I", "L", "M", "P", "R", "S", "U", "W",
]);

// SEC-2 follow-up (REV-140): a handful of flags are safe for most verbs but hand the
// argument to an external viewer for one specific verb (`git help -w` opens a browser
// via web.browser, `-m`/`-i` invoke man/info). `-w` and `-i` are ordinary read-only
// flags for diff/grep, so they are gated per verb instead of globally.
const GIT_VERB_DANGEROUS_OPTIONS = new Map<string, Set<string>>([
  ["help", new Set(["-w", "--web", "-m", "--man", "-i", "--info"])],
]);

/**
 * SEC-2 follow-up (REV-140): whether one post-subcommand token is a safe option.
 * Default-deny: unknown long options and unknown/uppercase short flags confirm.
 */
function isSafeGitSubcommandOption(verb: string, token: string): boolean {
  const eq = token.indexOf("=");
  const name = eq >= 0 ? token.slice(0, eq) : token;
  const dangerousForVerb = GIT_VERB_DANGEROUS_OPTIONS.get(verb);

  if (name.startsWith("--")) {
    if (dangerousForVerb && dangerousForVerb.has(name)) {
      return false;
    }
    if (GIT_SAFE_SUBCOMMAND_OPTIONS.has(name)) {
      return true;
    }
    // `--no-<x>` negates a boolean and is safe whenever `--<x>` is.
    return name.startsWith("--no-") && GIT_SAFE_SUBCOMMAND_OPTIONS.has(`--${name.slice(5)}`);
  }

  // `git log -5` and friends: a bare count is not an option name.
  if (/^-\d+$/.test(name)) {
    return true;
  }
  // SEC-2 follow-up (REV-191): this loop used to STOP at the first letter in a
  // GIT_SHORT_FLAGS_WITH_VALUE set, on the theory that the rest of the token is that
  // option's data rather than more flags. The theory is verb-dependent and therefore
  // unsound: `-n` takes a value for `log` but is the boolean --line-number for `grep`,
  // so `git grep -nOtouch\ /tmp/PWN hello` stopped at `n` and never saw the `-O`
  // (--open-files-in-pager) behind it, which EXECUTES its value. Verified against git
  // 2.50.1: the file was created while requiresConfirmation() returned false. Every
  // letter is checked now; a non-letter still ends the cluster, so ordinary attached
  // values (`-n5`, `-L10,20`, `-S'some text'`) are unaffected and the residual cost is
  // over-confirming a value that begins with an unusual uppercase letter (`-eDEBUG`).
  for (const ch of name.slice(1)) {
    if (!/[A-Za-z]/.test(ch)) {
      // Non-letter: the remainder is an attached value, not more flags.
      return true;
    }
    if (dangerousForVerb && dangerousForVerb.has(`-${ch}`)) {
      return false;
    }
    if (!GIT_SAFE_SHORT_FLAGS.has(ch)) {
      return false;
    }
  }
  return true;
}

// Inline config injection (`-c core.pager=…`, `-c core.sshCommand=…`, `-c alias.*`,
// `--config-env`) is an arbitrary-code-execution vector regardless of subcommand, so
// it ALWAYS confirms. It only carries that meaning as a MAIN option — BEFORE the
// subcommand — which is exactly the region this walk inspects; the same flag AFTER the
// subcommand (`git diff -c`, a combined-diff format option) is the subcommand's own and
// is not treated as injection. Returns true when the invocation must be confirmed.
function gitRequiresConfirmation(tokens: string[]): boolean {
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token === "--") {
      // End of options; nothing after this is a subcommand.
      return false;
    }
    if (token.startsWith("-")) {
      // SEC-2 follow-up (REV-194): default-deny (see GIT_SAFE_MAIN_OPTIONS). The
      // attached and detached spellings collapse into one rule — `--exec-path=/x`
      // and `--exec-path /x` are both simply "not on the allowlist" — so no option
      // needs its value skipped any more: the walk returns before reaching it.
      if (!GIT_SAFE_MAIN_OPTIONS.has(token)) {
        return true;
      }
      continue;
    }
    // First real operand = the subcommand. Confirm unless it is a known read-only
    // verb. Aliases are never on the allowlist, so an alias invocation confirms.
    const verb = token.toLowerCase();
    if (!GIT_READONLY_SUBCOMMANDS.has(verb)) {
      return true;
    }
    // SEC-2 follow-up (REV-140): the walk used to RETURN here, so a read-only verb's
    // OWN options were never examined — and several of them run a program or clobber
    // a file: `git ls-remote --upload-pack='touch /tmp/PWN' .` and
    // `git grep -Otouch\ /tmp/PWN hello` are arbitrary code execution, and
    // `git diff --output=/etc/victim HEAD` overwrites an arbitrary path. All three
    // passed the gate unconfirmed. Keep scanning; the region after the subcommand is
    // default-deny too (see GIT_SAFE_SUBCOMMAND_OPTIONS).
    for (let j = i + 1; j < tokens.length; j += 1) {
      const arg = tokens[j];
      if (arg === "--") {
        // Everything past `--` is a pathspec, not an option.
        return false;
      }
      if (!arg.startsWith("-") || arg === "-") {
        continue;
      }
      if (!isSafeGitSubcommandOption(verb, arg)) {
        return true;
      }
    }
    return false;
  }
  // Only global options / no subcommand (`git`, `git --version`): nothing to mutate.
  return false;
}

/**
 * REV-83 (SEC-2): whether a run_workspace_command invocation must be explicitly
 * confirmed (confirmDestructive=true). Default-deny — anything whose base name
 * is not on READONLY_ALLOWLIST requires confirmation, which covers every
 * interpreter and wrapper binary the old denylist missed. Allowlisted commands
 * still confirm for their mutating uses: a `syncrona push/deploy/download`, and
 * (REV-124) any git subcommand that is not a known read-only verb — plus any git
 * inline-config injection, which is an arbitrary-code-execution vector.
 */
export function requiresConfirmation(command: string, args: string[]): boolean {
  // SEC-2 follow-up (REV-141): the allowlist was matched on the BASENAME only, so any
  // executable that merely SHARES a name with an allowlisted one ran unconfirmed —
  // `./git status` or `/tmp/evil/git status` picks up an attacker-planted binary, not
  // the real git, and the gate approved it. Only a bare command name (which the OS
  // resolves through PATH) can be allowlisted; anything carrying a path separator is
  // a caller-chosen executable and must be confirmed.
  const raw = command.trim();
  if (raw.includes("/") || raw.includes("\\")) {
    return true;
  }
  const base = normalizeBinaryName(raw);
  if (!READONLY_ALLOWLIST.has(base)) {
    return true;
  }
  if (base === "syncrona") {
    return isDestructiveWorkspaceCommand(command, args);
  }
  if (base === "git") {
    return gitRequiresConfirmation(args);
  }
  return false;
}

/** Reads the run_workspace_command argument shape the dispatcher passes through. */
function isDestructiveWorkspaceInvocation(args: Record<string, unknown>): boolean {
  const command = typeof args.command === "string" ? args.command.trim() : "";
  if (!command) {
    return false;
  }
  const commandArgs = Array.isArray(args.args)
    ? args.args.filter((item): item is string => typeof item === "string")
    : [];
  return isDestructiveWorkspaceCommand(command, commandArgs);
}

/**
 * Whether a tool call mutates instance state. Most tools are decided by name
 * alone, but run_workspace_command runs whatever it is given — `syncrona push`
 * touches the instance while `npm test` does not — so its answer depends on the
 * invocation. Callers that audit an actual call pass `args` to get that
 * per-invocation answer; callers keyed on the tool name alone (such as the
 * preflight gate, which would otherwise force a live instance round-trip before
 * a purely local command) omit `args` and get the name-only answer.
 */
export function isMutatingTool(toolName: string, args?: Record<string, unknown>): boolean {
  if (MUTATING_TOOLS.has(toolName)) {
    return true;
  }
  if (!args || !ARGS_DEPENDENT_MUTATING_TOOLS.has(toolName)) {
    return false;
  }
  return isDestructiveWorkspaceInvocation(args);
}

export function isUnsafeWorkspaceCommand(command: string, args: string[]): boolean {
  const base = commandBaseName(command);
  if (BLOCKED_COMMANDS.has(base)) {
    return true;
  }

  if (BLOCKED_SHELL_INTERPRETERS.has(base) && hasUnsafeShellArg(args)) {
    return true;
  }

  for (const arg of args) {
    if (BLOCKED_SHELL_TOKENS.some((token) => arg.includes(token))) {
      return true;
    }
  }

  return false;
}

export function riskLevelFromScore(score: number): RiskLevel {
  if (score >= 10) {
    return "critical";
  }
  if (score >= 6) {
    return "high";
  }
  if (score >= 3) {
    return "medium";
  }
  return "low";
}

const RISK_LEVEL_RANK: Record<RiskLevel, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

// SEC-7 (REV-122): compose a caller-supplied risk level with the analyzer-computed
// one, always taking the HIGHER. A caller may RAISE the risk but must never be able
// to LOWER it below what the script analysis warrants.
export function maxRiskLevel(
  ...levels: Array<RiskLevel | null | undefined>
): RiskLevel {
  let best: RiskLevel = "low";
  for (const level of levels) {
    if (level && RISK_LEVEL_RANK[level] > RISK_LEVEL_RANK[best]) {
      best = level;
    }
  }
  return best;
}

export function parseRiskLevel(value: unknown): RiskLevel | null {
  if (typeof value !== "string") {
    return null;
  }
  const normalized = value.trim().toLowerCase();
  if (
    normalized === "low" ||
    normalized === "medium" ||
    normalized === "high" ||
    normalized === "critical"
  ) {
    return normalized;
  }
  return null;
}

export function getApprovalRequirements(riskLevel: RiskLevel): Record<string, unknown> {
  switch (riskLevel) {
    case "low":
      return {
        required: false,
        minimumApprovers: 0,
        roles: ["peer-review"],
      };
    case "medium":
      return {
        required: true,
        minimumApprovers: 1,
        roles: ["reviewer"],
      };
    case "high":
      return {
        required: true,
        minimumApprovers: 2,
        roles: ["reviewer", "owner"],
      };
    case "critical":
      return {
        required: true,
        minimumApprovers: 2,
        roles: ["owner", "change-manager"],
      };
    default:
      return {
        required: true,
        minimumApprovers: 1,
        roles: ["reviewer"],
      };
  }
}

export function isApprovalSatisfied(
  approval: Record<string, unknown>,
  riskLevel: RiskLevel
): boolean {
  const requirements = asRecord(getApprovalRequirements(riskLevel));
  const required = requirements.required === true;
  if (!required) {
    return true;
  }

  const approvalId = typeof approval.approvalId === "string" ? approval.approvalId.trim() : "";
  if (!approvalId) {
    return false;
  }

  const approvers = Array.isArray(approval.approvers)
    ? approval.approvers.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
    : [];
  const minimumApprovers =
    typeof requirements.minimumApprovers === "number" ? requirements.minimumApprovers : 1;
  return approvers.length >= minimumApprovers;
}

export function validateRollbackEvidence(
  evidence: Record<string, unknown>,
  riskLevel: RiskLevel
): { ok: boolean; missing: string[] } {
  const mustHaveReason = riskLevel === "high" || riskLevel === "critical";
  const requiredFields = mustHaveReason
    ? ["reason", "impactedEntities", "revertSteps", "validationPlan"]
    : ["revertSteps"];

  const missing: string[] = [];
  for (const field of requiredFields) {
    const value = evidence[field];
    if (typeof value === "string") {
      if (!value.trim()) {
        missing.push(field);
      }
      continue;
    }
    if (Array.isArray(value)) {
      if (value.length === 0) {
        missing.push(field);
      }
      continue;
    }
    if (!value) {
      missing.push(field);
    }
  }

  return {
    ok: missing.length === 0,
    missing,
  };
}

function sanitizeBudgetValue(value: unknown, fallback: number): number {
  // A non-finite (Infinity/NaN), negative, or absurdly large override would
  // silently neuter the footprint gate. Fall back to the default for an unusable
  // value and clamp the rest to a sane positive integer ceiling.
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return fallback;
  }
  return Math.min(Math.floor(value), MAX_MINIMAL_FOOTPRINT_BUDGET);
}

export function evaluateMinimalFootprint(
  changes: Array<Record<string, unknown>>,
  budgetOverride?: Partial<MinimalFootprintBudget>
): Record<string, unknown> {
  const files = new Set<string>();
  const objects = new Set<string>();
  let lines = 0;

  for (const change of changes) {
    const filePath = typeof change.filePath === "string" ? change.filePath.trim() : "";
    const objectId = typeof change.objectId === "string" ? change.objectId.trim() : "";
    const estimatedLines =
      typeof change.estimatedLines === "number" && Number.isFinite(change.estimatedLines)
        ? Math.max(Math.floor(change.estimatedLines), 0)
        : 0;

    if (filePath) {
      files.add(filePath);
    }
    if (objectId) {
      objects.add(objectId);
    }
    lines += estimatedLines;
  }

  const override = budgetOverride || {};
  const budget: MinimalFootprintBudget = {
    maxFiles: sanitizeBudgetValue(override.maxFiles, DEFAULT_MINIMAL_FOOTPRINT_BUDGET.maxFiles),
    maxLines: sanitizeBudgetValue(override.maxLines, DEFAULT_MINIMAL_FOOTPRINT_BUDGET.maxLines),
    maxObjects: sanitizeBudgetValue(
      override.maxObjects,
      DEFAULT_MINIMAL_FOOTPRINT_BUDGET.maxObjects
    ),
  };
  const metrics: MinimalFootprintMetrics = {
    changedFiles: files.size,
    changedLines: lines,
    changedObjects: objects.size,
  };

  const violations: string[] = [];
  if (metrics.changedFiles > budget.maxFiles) {
    violations.push(`changedFiles exceeds budget (${metrics.changedFiles}/${budget.maxFiles})`);
  }
  if (metrics.changedLines > budget.maxLines) {
    violations.push(`changedLines exceeds budget (${metrics.changedLines}/${budget.maxLines})`);
  }
  if (metrics.changedObjects > budget.maxObjects) {
    violations.push(`changedObjects exceeds budget (${metrics.changedObjects}/${budget.maxObjects})`);
  }

  return {
    metrics,
    budget,
    withinBudget: violations.length === 0,
    violations,
  };
}
