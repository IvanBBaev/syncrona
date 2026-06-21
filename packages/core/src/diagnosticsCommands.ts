import { Sync } from "@syncro-now-ai/types";
import { promises as fsp, readFileSync } from "fs";
import { execFileSync } from "child_process";
import os from "os";
import path from "path";
import * as ConfigManager from "./config";
import { logger } from "./Logger";
import {
  defaultClient,
  resolveCredentials,
  describeCredentialSource,
  diagnoseCredentials,
  unwrapSNResponse,
} from "./snClient";
import { listInstances } from "./auth";
import { isScopedEndpointUnavailableError } from "./manifestBuilder";
import {
  setLogLevel,
  logScopedEndpointCapability,
  activeStoreHealth,
  getActiveStoreDecryptWarning,
} from "./commandHelpers";

type StatusSummary = {
  ok: boolean;
  instance: string;
  user: string;
  scope: string;
  configPath: string;
  sourcePath: string;
  buildPath: string;
  manifestPath: string;
  credentialSource: string;
  includeRules: number;
  excludeRules: number;
  envReady: boolean;
  connectivityOk: boolean;
  errors: string[];
};

// DX9: how many include/exclude table rules are active in the merged config.
function countConfigRules(): { includeRules: number; excludeRules: number } {
  try {
    const cfg = ConfigManager.getConfig();
    return {
      includeRules: Object.keys(cfg.includes ?? {}).length,
      excludeRules: Object.keys(cfg.excludes ?? {}).length,
    };
  } catch (_) {
    return { includeRules: 0, excludeRules: 0 };
  }
}

type DoctorCheck = {
  name: string;
  ok: boolean;
  details: string;
};

type PluginDiagnostic = {
  name: string;
  installed: boolean;
  rulesMatched: number;
};

type PluginsSummary = {
  totalRules: number;
  totalPlugins: number;
  plugins: PluginDiagnostic[];
};

function safeConfigPath(): string {
  const configPath = ConfigManager.checkConfigPath();
  return configPath ? configPath : "<not found>";
}

function safeConfigGet(getter: () => string): string {
  try {
    return getter();
  } catch (_) {
    return "<unresolved>";
  }
}

export async function statusCommand(
  args: Sync.SharedCmdArgs & { debugCredentials?: boolean }
): Promise<StatusSummary> {
  setLogLevel(args);
  const credentials = resolveCredentials(args.instanceProfile);
  const instance = credentials.instance;
  const user = credentials.user;
  const missingEnvVars = [
    credentials.instance ? "" : "SN_INSTANCE",
    credentials.user ? "" : "SN_USER",
    credentials.password ? "" : "SN_PASSWORD",
  ].filter((name) => name.length > 0);
  const envReady = missingEnvVars.length === 0;

  let scope = "<unknown>";
  let connectivityOk = false;
  const errors: string[] = [];

  if (envReady) {
    try {
      const client = defaultClient(args.instanceProfile);
      await client.checkConnection(5000);
      logScopedEndpointCapability("status");
      connectivityOk = true;
      try {
        const scopeObj = await unwrapSNResponse(client.getCurrentScope());
        scope = scopeObj.scope || "<unknown>";
      } catch (e) {
        if (isScopedEndpointUnavailableError(e)) {
          const manifest = ConfigManager.getManifest();
          scope = manifest?.scope || "<unknown>";
          errors.push(
            "Scoped SyncroNow AI API is unavailable on this instance. Using Table API compatibility mode; current session scope could not be verified."
          );
        } else {
          throw e;
        }
      }
    } catch (e) {
      let message = "Unable to connect to ServiceNow instance.";
      if (e instanceof Error && e.message.trim()) {
        message = `Unable to connect to ServiceNow instance: ${e.message}`;
      }
      errors.push(message);
    }
  } else {
    errors.push(`Missing environment variables: ${missingEnvVars.join(", ")}`);
    // DX20b: if a prior login left a stored instance that no longer decrypts,
    // that — not a truly empty config — is why creds look missing. Say so.
    const decryptWarning = await getActiveStoreDecryptWarning();
    if (decryptWarning) {
      errors.push(decryptWarning);
    }
  }

  const summary: StatusSummary = {
    ok: envReady && connectivityOk,
    instance,
    user,
    scope,
    configPath: safeConfigPath(),
    sourcePath: safeConfigGet(() => ConfigManager.getSourcePath()),
    buildPath: safeConfigGet(() => ConfigManager.getBuildPath()),
    manifestPath: safeConfigGet(() => ConfigManager.getManifestPath()),
    credentialSource: describeCredentialSource(args.instanceProfile),
    ...countConfigRules(),
    envReady,
    connectivityOk,
    errors,
  };

  logger.info(`Instance: ${summary.instance || "<missing>"}`);
  logger.info(`User: ${summary.user || "<missing>"}`);
  logger.info(`Credentials from: ${summary.credentialSource}`);
  logger.info(`Scope: ${summary.scope}`);
  logger.info(`Config: ${summary.configPath}`);
  logger.info(`Source: ${summary.sourcePath}`);
  logger.info(`Build: ${summary.buildPath}`);
  logger.info(`Manifest: ${summary.manifestPath}`);
  logger.info(
    `Config rules: ${summary.includeRules} include, ${summary.excludeRules} exclude (defaults + overrides)`
  );
  logger.info(`Environment Ready: ${summary.envReady ? "yes" : "no"}`);
  logger.info(`Connectivity: ${summary.connectivityOk ? "ok" : "failed"}`);
  for (const error of summary.errors) {
    logger.warn(`status: ${error}`);
  }

  if (args.debugCredentials) {
    await printCredentialDiagnostics(args.instanceProfile);
  }

  return summary;
}

// DX20: explain every credential source and which one the resolver picked, so
// "why am I talking to the wrong instance?" is answerable without guessing.
async function printCredentialDiagnostics(profile?: string): Promise<void> {
  const diag = diagnoseCredentials(profile);
  const yn = (present: boolean): string => (present ? "set" : "missing");

  logger.info("--- credential diagnostics ---");
  logger.info(
    `Base env: SN_INSTANCE ${yn(diag.baseEnvPresent.instance)}, ` +
      `SN_USER ${yn(diag.baseEnvPresent.user)}, SN_PASSWORD ${yn(diag.baseEnvPresent.password)}`
  );
  if (diag.profile && diag.profileEnvPresent) {
    logger.info(
      `Profile "${diag.profile}" env: SN_INSTANCE_${diag.profile} ${yn(diag.profileEnvPresent.instance)}, ` +
        `SN_USER_${diag.profile} ${yn(diag.profileEnvPresent.user)}, ` +
        `SN_PASSWORD_${diag.profile} ${yn(diag.profileEnvPresent.password)}`
    );
  }
  try {
    const stored = await listInstances();
    const health = await activeStoreHealth();
    logger.info(
      `Credential store: ${stored.length} instance(s)${stored.length ? ` [${stored.join(", ")}]` : ""}` +
        `${health.active ? `, active: ${health.active}` : ", no active instance"}`
    );
    if (health.active) {
      if (health.decrypts) {
        logger.info(`Active stored instance "${health.active}" decrypts: yes`);
      } else {
        logger.warn(
          `Active stored instance "${health.active}" FAILED to decrypt: ${health.error}. ` +
            "The credential file was likely encrypted on a different machine or user — re-run 'syncro-now-ai login'."
        );
      }
    }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.info(`Credential store: unreadable (${message})`);
  }
  logger.info(`Resolved source (winner): ${diag.source}`);
  logger.info(
    `Resolved instance: ${diag.resolvedInstance || "<missing>"}, user: ${diag.resolvedUser || "<missing>"}`
  );
}

export async function doctorCommand(args: Sync.SharedCmdArgs): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  setLogLevel(args);
  const checks: DoctorCheck[] = [];

  const configPath = ConfigManager.checkConfigPath();
  checks.push({
    name: "configPath",
    ok: Boolean(configPath),
    details: configPath
      ? `Found config at ${configPath}`
      : "No sync.config.js discovered from current working directory.",
  });

  try {
    const sourcePath = ConfigManager.getSourcePath();
    checks.push({
      name: "sourcePath",
      ok: true,
      details: `Resolved source path: ${sourcePath}`,
    });
  } catch (_) {
    checks.push({
      name: "sourcePath",
      ok: false,
      details: "Unable to resolve source path from configuration.",
    });
  }

  try {
    const buildPath = ConfigManager.getBuildPath();
    checks.push({
      name: "buildPath",
      ok: true,
      details: `Resolved build path: ${buildPath}`,
    });
  } catch (_) {
    checks.push({
      name: "buildPath",
      ok: false,
      details: "Unable to resolve build path from configuration.",
    });
  }

  const credentials = resolveCredentials(args.instanceProfile);
  const missingEnvVars = [
    credentials.instance ? "" : "SN_INSTANCE",
    credentials.user ? "" : "SN_USER",
    credentials.password ? "" : "SN_PASSWORD",
  ].filter((name) => name.length > 0);
  checks.push({
    name: "env",
    ok: missingEnvVars.length === 0,
    details:
      missingEnvVars.length === 0
        ? "ServiceNow credentials are present in environment."
        : `Missing environment variables: ${missingEnvVars.join(", ")}`,
  });

  if (missingEnvVars.length === 0) {
    try {
      const client = defaultClient(args.instanceProfile);
      await client.checkConnection(5000);
      logScopedEndpointCapability("doctor");
      checks.push({
        name: "connectivity",
        ok: true,
        details: `Successfully connected to ${credentials.instance}.`,
      });
    } catch (_) {
      checks.push({
        name: "connectivity",
        ok: false,
        details:
          "Unable to reach ServiceNow instance. Verify credentials and network connectivity.",
      });
    }
  } else {
    checks.push({
      name: "connectivity",
      ok: false,
      details: "Skipped connectivity check because required environment variables are missing.",
    });
  }

  for (const check of checks) {
    if (check.ok) {
      logger.success(`doctor:${check.name} OK - ${check.details}`);
    } else {
      logger.warn(`doctor:${check.name} FAIL - ${check.details}`);
    }
  }

  const ok = checks.every((check) => check.ok);
  if (ok) {
    logger.success("Doctor checks passed. ✅");
  } else {
    logger.warn("Doctor checks found issues. See messages above.");
  }

  return { ok, checks };
}

export async function pluginsCommand(args: Sync.SharedCmdArgs): Promise<PluginsSummary> {
  setLogLevel(args);

  let rules: Sync.PluginRule[] = [];
  try {
    const config = ConfigManager.getConfig();
    if (Array.isArray(config.rules)) {
      rules = config.rules;
    }
  } catch (_) {
    rules = [];
  }

  const pluginUseCount = new Map<string, number>();
  for (const rule of rules) {
    const plugins = Array.isArray(rule.plugins) ? rule.plugins : [];
    for (const plugin of plugins) {
      const name = typeof plugin?.name === "string" ? plugin.name.trim() : "";
      if (!name) {
        continue;
      }
      pluginUseCount.set(name, (pluginUseCount.get(name) || 0) + 1);
    }
  }

  let rootDir = process.cwd();
  try {
    rootDir = ConfigManager.getRootDir();
  } catch (_) {
    rootDir = process.cwd();
  }

  const plugins: PluginDiagnostic[] = [];
  for (const [name, rulesMatched] of [...pluginUseCount.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    const candidatePath = path.join(rootDir, "node_modules", name);
    let installed = false;
    try {
      await fsp.stat(candidatePath);
      installed = true;
    } catch (_) {
      installed = false;
    }

    plugins.push({
      name,
      installed,
      rulesMatched,
    });
  }

  const summary: PluginsSummary = {
    totalRules: rules.length,
    totalPlugins: plugins.length,
    plugins,
  };

  logger.info(`Plugin rules: ${summary.totalRules}`);
  logger.info(`Configured plugins: ${summary.totalPlugins}`);

  if (summary.totalPlugins === 0) {
    logger.info("No plugins configured in sync.config.js rules.");
  }

  for (const plugin of summary.plugins) {
    const status = plugin.installed ? "installed" : "missing";
    logger.info(`plugin:${plugin.name} status=${status} rules=${plugin.rulesMatched}`);
    if (!plugin.installed) {
      logger.warn(`plugin:${plugin.name} is configured but not installed in node_modules.`);
    }
  }

  return summary;
}

// DX9: inspect configuration. Currently supports `show-defaults`, which prints
// the built-in defaults applied before a project's sync.config.js overrides, so
// users don't have to read defaultOptions.ts to understand them.
export function configCommand(args: Sync.SharedCmdArgs & { action: string }): void {
  setLogLevel(args);
  const action = String(args.action || "").trim();
  if (action !== "show-defaults") {
    logger.error(`Unknown config action "${action}". Supported actions: show-defaults.`);
    process.exitCode = 1;
    return;
  }
  const def = ConfigManager.getDefaultConfig();
  logger.info("SyncroNow AI default configuration (applied before sync.config.js overrides):");
  logger.info(`  sourceDirectory: ${def.sourceDirectory}`);
  logger.info(`  buildDirectory:  ${def.buildDirectory}`);
  logger.info(`  pushConcurrency: ${def.pushConcurrency}`);
  logger.info(`  refreshInterval: ${def.refreshInterval}s`);
  logger.info(`  default include table rules: ${Object.keys(def.includes ?? {}).length}`);
  logger.info(`  default exclude table rules: ${Object.keys(def.excludes ?? {}).length}`);
  logger.info(
    "Override any of these in sync.config.js (includes/excludes merge on top of these defaults) — see the README Configuration section."
  );
}

type EnvCheck = { name: string; ok: boolean; details: string };

function detectWsl(): boolean {
  if (process.env.WSL_DISTRO_NAME) {
    return true;
  }
  try {
    return readFileSync("/proc/version", "utf-8").toLowerCase().includes("microsoft");
  } catch (_) {
    return false;
  }
}

// DX1: verify the machine meets SyncroNow AI's prerequisites (Node 22+, supported
// platform/WSL, Git) and print actionable next steps — needs no instance.
export function checkEnvCommand(
  args: Sync.SharedCmdArgs
): { ok: boolean; checks: EnvCheck[] } {
  setLogLevel(args);
  const checks: EnvCheck[] = [];

  const nodeMajor = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    ok: Number.isFinite(nodeMajor) && nodeMajor >= 22,
    details:
      nodeMajor >= 22
        ? `Node.js ${process.versions.node} (>= 22 required)`
        : `Node.js ${process.versions.node} is too old — SyncroNow AI requires Node 22+. Install via nvm: 'nvm install 22 && nvm use 22'.`,
  });

  if (process.platform === "win32") {
    checks.push({
      name: "platform",
      ok: false,
      details:
        "Native Windows is not supported yet — run SyncroNow AI inside WSL (Ubuntu). See the README \"Windows users\" section.",
    });
  } else if (process.platform === "linux") {
    const wsl = detectWsl();
    checks.push({
      name: "platform",
      ok: true,
      details: wsl ? `Linux / WSL (${process.env.WSL_DISTRO_NAME || "detected"})` : "Linux",
    });
  } else {
    checks.push({ name: "platform", ok: true, details: `${process.platform} (${os.release()})` });
  }

  let gitOk = false;
  let gitDetails = "git not found on PATH — install Git from https://git-scm.com.";
  try {
    gitDetails = execFileSync("git", ["--version"], { encoding: "utf-8" }).trim();
    gitOk = true;
  } catch (_) {
    gitOk = false;
  }
  checks.push({ name: "git", ok: gitOk, details: gitDetails });

  const ok = checks.every((c) => c.ok);
  for (const c of checks) {
    const line = `${c.ok ? "✓" : "✗"} ${c.name}: ${c.details}`;
    if (c.ok) {
      logger.info(line);
    } else {
      logger.warn(line);
    }
  }
  logger.info(ok ? "Environment looks good ✅" : "Environment has issues — address the ✗ items above.");
  if (!ok) {
    process.exitCode = 1;
  }
  return { ok, checks };
}
