import { existsSync, mkdirSync, writeFileSync } from "fs";
import path from "path";
import { AUTO_PULL_ALL_SCOPES_ENV, PROJECT_DIR, SCOPE_BOOTSTRAP_TIMEOUT_MS } from "./runtimeConfig";
import { asRecord, toStringField } from "./recordUtils";
import { runSyncroCliCommand } from "./processRunner";
import { listScopes } from "./sessionContext";
import { getServiceNowConfig } from "./servicenowCore";

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
  for (const scope of scopes) {
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
    `Auto scope pull complete: ${successCount} succeeded, ${failedCount} failed, total ${scopes.length}.`
  );
}
