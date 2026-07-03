# @syncro-now-ai/jira

<!-- badges:start -->
| ![npm: not yet published](https://img.shields.io/badge/npm-not%20yet%20published-lightgrey?style=flat-square&logo=npm&logoColor=white) | [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org) | [![license](https://img.shields.io/github/license/IvanBBaev/syncrona?style=flat-square&color=blue&label=license)](../../LICENSE) | [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/syncrona/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/syncrona/actions/workflows/ci.yml) | [![coverage](https://img.shields.io/codecov/c/github/IvanBBaev/syncrona/main?flag=jira&style=flat-square&logo=codecov&logoColor=white&label=coverage)](https://codecov.io/gh/IvanBBaev/syncrona) | [![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) |
|:--:|:--:|:--:|:--:|:--:|:--:|
<!-- badges:end -->

Shared **read-only Jira client** for SyncroNow AI. It fetches rich issue context
(summary, description, status, type, priority, assignee/reporter, labels,
components, parent, subtasks, links, fix versions and recent comments) and is
consumed by both the core CLI (`syncro-now-ai jira`) and the MCP server
(`jira_get_issue` tool).

It supports **Jira Cloud** and **Jira Server / Data Center**, auto-detecting the
deployment flavour from the base URL and rendering Cloud ADF (Atlassian Document
Format) descriptions/comments down to plain text.

> This package is read-only — it never writes to Jira.

## Deployment detection

| Base URL host                     | Detected deployment | REST API | Auth                              |
| --------------------------------- | ------------------- | -------- | --------------------------------- |
| `*.atlassian.net`, `*.jira.com`   | `cloud`             | `/rest/api/3` (ADF bodies) | HTTP Basic: `email:token` (base64) |
| anything else (self-hosted)       | `server`            | `/rest/api/2` (text/wiki)  | Bearer personal access token (PAT) |

Detection is a pure URL check (no network call). You can override it explicitly
(via `JIRA_DEPLOYMENT` or the `jira-login` prompt) — the chosen value is then
stored, and lookups never re-guess.

## Configuration

Configuration is resolved into a `JiraConfig` (`baseUrl`, `deployment`, `token`,
optional `email`) via `resolveJiraConfig` / `resolveJiraConfigSync`.

### Environment variables

| Variable          | Required            | Purpose                                                                                              |
| ----------------- | ------------------- | ---------------------------------------------------------------------------------------------------- |
| `JIRA_BASE_URL`   | yes                 | Jira base URL, e.g. `https://acme.atlassian.net` (Cloud) or `https://jira.acme.com` (Server / DC). A trailing `/` is stripped. |
| `JIRA_TOKEN`      | yes                 | Cloud API token, or a Server / Data Center Personal Access Token (PAT). Whitespace is **not** trimmed — surrounding whitespace can be significant. |
| `JIRA_EMAIL`      | Cloud only          | Atlassian account email; paired with `JIRA_TOKEN` as HTTP Basic for Cloud. Omit for Server / DC (PAT is sent as a Bearer token). |
| `JIRA_DEPLOYMENT` | no                  | Force the deployment type: `cloud` or `server`. Any other value (or unset) falls back to auto-detection from `JIRA_BASE_URL`. |

An env config is only used when **both** `JIRA_BASE_URL` and `JIRA_TOKEN` are
set; otherwise it is ignored and resolution falls through to stored credentials.

### Stored credentials & profiles

`syncro-now-ai jira-login` saves credentials in the same encrypted global
CredentialStore used for ServiceNow logins (AES-256-GCM at rest). Each login is
keyed by a **profile** name (default: `default`); pass `--profile <name>` to
`jira-login`, `jira-logout` and `jira` to keep several Jira sites side by side.
`jira-logout --all` removes every stored Jira profile.

### Resolution precedence

`resolveJiraConfig({ profile })` picks the first usable source:

- **With an explicit `--profile <name>`** — the named stored profile wins (a
  deliberate choice); only if it has no usable credentials does it fall back to
  the environment variables.
- **Without an explicit profile** — environment variables win first (so CI /
  one-off runs need no stored login), then the `default` stored profile.

Returns `null` when nothing is configured.

## Issue-key resolution from git branches

`syncro-now-ai jira` (with no key argument) derives the issue key from the
current git branch via `extractIssueKey`. It matches the first
`([A-Z][A-Z0-9]+)-(\d+)` token (case-insensitively), so
`feature/SCRUM-123-add-widget` resolves to `SCRUM-123`.

## Programmatic use

```ts
import { resolveJiraConfig, getIssue, verifyAuth } from "@syncro-now-ai/jira";

const config = await resolveJiraConfig({ profile: "default" });
if (!config) throw new Error("No Jira configuration");

await verifyAuth(config);            // throws on bad credentials
const issue = await getIssue(config, "SCRUM-123");
```

Key exports: `resolveJiraConfig` / `resolveJiraConfigSync`, `getIssue`,
`verifyAuth`, `buildAuthHeader`, `detectDeployment`, `restApiBase`,
`extractIssueKey`, `adfToText`, `normalizeIssue`, plus the `types` and message
helpers.

## See also

- Root [README](../../README.md) — the `jira` / `jira-login` / `jira-logout`
  CLI commands.
- [packages/mcp-server/README.md](../mcp-server/README.md) — the
  `jira_get_issue` MCP tool.
