// SPDX-License-Identifier: GPL-3.0-or-later
import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { AUTO_PULL_ALL_SCOPES_ENV, PROJECT_DIR, SCOPE_BOOTSTRAP_TIMEOUT_MS } from "./runtimeConfig";
import { asRecord, toStringField } from "./recordUtils";
import { runSyncroCliCommand } from "./processRunner";
import { listScopes } from "./sessionContext";
import { getServiceNowConfig } from "./servicenowCore";

// A ServiceNow scope code is `x_<vendor>_<app>` — lowercase letters, digits and
// underscores only. The instance is only semi-trusted here (auto-pull runs
// unattended at startup, defaulting on), so a scope value must never be able to
// carry `../` or absolute-path fragments into `path.join`/`mkdirSync`/a child
// `cwd`. Anything that doesn't match is skipped and logged rather than written.
const VALID_SCOPE_CODE = /^x_[a-z0-9_]+$/;

export function isValidScopeCode(scopeCode: string): boolean {
  return VALID_SCOPE_CODE.test(scopeCode);
}

function shouldAutoPullAllScopes(): boolean {
  const raw = toStringField(process.env[AUTO_PULL_ALL_SCOPES_ENV]).trim().toLowerCase();
  if (!raw) {
    return true;
  }

  return !["0", "false", "no", "off"].includes(raw);
}

async function listScopedApplications(timeoutMs: number): Promise<Array<{ scope: string; name: string }>> {
  const rows = await listScopes(timeoutMs, "scopeSTARTSWITHx_", 5000);
  return rows
    .map((row) => ({
      scope: toStringField(asRecord(row).scope),
      name: toStringField(asRecord(row).name),
    }))
    .filter((row) => row.scope.length > 0)
    .sort((a, b) => a.scope.localeCompare(b.scope));
}

function writeScopeWorkspace(scopeCode: string): void {
  // Defence in depth: never build a filesystem path from an unvalidated scope
  // code even if a caller forgot to pre-filter.
  if (!isValidScopeCode(scopeCode)) {
    throw new Error(`Refusing to write workspace for invalid scope code: ${scopeCode}`);
  }
  const scopeDir = path.join(PROJECT_DIR, "packages", scopeCode);
  const sourceDir = path.join(scopeDir, "src");
  mkdirSync(sourceDir, { recursive: true });

  const configPath = path.join(scopeDir, "sync.config.js");
  if (!existsSync(configPath)) {
    writeFileSync(
      configPath,
      [
        "module.exports = {",
        '  sourceDirectory: "src",',
        '  buildDirectory: "build",',
        "  rules: [],",
        "  excludes: {},",
        "  includes: {},",
        "  tableOptions: {},",
        "  refreshInterval: 30,",
        "};",
        "",
      ].join("\n"),
      "utf-8"
    );
  }

  const packagePath = path.join(scopeDir, "package.json");
  if (!existsSync(packagePath)) {
    writeFileSync(
      packagePath,
      `${JSON.stringify(
        {
          name: scopeCode,
          private: true,
          version: "1.0.0",
        },
        null,
        2
      )}\n`,
      "utf-8"
    );
  }

}

export async function autoPullAllScopesAndData(timeoutMs: number = SCOPE_BOOTSTRAP_TIMEOUT_MS): Promise<void> {
  if (!shouldAutoPullAllScopes()) {
    console.error("Auto scope pull skipped (SYNCRONA_MCP_AUTO_PULL_ALL_SCOPES disabled).");
    return;
  }

  mkdirSync(path.join(PROJECT_DIR, "packages"), { recursive: true });

  let scopes: Array<{ scope: string; name: string }> = [];
  try {
    scopes = await listScopedApplications(timeoutMs);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Auto scope pull failed while listing scopes: ${msg}`);
    return;
  }

  if (scopes.length === 0) {
    console.error("Auto scope pull: no x_* scopes found.");
    return;
  }

  let forwardedEnv: Record<string, string> | undefined;
  try {
    const resolved = getServiceNowConfig(PROJECT_DIR);
    forwardedEnv = {
      SN_INSTANCE: resolved.instance,
      SN_USER: resolved.user,
      SN_PASSWORD: resolved.password,
    };
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.error(`Auto scope pull: could not resolve credentials for child downloads (${msg}).`);
  }

  let successCount = 0;
  let failedCount = 0;
  let skippedCount = 0;
  for (const scope of scopes) {
    // The scope code becomes a filesystem path and a child process cwd below.
    // A compromised/misconfigured instance could return a value with `../` or
    // path separators; validate before any path join / fs write / child cwd and
    // skip-and-log anything that doesn't match the strict scope-code shape.
    if (!isValidScopeCode(scope.scope)) {
      skippedCount += 1;
      console.error(
        `Auto scope pull: skipping invalid scope code ${JSON.stringify(scope.scope)}.`
      );
      continue;
    }
    try {
      writeScopeWorkspace(scope.scope);

      const scopeDir = path.join(PROJECT_DIR, "packages", scope.scope);
      const downloadResult = await runSyncroCliCommand(
        "download",
        [scope.scope, "--logLevel", "warn", "--ci"],
        timeoutMs,
        scopeDir,
        forwardedEnv
      );

      if (downloadResult.exitCode !== 0) {
        const stderr = downloadResult.stderr.trim();
        const stdout = downloadResult.stdout.trim();
        const details = [
          `exit=${downloadResult.exitCode}`,
          downloadResult.timedOut ? "timedOut=true" : "",
          stderr ? `stderr=${stderr.slice(0, 500)}` : "",
          stdout ? `stdout=${stdout.slice(0, 500)}` : "",
        ]
          .filter((part) => part.length > 0)
          .join("; ");
        throw new Error(
          `download failed in ${scope.scope}; ${details}`
        );
      }

      successCount += 1;
      console.error(
        `Auto scope pull: ${scope.scope} synced.`
      );
    } catch (e) {
      failedCount += 1;
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`Auto scope pull: ${scope.scope} failed: ${msg}`);
    }
  }

  console.error(
    `Auto scope pull complete: ${successCount} succeeded, ${failedCount} failed, ${skippedCount} skipped (invalid scope code), total ${scopes.length}.`
  );
}
