import { existsSync, readFileSync } from "fs";
import path from "path";
import {
  getActiveInstanceSync,
  loadCredentialsSync,
} from "@syncrona/credential-store";
import {
  DEFAULT_SCOPED_API_PREFIXES,
  MAX_REQUESTS_PER_SECOND,
  SCOPED_API_PREFIXES_ENV,
  isEndpointNotFoundStatus,
  orderScopedApiPrefixes,
  parseConfiguredScopedApiPrefixes,
  shouldRetryStatus,
} from "@syncrona/sn-transport";
import { logger } from "./logger";

type SNConfig = {
  instance: string;
  user: string;
  password: string;
};

export type SecretsProvider = {
  name: string;
  load: (projectDir: string) => Record<string, string>;
};

const MAX_REQUEST_ATTEMPTS = 3;
const BASE_RETRY_DELAY_MS = 120;

let cachedScopedApiPrefix: string | null = null;

// Test seam: the last-successful-prefix cache is module state and otherwise
// leaks ordering effects between unit tests.
export function clearScopedApiPrefixCache(): void {
  cachedScopedApiPrefix = null;
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object") {
    return {};
  }

  return value as Record<string, unknown>;
}

export function cleanEnvValue(value: string): string {
  return value.trim().replace(/^['"]|['"]$/g, "");
}

export function parseDotEnv(raw: string): Record<string, string> {
  const result: Record<string, string> = {};
  const lines = raw.split(/\r?\n/);

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const idx = trimmed.indexOf("=");
    if (idx <= 0) {
      continue;
    }
    const key = trimmed.slice(0, idx).trim();
    const value = cleanEnvValue(trimmed.slice(idx + 1));
    result[key] = value;
  }

  return result;
}

function loadFromProcessEnv(): Record<string, string> {
  return {
    SN_INSTANCE: cleanEnvValue(process.env.SN_INSTANCE || ""),
    SN_USER: cleanEnvValue(process.env.SN_USER || ""),
    SN_PASSWORD: cleanEnvValue(process.env.SN_PASSWORD || ""),
  };
}

function loadFromAuthStore(): Record<string, string> {
  const activeInstance = getActiveInstanceSync();
  if (!activeInstance) {
    return {};
  }

  const creds = loadCredentialsSync(activeInstance);
  if (!creds) {
    return {};
  }

  return {
    SN_INSTANCE: cleanEnvValue(creds.instance || activeInstance || ""),
    SN_USER: cleanEnvValue(creds.user || ""),
    SN_PASSWORD: cleanEnvValue(creds.password || ""),
  };
}

export function loadAuthStoreProfile(instanceName: string): SNConfig | null {
  const cleaned = cleanEnvValue(instanceName);
  if (!cleaned) {
    return null;
  }

  const creds = loadCredentialsSync(cleaned);
  if (!creds) {
    return null;
  }

  const instance = cleanEnvValue(creds.instance || cleaned);
  const user = cleanEnvValue(creds.user || "");
  const password = cleanEnvValue(creds.password || "");
  if (!instance || !user || !password) {
    return null;
  }
  return { instance, user, password };
}

function loadFromDotEnv(projectDir: string): Record<string, string> {
  const envPath = path.join(projectDir, ".env");
  try {
    return parseDotEnv(readFileSync(envPath, "utf-8"));
  } catch (error) {
    logger.debug("secrets.dotenv.read_failed", {
      path: envPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

function loadFromSecretsFile(projectDir: string): Record<string, string> {
  const fromEnv = cleanEnvValue(process.env.SYNCRONA_SECRETS_FILE || "");
  const secretsPath = fromEnv || path.join(projectDir, ".syncrona-mcp", "secrets.json");
  if (!existsSync(secretsPath)) {
    return {};
  }

  try {
    const parsed = asRecord(JSON.parse(readFileSync(secretsPath, "utf-8")));
    const serviceNow = asRecord(parsed.servicenow);

    const instance = cleanEnvValue(
      String(parsed.SN_INSTANCE || serviceNow.instance || "")
    );
    const user = cleanEnvValue(String(parsed.SN_USER || serviceNow.user || ""));
    const password = cleanEnvValue(
      String(parsed.SN_PASSWORD || serviceNow.password || "")
    );

    return {
      SN_INSTANCE: instance,
      SN_USER: user,
      SN_PASSWORD: password,
    };
  } catch (error) {
    logger.debug("secrets.file.parse_failed", {
      path: secretsPath,
      error: error instanceof Error ? error.message : String(error),
    });
    return {};
  }
}

// Provider precedence mirrors the core CLI, where project-local sources
// (.env loaded into the environment) win over the global credential store:
// process env > explicit MCP secrets file > project .env > auth store.
const DEFAULT_SECRETS_PROVIDERS: SecretsProvider[] = [
  {
    name: "process-env",
    load: () => loadFromProcessEnv(),
  },
  {
    name: "secrets-file",
    load: (projectDir: string) => loadFromSecretsFile(projectDir),
  },
  {
    name: "dotenv",
    load: (projectDir: string) => loadFromDotEnv(projectDir),
  },
  {
    name: "auth-store",
    load: () => loadFromAuthStore(),
  },
];

// Resolving secrets touches the filesystem and (for the auth store) runs a
// blocking scrypt key derivation, so the result is cached per projectDir for
// a short TTL instead of being recomputed on every ServiceNow request.
const SECRETS_CACHE_TTL_MS = 30_000;
const secretsCache = new Map<string, { config: SNConfig; expiresAt: number }>();

export function clearServiceNowSecretsCache(): void {
  secretsCache.clear();
}

export function resolveServiceNowSecrets(
  projectDir: string = process.cwd(),
  providers: SecretsProvider[] = DEFAULT_SECRETS_PROVIDERS
): SNConfig {
  const merged: Record<string, string> = {
    SN_INSTANCE: "",
    SN_USER: "",
    SN_PASSWORD: "",
  };

  for (const provider of providers) {
    // Stop as soon as every key is filled so lower-priority providers
    // (notably the scrypt-backed auth store) are not consulted needlessly.
    if (Object.values(merged).every((value) => value !== "")) {
      break;
    }
    const values = provider.load(projectDir);
    for (const key of Object.keys(merged)) {
      const candidate = cleanEnvValue(String(values[key] || ""));
      if (!merged[key] && candidate) {
        merged[key] = candidate;
      }
    }
  }

  const instance = merged.SN_INSTANCE;
  const user = merged.SN_USER;
  const password = merged.SN_PASSWORD;

  if (!instance || !user || !password) {
    throw new Error(
      "Missing ServiceNow credentials. Provide SN_INSTANCE, SN_USER, SN_PASSWORD via env, auth store (syncrona login), .syncrona-mcp/secrets.json, or .env in project root."
    );
  }

  return { instance, user, password };
}

export function getServiceNowConfig(projectDir: string = process.cwd()): SNConfig {
  const cached = secretsCache.get(projectDir);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.config;
  }

  const config = resolveServiceNowSecrets(projectDir);
  secretsCache.set(projectDir, {
    config,
    expiresAt: Date.now() + SECRETS_CACHE_TTL_MS,
  });
  return config;
}

export function instanceToBaseUrl(instance: string): string {
  if (instance.startsWith("http://") || instance.startsWith("https://")) {
    return `${instance.replace(/\/$/, "")}/`;
  }
  return `https://${instance.replace(/\/$/, "")}/`;
}

export { shouldRetryStatus };

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// G4: client-side rate limiting matching the core CLI's axios-rate-limit
// (shared MAX_REQUESTS_PER_SECOND policy) — requests are spaced by a minimum
// interval instead of relying solely on 429 retries.
const MIN_REQUEST_INTERVAL_MS = Math.ceil(1000 / MAX_REQUESTS_PER_SECOND);
let nextRequestSlotAt = 0;

async function acquireRequestSlot(): Promise<void> {
  const now = Date.now();
  const waitMs = Math.max(0, nextRequestSlotAt - now);
  nextRequestSlotAt = Math.max(now, nextRequestSlotAt) + MIN_REQUEST_INTERVAL_MS;
  if (waitMs > 0) {
    await sleep(waitMs);
  }
}

function buildScopedEndpoint(prefix: string, route: string): string {
  return `/api/${prefix}/${route.replace(/^\/+/, "")}`;
}

function scopedPrefixOrder(preferredPrefixes: string[] = []): string[] {
  const configured = parseConfiguredScopedApiPrefixes(
    cleanEnvValue(process.env[SCOPED_API_PREFIXES_ENV] || "")
  );
  return orderScopedApiPrefixes(configured, [
    ...preferredPrefixes,
    ...(cachedScopedApiPrefix ? [cachedScopedApiPrefix] : []),
  ]);
}

export async function snScopedApiRequest(
  method: string,
  route: string,
  body: unknown,
  timeoutMs: number,
  projectDir: string = process.cwd(),
  preferredPrefixes: string[] = []
): Promise<{ status: number; data: unknown; text: string; usedEndpoint: string }> {
  let lastNotFound: { status: number; data: unknown; text: string; usedEndpoint: string } | null = null;

  for (const prefix of scopedPrefixOrder(preferredPrefixes)) {
    const endpoint = buildScopedEndpoint(prefix, route);
    const response = await snRequest(method, endpoint, body, timeoutMs, projectDir);

    // Shared policy (matches the core CLI): 400/403/404 all mean "this scoped
    // namespace is unavailable", so try the next prefix.
    if (isEndpointNotFoundStatus(response.status)) {
      lastNotFound = { ...response, usedEndpoint: endpoint };
      continue;
    }

    // Only a successful response proves the prefix works — caching it on a
    // 5xx would poison subsequent requests with a bad prefix order.
    if (response.status >= 200 && response.status < 300) {
      cachedScopedApiPrefix = prefix;
    }
    return { ...response, usedEndpoint: endpoint };
  }

  if (lastNotFound) {
    return lastNotFound;
  }

  const fallbackPrefix = scopedPrefixOrder(preferredPrefixes)[0] || DEFAULT_SCOPED_API_PREFIXES[0];
  const fallbackEndpoint = buildScopedEndpoint(fallbackPrefix, route);
  const fallbackResponse = await snRequest(method, fallbackEndpoint, body, timeoutMs, projectDir);
  return { ...fallbackResponse, usedEndpoint: fallbackEndpoint };
}

export async function getCurrentScopeWithFallback(
  timeoutMs: number,
  projectDir: string = process.cwd()
): Promise<{ status: number; data: unknown; text: string; usedEndpoint: string }> {
  return snScopedApiRequest("GET", "sinc/getCurrentScope", undefined, timeoutMs, projectDir);
}

export async function snRequest(
  method: string,
  endpoint: string,
  body: unknown,
  timeoutMs: number,
  projectDir: string = process.cwd()
): Promise<{ status: number; data: unknown; text: string }> {
  return snRequestWithConfig(getServiceNowConfig(projectDir), method, endpoint, body, timeoutMs);
}

export async function snRequestWithConfig(
  config: SNConfig,
  method: string,
  endpoint: string,
  body: unknown,
  timeoutMs: number
): Promise<{ status: number; data: unknown; text: string }> {
  const { instance, user, password } = config;
  const baseUrl = instanceToBaseUrl(instance);
  const startedAt = Date.now();

  let lastError: unknown = null;
  for (let attempt = 1; attempt <= MAX_REQUEST_ATTEMPTS; attempt += 1) {
    await acquireRequestSlot();
    const elapsed = Date.now() - startedAt;
    const remaining = Math.max(timeoutMs - elapsed, 1);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), remaining);

    try {
      const auth = Buffer.from(`${user}:${password}`).toString("base64");
      const response = await fetch(`${baseUrl}${endpoint.replace(/^\//, "")}`, {
        method,
        headers: {
          Authorization: `Basic ${auth}`,
          "Content-Type": "application/json",
          Accept: "application/json, text/plain, text/html",
        },
        body: body === undefined || body === null ? undefined : JSON.stringify(body),
        signal: controller.signal,
      });

      const text = await response.text();
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch (_) {}

      if (attempt < MAX_REQUEST_ATTEMPTS && shouldRetryStatus(response.status)) {
        const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), 800);
        await sleep(delay);
        continue;
      }

      return {
        status: response.status,
        data,
        text,
      };
    } catch (error) {
      lastError = error;
      if (attempt >= MAX_REQUEST_ATTEMPTS) {
        throw error;
      }
      const delay = Math.min(BASE_RETRY_DELAY_MS * 2 ** (attempt - 1), 800);
      await sleep(delay);
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error("ServiceNow request failed after retry attempts.");
}

export function toTableResultRows(data: unknown): Record<string, unknown>[] {
  const obj = asRecord(data);
  const result = obj.result;
  if (!Array.isArray(result)) {
    return [];
  }
  return result.filter(
    (item): item is Record<string, unknown> => !!item && typeof item === "object"
  );
}

export function summarizeRows(
  rows: Record<string, unknown>[],
  analyzeField: string
): Record<string, number> {
  return rows.reduce<Record<string, number>>((acc, row) => {
    const key = String(row[analyzeField] ?? "<empty>");
    acc[key] = (acc[key] || 0) + 1;
    return acc;
  }, {});
}

export async function runBackgroundScript(
  script: string,
  timeoutMs: number,
  endpointPath?: string,
  projectDir: string = process.cwd()
): Promise<{ status: number; data: unknown; text: string; usedEndpoint: string }> {
  const apiAttempt =
    typeof endpointPath === "string" && endpointPath.trim().length > 0
      ? {
          ...(await snRequest("POST", endpointPath, { script }, timeoutMs, projectDir)),
          usedEndpoint: endpointPath,
        }
      : await snScopedApiRequest("POST", "sinc/runBackgroundScript", { script }, timeoutMs, projectDir);

  if (apiAttempt.status >= 200 && apiAttempt.status < 300) {
    return apiAttempt;
  }

  if (apiAttempt.status !== 404) {
    return apiAttempt;
  }

  const { instance, user, password } = getServiceNowConfig(projectDir);
  const baseUrl = instanceToBaseUrl(instance);
  const auth = Buffer.from(`${user}:${password}`).toString("base64");
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const form = new URLSearchParams();
    form.set("script", script);
    form.set("runscript", "Run script");

    const response = await fetch(`${baseUrl}sys.scripts.do`, {
      method: "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/x-www-form-urlencoded",
        Accept: "text/html,application/json,text/plain",
      },
      body: form.toString(),
      signal: controller.signal,
    });

    const text = await response.text();
    return {
      status: response.status,
      data: text,
      text,
      usedEndpoint: "/sys.scripts.do",
    };
  } finally {
    clearTimeout(timer);
  }
}

export function hasEnvFile(projectDir: string = process.cwd()): boolean {
  return existsSync(path.join(projectDir, ".env"));
}
