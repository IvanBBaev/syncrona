// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Resolve a {@link JiraConfig} for a profile.
 *
 * Precedence depends on intent:
 * - An *explicit* profile (a non-empty name the caller passed via `--profile`)
 *   is a deliberate choice, so it is the *only* source consulted: when it has no
 *   usable stored credentials the result is null, never the ambient environment.
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
    // Deliberately named profile wins over ambient env — exclusively. This used
    // to be `fromStore ?? configFromEnv(process.env)`, which turned "that
    // profile has no usable credentials" into "silently use whatever JIRA_* the
    // shell exports": a typo'd `--profile`, a deleted profile, or a credential
    // file that stopped decrypting after a machine-key change all redirected the
    // request to a *different* Jira tenant and printed an issue (or a not-found)
    // from the wrong site. It also made the caller's
    // `jiraCredentialHealth(profile) === "undecryptable"` hint unreachable
    // whenever any JIRA_* var was set, because a config had already been
    // resolved. Returning null lets the caller report the real cause (REV-130).
    return configFromStored(await loadJiraCredentials(explicitProfile));
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
    // No ambient-env fallback here either — see the async twin above (REV-130).
    return configFromStored(loadJiraCredentialsSync(explicitProfile));
  }
  const fromEnv = configFromEnv(process.env);
  if (fromEnv) {
    return fromEnv;
  }
  return configFromStored(loadJiraCredentialsSync(DEFAULT_PROFILE));
}
