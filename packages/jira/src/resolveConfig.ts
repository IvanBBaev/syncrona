// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Resolve a {@link JiraConfig} for a profile.
 *
 * Precedence depends on intent:
 * - An *explicit* profile (a non-empty name the caller passed via `--profile`)
 *   is a deliberate choice, so it is tried first; only if it has no usable stored
 *   credentials do we fall back to the environment.
 * - With *no* explicit profile, environment variables win (so CI / one-off runs
 *   need no stored login), then the `"default"` stored profile.
 *
 * Returns null when nothing is configured.
 */
import {
  loadJiraCredentials,
  loadJiraCredentialsSync,
  type StoredJiraCredentials,
} from "@syncrona/credential-store";
import { detectDeployment } from "./deployment";
import type { JiraConfig, JiraDeployment } from "./types";

const DEFAULT_PROFILE = "default";

function normalizeDeployment(
  value: string | undefined,
  baseUrl: string
): JiraDeployment {
  const raw = (value || "").trim().toLowerCase();
  if (raw === "cloud" || raw === "server") {
    return raw;
  }
  return detectDeployment(baseUrl);
}

/** Build a config from environment variables, or null when not fully set. */
function configFromEnv(env: NodeJS.ProcessEnv): JiraConfig | null {
  const baseUrl = (env.JIRA_BASE_URL || "").trim().replace(/\/$/, "");
  // Do not trim the token — surrounding whitespace can be significant.
  const token = env.JIRA_TOKEN || "";
  if (!baseUrl || !token) {
    return null;
  }
  const deployment = normalizeDeployment(env.JIRA_DEPLOYMENT, baseUrl);
  const email = (env.JIRA_EMAIL || "").trim();
  const config: JiraConfig = { baseUrl, deployment, token };
  if (email) {
    config.email = email;
  }
  return config;
}

function configFromStored(stored: StoredJiraCredentials | null): JiraConfig | null {
  if (!stored) {
    return null;
  }
  const baseUrl = (stored.baseUrl || "").trim().replace(/\/$/, "");
  const token = stored.token || "";
  if (!baseUrl || !token) {
    return null;
  }
  const deployment = normalizeDeployment(stored.deployment, baseUrl);
  const config: JiraConfig = { baseUrl, deployment, token };
  const email = (stored.email || "").trim();
  if (email) {
    config.email = email;
  }
  return config;
}

/** Async resolution (core CLI). See the precedence note on the module doc. */
export async function resolveJiraConfig(opts: { profile?: string } = {}): Promise<JiraConfig | null> {
  const explicitProfile = (opts.profile || "").trim();
  if (explicitProfile) {
    // Deliberately named profile wins over ambient env.
    const fromStore = configFromStored(await loadJiraCredentials(explicitProfile));
    return fromStore ?? configFromEnv(process.env);
  }
  const fromEnv = configFromEnv(process.env);
  if (fromEnv) {
    return fromEnv;
  }
  return configFromStored(await loadJiraCredentials(DEFAULT_PROFILE));
}

/**
 * Sync resolution (MCP runtime). Same precedence as {@link resolveJiraConfig}.
 * Never throws — returns null when nothing usable is configured.
 */
export function resolveJiraConfigSync(opts: { profile?: string } = {}): JiraConfig | null {
  const explicitProfile = (opts.profile || "").trim();
  if (explicitProfile) {
    const fromStore = configFromStored(loadJiraCredentialsSync(explicitProfile));
    return fromStore ?? configFromEnv(process.env);
  }
  const fromEnv = configFromEnv(process.env);
  if (fromEnv) {
    return fromEnv;
  }
  return configFromStored(loadJiraCredentialsSync(DEFAULT_PROFILE));
}
