// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Resolve a {@link JiraConfig} for a profile. Precedence: environment variables
 * first (so CI / one-off runs need no stored login), then the encrypted
 * credential store. Returns null when nothing is configured.
 */
import {
  loadJiraCredentials,
  loadJiraCredentialsSync,
  type StoredJiraCredentials,
} from "@syncro-now-ai/credential-store";
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

/** Async resolution (core CLI): env first, then the credential store. */
export async function resolveJiraConfig(opts: { profile?: string } = {}): Promise<JiraConfig | null> {
  const fromEnv = configFromEnv(process.env);
  if (fromEnv) {
    return fromEnv;
  }
  const profile = (opts.profile || "").trim() || DEFAULT_PROFILE;
  const stored = await loadJiraCredentials(profile);
  return configFromStored(stored);
}

/**
 * Sync resolution (MCP runtime): env first, then the credential store. Never
 * throws — returns null when nothing usable is configured.
 */
export function resolveJiraConfigSync(opts: { profile?: string } = {}): JiraConfig | null {
  const fromEnv = configFromEnv(process.env);
  if (fromEnv) {
    return fromEnv;
  }
  const profile = (opts.profile || "").trim() || DEFAULT_PROFILE;
  const stored = loadJiraCredentialsSync(profile);
  return configFromStored(stored);
}
