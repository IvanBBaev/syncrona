import { promises as fsp } from "fs";

/**
 * Formats a value for safe inclusion in a dotenv file.
 *
 * Values consisting only of "safe" characters are written verbatim. Anything
 * else (spaces, "#", quotes, etc.) is wrapped in double quotes with backslashes
 * and double quotes escaped so the file round-trips through dotenv.
 */
export function formatEnvValue(value: string): string {
  const raw = String(value ?? "").replace(/[\r\n]/g, "");
  if (raw.length > 0 && /^[A-Za-z0-9_.\-:@/]+$/.test(raw)) {
    return raw;
  }
  const escaped = raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  return `"${escaped}"`;
}

/**
 * Upserts the provided key/value pairs into existing dotenv content.
 *
 * Existing keys are replaced in place (preserving their position and any
 * unrelated variables/comments); missing keys are appended. This makes the
 * write non-destructive — unrelated configuration in the .env is preserved.
 */
export function upsertEnvVars(
  existing: string,
  vars: Record<string, string>
): string {
  const lines = existing.length > 0 ? existing.split("\n") : [];
  const remaining = new Map(Object.entries(vars));

  const updated = lines.map((line) => {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=/);
    if (!match) {
      return line;
    }
    const key = match[1];
    if (remaining.has(key)) {
      const value = remaining.get(key) as string;
      remaining.delete(key);
      return `${key}=${formatEnvValue(value)}`;
    }
    return line;
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
