// SPDX-License-Identifier: GPL-3.0-or-later
// A throwaway git repository for suites that need real git evidence (`repair
// --prune` deletes only files git shows as committed and unchanged). Every call
// pins the identity, signing and hooks so a developer's global git config can
// neither fail a commit nor run a hook inside a test.
import { execFileSync } from "child_process";

const ISOLATED = [
  "-c",
  "user.name=Syncrona Test",
  "-c",
  "user.email=test@example.invalid",
  "-c",
  "commit.gpgsign=false",
  "-c",
  "core.hooksPath=/dev/null",
];

export const git = (cwd: string, ...args: string[]): string =>
  execFileSync("git", [...ISOLATED, ...args], { cwd, encoding: "utf8" });

/** `git init` in `dir`, then commit everything already in it (if anything). */
export const initRepo = (dir: string): void => {
  git(dir, "init", "-q");
  commitAll(dir);
};

/** Stage every change under `dir` and commit it; a no-op when nothing changed. */
export const commitAll = (dir: string, message = "fixture"): void => {
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "--allow-empty", "-m", message);
};
