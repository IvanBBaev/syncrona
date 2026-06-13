# Syncrona vs the alternatives

A one-page comparison for teams deciding how to manage ServiceNow scoped-app
code. (Companion to [BUSINESS_ANALYSIS.md](BUSINESS_ANALYSIS.md) §4.)

## At a glance

| | **Syncrona** | ServiceNow Studio + native Git | Sincronia / `sinc` (predecessor) | Update sets / bespoke scripts |
|---|---|---|---|---|
| Edit in your own editor (VS Code, etc.) | ✅ | partial (in-platform) | ✅ | ❌ |
| Git-based diff / PR review of code | ✅ | ✅ | ✅ | ❌ |
| Local build pipeline (TS/Babel/Webpack/Sass) | ✅ | ❌ | ✅ | ❌ |
| Multi-scope CLI from one repo | ✅ | partial | ✅ | ❌ |
| AI / MCP analysis (metadata, dependency, impact) | ✅ | ❌ | ❌ | ❌ |
| Works **without** a companion scoped app | ✅ | n/a | ❌ (needs server app) | n/a |
| Quality gates / tests / audit shipped | ✅ | n/a | partial | ❌ |
| First-party support & SLA | ❌ | ✅ | ❌ | n/a |
| OAuth / SSO auth | ⏳ roadmap | ✅ | ❌ | ✅ |
| Maintained / active | ✅ (early) | ✅ | ⚠️ legacy | n/a |

✅ yes · ⏳ planned · ⚠️ caveat · ❌ no

## When to choose what

- **Choose Syncrona** if your team already lives in Git/CI, runs **multiple**
  scoped apps, wants a real local build pipeline, or wants AI/MCP tooling that
  understands your scope's metadata and dependencies — and can authenticate with
  a least-privilege integration user (Basic auth today; OAuth on the roadmap).
- **Choose ServiceNow native Git** if first-party support, OAuth/SSO, and zero
  third-party tooling are hard requirements and you don't need local build
  pipelines or AI analysis.
- **Migrating from Sincronia / `sinc`** — Syncrona is the modern successor:
  Node 22, registry-driven CLI + MCP, governance/audit, and it works with or
  without the companion app. The workflow concepts carry over.
- **Update sets / bespoke scripts** work until they don't — no repeatable build,
  no Git review, no automation. Syncrona is the step up when that hurts.

## The one-line difference

> ServiceNow's native Git moved your **code** into Git. Syncrona moves your
> **workflow** into modern engineering — local build pipelines, a multi-scope
> CLI, and an AI layer that understands your scope.

## Honest gaps (today)

Syncrona is pre-1.0. Versus first-party tooling it still lacks **OAuth/SSO**
(Basic auth only — see [SECURITY.md](../SECURITY.md)), a **support SLA**, and a
published **distribution** (Homebrew/Windows installer). These are the active
priorities — see the roadmap in [BUSINESS_ANALYSIS.md](BUSINESS_ANALYSIS.md) §8.
