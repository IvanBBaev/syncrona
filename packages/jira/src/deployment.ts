// SPDX-License-Identifier: GPL-3.0-or-later
import type { JiraDeployment } from "./types";

/**
 * Detect the Jira deployment flavour from a base URL.
 *
 * Atlassian Cloud sites are always served from `*.atlassian.net` (or the legacy
 * `*.jira.com`); anything else is treated as a self-hosted Server/Data Center
 * instance. Pure — no I/O — so a wrong guess at login can be overridden by the
 * user and the chosen value is then stored explicitly (lookups never re-guess).
 */
export function detectDeployment(baseUrl: string): JiraDeployment {
  let host = "";
  try {
    host = new URL(baseUrl).host.toLowerCase();
  } catch {
    // Not a parseable URL — fall back to a substring check so callers that pass
    // a bare host still get a sensible default.
    host = String(baseUrl || "").toLowerCase();
  }
  if (host.endsWith(".atlassian.net") || host.endsWith(".jira.com")) {
    return "cloud";
  }
  return "server";
}

/**
 * REST API base path for the deployment. Cloud uses v3 (ADF document bodies);
 * Server/Data Center exposes v2 (text/wiki bodies). Both share the rest of the
 * `/issue/{key}` shape used by the client.
 */
export function restApiBase(deployment: JiraDeployment): string {
  return deployment === "cloud" ? "/rest/api/3" : "/rest/api/2";
}
