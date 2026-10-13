// SPDX-License-Identifier: GPL-3.0-or-later
import { promises as fsp } from "fs";
import dotenv from "dotenv";

/**
 * Formats a value for safe inclusion in a dotenv file.
 *
 * Values consisting only of "safe" characters are written verbatim. Anything
 * else (spaces, "#", quotes, backslashes, etc.) is quoted, SINGLE quotes first.
 *
 * Single quotes — not double — because dotenv (v17) treats a single-quoted
 * value as a literal: it does NOT un-escape backslashes. Double-quoted values
 * expand `\n`/`\r` and leave every other backslash escape intact, so `Win\2026`
 * written as `"Win\\2026"` reads back as `Win\\2026` (corrupted).
 *
 * A single-quoted value is not safe for every value, though: dotenv ends it at
 * the first `'` that is followed by a comment, so the password `p' #1` written
 * as `'p' #1'` reads back as `p`. Each quoting is therefore checked against the
 * real parser and the first that reads back verbatim wins (single, backtick,
 * double). A value no quoting can carry is refused rather than written in a
 * form that would silently read back as a different secret.
 */
export function formatEnvValue(value: string): string {
  const raw = String(value ?? "").replace(/[\r\n]/g, "");
  if (raw.length > 0 && /^[A-Za-z0-9_.\-:@/]+$/.test(raw)) {
    return raw;
  }
  for (const quote of ["'", "`", '"']) {
    const quoted = `${quote}${raw}${quote}`;
    if (dotenv.parse(`K=${quoted}\n`).K === raw) {
      return quoted;
    }
  }
  throw new Error(
    "A value contains a combination of quotes and '#' that a .env file cannot hold verbatim; " +
      "set it through the credential store (`syncrona login`) instead."
  );
}

/**
 * Upserts the provided key/value pairs into existing dotenv content.
 *
 * Existing keys are replaced in place (preserving their position, an `export`
 * prefix and any unrelated variables/comments); missing keys are appended. This
 * makes the write non-destructive — unrelated configuration in the .env is
 * preserved. A key the file assigns more than once keeps only its first line:
 * dotenv lets the LAST assignment win, so rewriting the first alone would leave
 * a later, stale value in force.
 */
export function upsertEnvVars(
  existing: string,
  vars: Record<string, string>
): string {
  const lines = existing.length > 0 ? existing.split("\n") : [];
  const remaining = new Map(Object.entries(vars));
  const written = new Set<string>();

  const updated = lines.flatMap((line) => {
    const match = line.match(/^(\s*(?:export\s+)?)([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) {
      return [line];
    }
    const key = match[2];
    if (written.has(key)) {
      return [];
    }
    if (remaining.has(key)) {
      const value = remaining.get(key) as string;
      remaining.delete(key);
      written.add(key);
      return [`${match[1].trimStart()}${key}=${formatEnvValue(value)}`];
    }
    return [line];
  });

  // Drop a single trailing empty line so appends stay tidy; we re-add a final
  // newline when serializing.
  while (updated.length > 0 && updated[updated.length - 1].trim() === "") {
    updated.pop();
  }

  for (const [key, value] of remaining) {
    updated.push(`${key}=${formatEnvValue(value)}`);
  }

  return updated.join("\n") + "\n";
}

/**
 * Writes the provided variables into the dotenv file at `envPath`, preserving
 * any unrelated variables already present. The file is created with owner-only
 * permissions since it may contain credentials.
 */
export async function writeDotEnv(
  envPath: string,
  vars: Record<string, string>
): Promise<void> {
  let existing = "";
  try {
    existing = await fsp.readFile(envPath, "utf8");
  } catch {
    existing = "";
  }
  const next = upsertEnvVars(existing, vars);
  await fsp.writeFile(envPath, next, { encoding: "utf8", mode: 0o600 });
  // `mode` on writeFile only applies when the file is CREATED; an existing .env
  // keeps its old (possibly world-readable) permissions. Re-assert 0o600 every
  // write so credentials never sit in a loosely-permissioned file. Best-effort:
  // platforms without POSIX modes (Windows) simply ignore this.
  try {
    await fsp.chmod(envPath, 0o600);
  } catch {
    // chmod unsupported (e.g. Windows) — the file content is still written.
  }
}

/**
 * Ensures `entry` is present in the .gitignore at `dir`, creating the file if
 * needed. Used to keep credential-bearing files like .env out of version
 * control. Returns true if the entry was added.
 */
export async function ensureGitignored(
  dir: string,
  entry: string
): Promise<boolean> {
  const gitignorePath = `${dir.replace(/\/$/, "")}/.gitignore`;
  let existing = "";
  try {
    existing = await fsp.readFile(gitignorePath, "utf8");
  } catch {
    existing = "";
  }
  const lines = existing.split("\n").map((line) => line.trim());
  if (lines.includes(entry)) {
    return false;
  }
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await fsp.appendFile(gitignorePath, `${prefix}${entry}\n`, "utf8");
  return true;
}
