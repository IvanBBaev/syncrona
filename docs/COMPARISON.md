# SyncroNow AI vs the alternatives

A one-page comparison for teams deciding how to manage ServiceNow scoped-app
code. (Companion to [BUSINESS_ANALYSIS.md](BUSINESS_ANALYSIS.md) §4.)

## At a glance

| | **SyncroNow AI** | ServiceNow SDK (`now-sdk` / Fluent) | ServiceNow Studio + native Git | Sincronia / `sinc` (predecessor) | Update sets / bespoke scripts |
|---|---|---|---|---|---|
| Edit in your own editor (VS Code, etc.) | ✅ | ✅ | partial (in-platform) | ✅ | ❌ |
| Git-based diff / PR review of code | ✅ | ✅ | ✅ | ✅ | ❌ |
| Works on existing (non-Fluent) scoped apps as plain files | ✅ | ⚠️ converts them to Fluent first | ✅ | ✅ | n/a |
| Create / delete records from local source | ✅ `push --create` / `--prune` (1.1.0) | ✅ | ✅ | ❌ | ❌ |
| Fluent (`.now.ts`) build / transform / pack / install | ✅ via the optional `fluent` tier (drives the SDK) | ✅ | ❌ | ❌ | ❌ |
| Local build pipeline (TS/Babel/Webpack/Sass) | ✅ | partial (TS/JS modules) | ❌ | ✅ | ❌ |
| Multi-scope CLI from one repo | ✅ | ❌ (one app per project) | partial | ✅ | ❌ |
| ATF / app-repo CI driver (`sn_cicd`) | ✅ `cicd` (1.1.0) | ✅ | ❌ | ❌ | ❌ |
| AI / MCP analysis (metadata, dependency, impact) | ✅ | ❌ | ❌ | ❌ | ❌ |
| Works **without** a companion scoped app | ✅ | ✅ | n/a | ❌ (needs server app) | n/a |
| Quality gates / tests / audit shipped | ✅ | n/a | n/a | partial | ❌ |
| First-party support & SLA | ❌ | ✅ | ✅ | ❌ | n/a |
| OAuth / SSO auth | ✅ CLI (OAuth 2.0) · ⏳ MCP | ✅ OAuth · UI-session "basic" | ✅ | ❌ | ✅ |
| API key / mutual TLS | ✅ (not in the `fluent` tier) | ❌ | n/a (in-platform) | ❌ | n/a |
| Maintained / active | ✅ | ✅ | ✅ | ⚠️ legacy | n/a |

✅ yes · ⏳ planned · ⚠️ caveat · ❌ no

## When to choose what

- **Choose SyncroNow AI** if your team already lives in Git/CI, runs **multiple**
  scoped apps, wants a real local build pipeline, or wants AI/MCP tooling that
  understands your scope's metadata and dependencies — and can authenticate with
  a least-privilege integration user (Basic auth, OAuth 2.0, an API key, or mutual
  TLS in the CLI).
- **Choose the ServiceNow SDK (`now-sdk`)** if you are starting a new
  application and want to author it as Fluent code with first-party support.
  You do not have to choose one or the other: `syncrona fluent` drives the SDK
  with syncrona's credential store, prompts and exit codes, so Fluent and
  file-based scopes can share one CLI. See
  [MIGRATING_FROM_NOW_SDK.md](MIGRATING_FROM_NOW_SDK.md).
- **Choose ServiceNow native Git** if first-party support, OAuth/SSO, and zero
  third-party tooling are hard requirements and you don't need local build
  pipelines or AI analysis.
- **Migrating from Sincronia / `sinc`** — SyncroNow AI is the modern successor:
  Node 22, registry-driven CLI + MCP, governance/audit, and it works with or
  without the companion app. The workflow concepts carry over.
- **Update sets / bespoke scripts** work until they don't — no repeatable build,
  no Git review, no automation. SyncroNow AI is the step up when that hurts.

## The one-line difference

> ServiceNow's native Git moved your **code** into Git, and the ServiceNow SDK
> lets you write new apps **as code**. SyncroNow AI moves your **workflow** into
> modern engineering — for existing apps and Fluent apps alike — with local
> build pipelines, a multi-scope CLI, and an AI layer that understands your scope.

## Honest gaps (today)

Versus first-party tooling SyncroNow AI still lacks **full SSO** (OAuth password,
client-credentials and JWT-bearer grants ship, plus inbound REST API key and
mutual TLS — but not the authorization-code/SSO flow; see
[SECURITY.md](../SECURITY.md)), a **support SLA**, and distribution beyond npm
(`npx syncrona` works since 0.9.1; a Homebrew tap and a native Windows installer
do not exist yet). These are the active priorities — see the roadmap in
[BUSINESS_ANALYSIS.md](BUSINESS_ANALYSIS.md) §8.

Versus the ServiceNow SDK specifically:

- **Flow Designer and UI Builder** are not editable as source in the file-based
  tier. Use Fluent through `syncrona fluent` where the SDK supports them.
- **Data-model records are independent sidecars.** A table, its columns and its
  choices are tracked as separate records (opt-in `dataModelTables`, see
  [DATA_MODEL.md](DATA_MODEL.md)). Composite parent-plus-children documents are
  not available yet.
- **API-key and mutual-TLS profiles do not reach the `fluent` tier.** The SDK's
  install, reinstall and update-set export endpoints accept only a UI session,
  so only Basic and OAuth profiles work for instance-side `fluent` actions.
- **Type definitions come from the SDK.** `fluent types` delegates to it, and
  native generation from `sys_dictionary` is not built yet. There is no
  `explain` counterpart.
- **Live-instance verification is pending for the 1.1.0 write paths:**
  `push --create` / `--prune`, `init --new`, `cicd`, `fluent install` and the
  data-model round-trip are covered by mocked tests but have not yet been run
  against a live instance.
