// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncrona/types";
import path from "path";
import inquirer from "inquirer";
import {
  AUTH_METHOD_ENV,
  API_KEY_ENV,
  API_KEY_HEADER_ENV,
  OAUTH_CLIENT_ID_ENV,
  OAUTH_CLIENT_SECRET_ENV,
  JWT_KEY_ENV,
  JWT_KID_ENV,
  JWT_ISS_ENV,
  JWT_SUB_ENV,
  JWT_AUD_ENV,
  CLIENT_CERT_ENV,
  CLIENT_KEY_ENV,
  CLIENT_KEY_PASSPHRASE_ENV,
} from "@syncrona/sn-transport";
import { logger } from "./Logger.js";
import {
  saveCredentials,
  listInstances,
  removeCredentials,
  removeAllCredentials,
  setActiveInstance,
  getActiveInstance,
  type StoredCredentials,
} from "./auth.js";
import {
  preloadStoredCredentials,
  clearStoredCredentialsCache,
} from "./snClient.js";
import { writeDotEnv, ensureGitignored } from "./envFile.js";
import { setLogLevel, bootstrapWorkspaceOnLogin } from "./commandHelpers.js";

// Full argument surface accepted by `login`. Everything beyond `instance` is
// optional: supplied non-interactively via CLI flags, or prompted for when the
// method needs the field and no flag was given.
type LoginArgs = Sync.SharedCmdArgs & {
  instance?: string;
  authMethod?: string;
  user?: string;
  password?: string;
  clientId?: string;
  clientSecret?: string;
  apiKey?: string;
  apiKeyHeader?: string;
  jwtKey?: string;
  jwtKid?: string;
  jwtIss?: string;
  jwtSub?: string;
  jwtAud?: string;
  clientCert?: string;
  clientKey?: string;
  clientKeyPassphrase?: string;
};

type LoginMethod =
  | "basic"
  | "oauth-password"
  | "oauth-client-credentials"
  | "oauth-jwt-bearer"
  | "api-key";

const LOGIN_METHOD_CHOICES: { name: string; value: LoginMethod }[] = [
  { name: "Basic — username + password", value: "basic" },
  {
    name: "OAuth 2.0 — Password grant (username + password + client id/secret)",
    value: "oauth-password",
  },
  {
    name: "OAuth 2.0 — Client Credentials grant (client id/secret)",
    value: "oauth-client-credentials",
  },
  {
    name: "OAuth 2.0 — JWT Bearer grant (client id/secret + signing key)",
    value: "oauth-jwt-bearer",
  },
  { name: "Inbound REST API Key", value: "api-key" },
];

const KNOWN_LOGIN_METHODS = new Set<LoginMethod>(
  LOGIN_METHOD_CHOICES.map((c) => c.value)
);

// Auth material collected from flags and/or prompts. Secrets are kept verbatim;
// identifiers/paths are trimmed by the caller.
type LoginFields = {
  user?: string;
  password?: string;
  clientId?: string;
  clientSecret?: string;
  apiKey?: string;
  apiKeyHeader?: string;
  jwtKey?: string;
  jwtKid?: string;
  jwtIss?: string;
  jwtSub?: string;
  jwtAud?: string;
  clientCert?: string;
  clientKey?: string;
  clientKeyPassphrase?: string;
};

// Minimal shape of an inquirer question — declared locally so this module does
// not couple to inquirer's exact (versioned) type surface.
type PromptQuestion = {
  type: string;
  name: string;
  message: string;
  mask?: string;
  default?: unknown;
  choices?: { name: string; value: string }[];
  validate?: (v: string) => true | string;
};

// The SN_* keys this command manages. A re-login that switches methods clears
// any managed key the new method does not use, so stale material from a previous
// method never leaks into the connection check within this process.
const MANAGED_AUTH_ENV: string[] = [
  "SN_USER",
  "SN_PASSWORD",
  AUTH_METHOD_ENV,
  API_KEY_ENV,
  API_KEY_HEADER_ENV,
  OAUTH_CLIENT_ID_ENV,
  OAUTH_CLIENT_SECRET_ENV,
  JWT_KEY_ENV,
  JWT_KID_ENV,
  JWT_ISS_ENV,
  JWT_SUB_ENV,
  JWT_AUD_ENV,
  CLIENT_CERT_ENV,
  CLIENT_KEY_ENV,
  CLIENT_KEY_PASSPHRASE_ENV,
];

function normalizeLoginMethod(raw?: string): LoginMethod | undefined {
  const value = String(raw || "").trim().toLowerCase();
  return KNOWN_LOGIN_METHODS.has(value as LoginMethod)
    ? (value as LoginMethod)
    : undefined;
}

function requiredValidator(label: string): (v: string) => true | string {
  return (v: string) =>
    String(v).trim().length > 0 ? true : `${label} is required.`;
}

// Map collected fields → the SN_* env vars for the chosen method. mTLS keys are
// orthogonal (included whenever a client cert/key was supplied). Basic omits
// SN_AUTH_METHOD so the resulting .env is byte-identical to a legacy login — the
// method is then inferred exactly as before.
function buildLoginEnv(
  instance: string,
  method: LoginMethod,
  f: LoginFields
): Record<string, string> {
  const env: Record<string, string> = { SN_INSTANCE: instance };
  if (method !== "basic") env[AUTH_METHOD_ENV] = method;
  if (f.user) env.SN_USER = f.user;
  if (f.password) env.SN_PASSWORD = f.password;
  if (f.clientId) env[OAUTH_CLIENT_ID_ENV] = f.clientId;
  if (f.clientSecret) env[OAUTH_CLIENT_SECRET_ENV] = f.clientSecret;
  if (f.apiKey) env[API_KEY_ENV] = f.apiKey;
  if (f.apiKeyHeader) env[API_KEY_HEADER_ENV] = f.apiKeyHeader;
  if (f.jwtKey) env[JWT_KEY_ENV] = f.jwtKey;
  if (f.jwtKid) env[JWT_KID_ENV] = f.jwtKid;
  if (f.jwtIss) env[JWT_ISS_ENV] = f.jwtIss;
  if (f.jwtSub) env[JWT_SUB_ENV] = f.jwtSub;
  if (f.jwtAud) env[JWT_AUD_ENV] = f.jwtAud;
  if (f.clientCert) env[CLIENT_CERT_ENV] = f.clientCert;
  if (f.clientKey) env[CLIENT_KEY_ENV] = f.clientKey;
  if (f.clientKeyPassphrase) env[CLIENT_KEY_PASSPHRASE_ENV] = f.clientKeyPassphrase;
  return env;
}

// Apply the login env to THIS process so the verification client — and the rest
// of the login session — sees exactly this method's material, mirroring a later
// CLI run after it loads the written .env. Managed keys the method does not use
// are cleared so a method switch never inherits stale credentials.
function applyLoginEnv(env: Record<string, string>): void {
  process.env.SN_INSTANCE = env.SN_INSTANCE;
  for (const key of MANAGED_AUTH_ENV) {
    if (env[key] !== undefined) {
      process.env[key] = env[key];
    } else {
      delete process.env[key];
    }
  }
}

// Translate collected fields into the richer StoredCredentials record. The JWT
// signing key and mTLS cert/key are persisted by PATH only — the key material
// itself is never copied into the encrypted store.
function buildStoredExtra(
  method: LoginMethod,
  f: LoginFields
): Partial<StoredCredentials> {
  const extra: Partial<StoredCredentials> = { authMethod: method };
  if (f.clientId) extra.clientId = f.clientId;
  if (f.clientSecret) extra.clientSecret = f.clientSecret;
  if (f.apiKey) extra.apiKey = f.apiKey;
  if (f.apiKeyHeader) extra.apiKeyHeader = f.apiKeyHeader;
  if (f.jwtKey) extra.jwtKeyPath = f.jwtKey;
  if (f.jwtKid) extra.jwtKid = f.jwtKid;
  if (f.jwtIss) extra.jwtIss = f.jwtIss;
  if (f.jwtSub) extra.jwtSub = f.jwtSub;
  if (f.jwtAud) extra.jwtAud = f.jwtAud;
  if (f.clientCert) extra.clientCertPath = f.clientCert;
  if (f.clientKey) extra.clientKeyPath = f.clientKey;
  if (f.clientKeyPassphrase) extra.clientKeyPassphrase = f.clientKeyPassphrase;
  return extra;
}

// Gather every field the method needs: use a CLI flag when present, otherwise
// prompt. Identifiers/paths are trimmed; secrets (password, client secret, API
// key, key passphrase) are preserved verbatim.
async function collectLoginFields(
  method: LoginMethod,
  args: LoginArgs
): Promise<LoginFields> {
  const fields: LoginFields = {};
  const questions: PromptQuestion[] = [];

  const flagUser = String(args.user ?? "").trim();
  const flagPassword = args.password != null ? String(args.password) : "";
  const flagClientId = String(args.clientId ?? "").trim();
  const flagClientSecret = args.clientSecret != null ? String(args.clientSecret) : "";
  const flagApiKey = args.apiKey != null ? String(args.apiKey) : "";
  const flagJwtKey = String(args.jwtKey ?? "").trim();

  const wantUser = method === "basic" || method === "oauth-password";
  const wantPassword = method === "basic" || method === "oauth-password";
  const wantClient =
    method === "oauth-password" ||
    method === "oauth-client-credentials" ||
    method === "oauth-jwt-bearer";
  const wantJwtKey = method === "oauth-jwt-bearer";
  const wantApiKey = method === "api-key";

  if (wantUser) {
    if (flagUser) fields.user = flagUser;
    else
      questions.push({
        type: "input",
        name: "user",
        message: "Username:",
        validate: requiredValidator("Username"),
      });
  }
  if (wantPassword) {
    if (flagPassword) fields.password = flagPassword;
    else
      questions.push({
        type: "password",
        name: "password",
        message: "Password:",
        mask: "*",
        validate: requiredValidator("Password"),
      });
  }
  if (wantClient) {
    if (flagClientId) fields.clientId = flagClientId;
    else
      questions.push({
        type: "input",
        name: "clientId",
        message: "OAuth client id:",
        validate: requiredValidator("Client id"),
      });
    if (flagClientSecret) fields.clientSecret = flagClientSecret;
    else
      questions.push({
        type: "password",
        name: "clientSecret",
        message: "OAuth client secret:",
        mask: "*",
        validate: requiredValidator("Client secret"),
      });
  }
  if (wantJwtKey) {
    if (flagJwtKey) fields.jwtKey = flagJwtKey;
    else
      questions.push({
        type: "input",
        name: "jwtKey",
        message: "Path to JWT signing key (PEM):",
        validate: requiredValidator("JWT key path"),
      });
  }
  if (wantApiKey) {
    if (flagApiKey) fields.apiKey = flagApiKey;
    else
      questions.push({
        type: "password",
        name: "apiKey",
        message: "API key:",
        mask: "*",
        validate: requiredValidator("API key"),
      });
  }

  if (questions.length > 0) {
    const answers = (await inquirer.prompt(
      questions as never
    )) as Record<string, unknown>;
    if (answers.user != null) fields.user = String(answers.user).trim();
    if (answers.password != null) fields.password = String(answers.password);
    if (answers.clientId != null) fields.clientId = String(answers.clientId).trim();
    if (answers.clientSecret != null)
      fields.clientSecret = String(answers.clientSecret);
    if (answers.jwtKey != null) fields.jwtKey = String(answers.jwtKey).trim();
    if (answers.apiKey != null) fields.apiKey = String(answers.apiKey);
  }

  // Optional / orthogonal material — flags only (advanced settings). The JWT
  // subject falls back to --user when the method is jwt-bearer.
  if (flagUser && method === "oauth-jwt-bearer") fields.user = flagUser;
  if (args.apiKeyHeader) fields.apiKeyHeader = String(args.apiKeyHeader).trim();
  if (args.jwtKid) fields.jwtKid = String(args.jwtKid).trim();
  if (args.jwtIss) fields.jwtIss = String(args.jwtIss).trim();
  if (args.jwtSub) fields.jwtSub = String(args.jwtSub).trim();
  if (args.jwtAud) fields.jwtAud = String(args.jwtAud).trim();
  if (args.clientCert) fields.clientCert = String(args.clientCert).trim();
  if (args.clientKey) fields.clientKey = String(args.clientKey).trim();
  if (args.clientKeyPassphrase != null)
    fields.clientKeyPassphrase = String(args.clientKeyPassphrase);

  return fields;
}

export async function loginCommand(args: LoginArgs): Promise<void> {
  setLogLevel(args);

  const { instance: instanceArg } = args;

  let normalizedInstance: string;
  if (instanceArg) {
    normalizedInstance = instanceArg.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  } else {
    const { instance } = await inquirer.prompt<{ instance: string }>([
      {
        type: "input",
        name: "instance",
        message: "ServiceNow instance (e.g. dev12345.service-now.com):",
        validate: (v: string) =>
          v.trim().length > 0 ? true : "Instance URL is required.",
      },
    ]);
    normalizedInstance = instance.trim().replace(/^https?:\/\//, "").replace(/\/$/, "");
  }

  // Pick the authentication method: honour --auth-method when given (rejecting
  // an unknown value), otherwise prompt. Basic stays the default.
  let method = normalizeLoginMethod(args.authMethod);
  if (args.authMethod && !method) {
    logger.error(
      `Unknown auth method "${args.authMethod}". Valid values: ${[
        ...KNOWN_LOGIN_METHODS,
      ].join(", ")}.`
    );
    process.exit(1);
  }
  if (!method) {
    const answer = (await inquirer.prompt([
      {
        type: "list",
        name: "method",
        message: "Authentication method:",
        choices: LOGIN_METHOD_CHOICES,
        default: "basic",
      },
    ] as never)) as { method: LoginMethod };
    method = answer.method;
  }

  const fields = await collectLoginFields(method, args);

  logger.info(`Connecting to ${normalizedInstance} using ${method} auth...`);

  // Apply this method's material to the process env so the verification client
  // resolves exactly these credentials (and mTLS cert/key, which are env-only),
  // mirroring a later CLI run against the .env we are about to write. Then build
  // a fresh default client and verify before persisting anything.
  const loginEnv = buildLoginEnv(normalizedInstance, method, fields);
  applyLoginEnv(loginEnv);
  const { defaultClient, resetClient } = await import("./snClient.js");
  resetClient();
  try {
    await defaultClient().checkConnection(8000);
  } catch (e) {
    logger.error(
      `Cannot authenticate to ${normalizedInstance} using ${method}. Check the instance URL and credentials.`
    );
    process.exit(1);
  }

  // A plain Basic login (no orthogonal mTLS material) is stored exactly as
  // before — three fields, method inferred — so legacy stores round-trip.
  const hasExtra =
    method !== "basic" ||
    !!fields.clientCert ||
    !!fields.clientKey ||
    !!fields.clientKeyPassphrase;
  if (hasExtra) {
    await saveCredentials(
      normalizedInstance,
      fields.user ?? "",
      fields.password ?? "",
      buildStoredExtra(method, fields)
    );
  } else {
    await saveCredentials(normalizedInstance, fields.user ?? "", fields.password ?? "");
  }

  // Persist the method's SN_* keys to a local .env for the workspace and keep it
  // out of version control. Secrets (client secret, API key) are written; the
  // JWT key and mTLS cert/key are written by path only.
  try {
    const envPath = path.join(process.cwd(), ".env");
    await writeDotEnv(envPath, loginEnv);
    await ensureGitignored(process.cwd(), ".env");
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    logger.warn(`Logged in, but failed to write .env: ${message}`);
  }

  const existingActive = await getActiveInstance();
  if (!existingActive) {
    await setActiveInstance(normalizedInstance);
    logger.success(`Logged in to ${normalizedInstance} and set as active instance.`);
  } else {
    logger.success(`Logged in to ${normalizedInstance}.`);
    if (existingActive !== normalizedInstance) {
      const { switchActive } = await inquirer.prompt<{ switchActive: boolean }>([
        {
          type: "confirm",
          name: "switchActive",
          message: `Set ${normalizedInstance} as the active instance? (current: ${existingActive})`,
          default: true,
        },
      ]);
      if (switchActive) {
        await setActiveInstance(normalizedInstance);
        await preloadStoredCredentials();
        logger.success(`Active instance switched to ${normalizedInstance}.`);
      }
    }
  }

  await preloadStoredCredentials();

  try {
    const { createdConfig, sourcePath } = await bootstrapWorkspaceOnLogin();
    if (createdConfig) {
      logger.info(`Created default sync.config.js in ${process.cwd()}.`);
    }
    logger.info(`Workspace structure ready. Source directory: ${sourcePath}`);
  } catch (e) {
    let message = "Unknown error";
    if (e instanceof Error && e.message.trim()) {
      message = e.message;
    }
    logger.warn(`Logged in, but failed to prepare workspace structure: ${message}`);
  }

  logger.info("Run `syncrona init` to discover scope and generate sync.manifest.json.");
}

export async function logoutCommand(
  args: Sync.SharedCmdArgs & { instance?: string; all?: boolean }
): Promise<void> {
  setLogLevel(args);

  if (args.all) {
    const count = await removeAllCredentials();
    // Removing every credential must also clear the active-instance marker;
    // otherwise it points at an instance that no longer has stored credentials.
    await setActiveInstance("");
    clearStoredCredentialsCache();
    logger.success(`Removed credentials for ${count} instance(s).`);
    return;
  }

  const targetInstance = args.instance;
  if (!targetInstance) {
    logger.error("Specify an instance to log out from, or use --all to remove all.");
    logger.info("Example: syncrona logout dev12345.service-now.com");
    process.exit(1);
  }

  const normalizedInstance = targetInstance
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  await removeCredentials(normalizedInstance);
  clearStoredCredentialsCache();

  const active = await getActiveInstance();
  if (active === normalizedInstance) {
    const remaining = await listInstances();
    if (remaining.length > 0) {
      await setActiveInstance(remaining[0]);
      logger.info(`Active instance reset to ${remaining[0]}.`);
    } else {
      // No instances left — clear the marker instead of leaving it pointing at
      // the instance we just removed.
      await setActiveInstance("");
    }
  }

  logger.success(`Logged out from ${normalizedInstance}.`);
}

export async function instancesCommand(args: Sync.SharedCmdArgs): Promise<void> {
  setLogLevel(args);

  const all = await listInstances();
  const active = await getActiveInstance();

  if (all.length === 0) {
    logger.info("No saved instances. Run `syncrona login` to add one.");
    return;
  }

  logger.info("Saved instances:");
  for (const inst of all) {
    const marker = inst === active ? " (active)" : "";
    logger.info(`  ${inst}${marker}`);
  }
}

export async function useCommand(
  args: Sync.SharedCmdArgs & { instance: string }
): Promise<void> {
  setLogLevel(args);

  const normalizedInstance = args.instance
    .trim()
    .replace(/^https?:\/\//, "")
    .replace(/\/$/, "");

  const all = await listInstances();
  if (!all.includes(normalizedInstance)) {
    logger.error(
      `No saved credentials for "${normalizedInstance}". Run: syncrona login ${normalizedInstance}`
    );
    process.exit(1);
  }

  await setActiveInstance(normalizedInstance);
  await preloadStoredCredentials();
  logger.success(`Active instance set to ${normalizedInstance}.`);
}
