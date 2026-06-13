# Syncrona — Business Analysis

> Author lens: Business Analyst (BABOK-aligned). Companion to the engineering
> docs ([ARCHITECTURE.md](ARCHITECTURE.md), [PRODUCT_STATE.md](PRODUCT_STATE.md)).
> Last updated: 2026-06-13. This document is the product/market source of truth;
> the engineering `TODO`/`DONE` track delivery against it.

## 1. Product vision

**For** ServiceNow scoped-application developers and the teams that ship them,
**who** are constrained by in-platform Studio source control and manual change
movement, **Syncrona is** a local-first CLI + AI (MCP) toolchain **that** lets
them edit, version, build, analyze, and deploy scoped-app code with standard
software-engineering practices, **unlike** Studio's built-in Git or the legacy
Sincronia CLI, **our product** works with or without a companion scoped app and
adds an AI/MCP layer for metadata, dependency, and impact analysis.

One-line value statement (use at the top of README/landing):
**"Treat ServiceNow code like real application code — versioned, testable,
automatable, and AI-analyzable — from your own editor."**

## 2. Target users (personas) & ICP

| Persona | Context | Top pain | What success looks like |
|---|---|---|---|
| **P1 — Platform Developer ("Dana")** | Builds 1–3 scoped apps; lives in VS Code, wants Git/TS | Studio source control is clunky; no local build/test | Edits locally, pushes on save, reviews diffs in Git |
| **P2 — Dev Lead / Architect ("Marco")** | Owns several scopes + a CI/CD pipeline | No automation, no visibility into dependencies/impact | Repeatable build→deploy per scope; impact analysis before change |
| **P3 — ServiceNow Consultancy / SI ("Acme Partners")** | Many clients/instances | Context-switching across instances; onboarding new devs | Multi-instance workflow; fast, documented onboarding |
| **P4 — AI-assisted Developer ("Nia")** | Uses LLM/MCP clients | LLMs can't see ServiceNow metadata/relationships | MCP tools give the model scope knowledge & impact graphs |

**Ideal Customer Profile (initial beachhead):** ServiceNow consultancies / SIs
and mid-size internal platform teams (P2/P3) that already use Git and CI and run
**multiple** scoped apps — they feel the pain most and adopt tooling fastest.
The AI/MCP angle (P4) is the differentiating wedge, not the entry point.

## 3. Quantified value proposition (hypotheses to validate)

Current docs sell features, not outcomes. Proposed measurable claims to test
with early adopters (each needs a baseline + after measurement):

- **Cycle time:** reduce "edit → running in instance" from minutes (Studio
  save/navigate) to seconds (watch-mode push on save). Target: −50% edit loop.
- **Change safety:** Git diff/PR review on scoped code → target measurable drop
  in post-deploy defects vs Studio-only flow.
- **Onboarding:** new dev productive on a scope in < 1 day via `init` + docs,
  vs multi-day Studio orientation.
- **Impact analysis:** dependency/impact report in one MCP call vs manual
  spelunking — target hours → minutes before a risky change.

> These are **hypotheses**, not proven numbers. The #1 BA gap is that none of
> them is measured yet — see KPIs (§7) and the validation plan (§11).

## 4. Competitive positioning

| Alternative | Strengths | Where Syncrona wins | Where it must catch up |
|---|---|---|---|
| **ServiceNow Studio + native Git** | First-party, supported, OAuth/SSO | Local editor, build pipeline (TS/Babel/Webpack), AI/MCP analysis, multi-scope CLI | First-party trust, OAuth/SSO, support SLA |
| **Sincronia / `sinc` (predecessor)** | Established, known to some teams | Modern Node 22, MCP/AI layer, registry-driven, governance/audit, works without companion app | Existing user base & familiarity |
| **Bespoke scripts / update sets** | Zero tooling cost | Repeatable, documented, testable, automatable | "Already works for us" inertia |

**Sharpest message:** *Native Git moved your code into Git; Syncrona moves your
**workflow** into modern engineering — build pipelines, multi-scope CLI, and an
AI layer that understands your scope.* Publish this as a one-page comparison.

### SWOT

- **Strengths:** strong engineering quality (gates, tests, audit=0); works
  with/without companion app (low adoption friction); timely AI/MCP layer;
  registry-driven extensibility.
- **Weaknesses:** Basic-auth only (enterprise blocker); single maintainer (bus
  factor 1); fragmented brand; no published release yet; weak at-rest crypto.
- **Opportunities:** AI-assisted ServiceNow dev is early and differentiating;
  SI/consultancy beachhead; plugin ecosystem.
- **Threats:** ServiceNow improves native Git further; IP/provenance ambiguity;
  enterprise security policies that forbid Basic auth / password storage.

## 5. Stakeholder analysis

| Stakeholder | Interest | Influence | Engagement |
|---|---|---|---|
| Maintainer/author | Ships & sustains the tool | High | Owns roadmap; **bus-factor risk** (§9) |
| Adopting dev teams (P1–P3) | Daily workflow value | High | Need a feedback channel (currently none) |
| ServiceNow platform owners / security | Compliance, data handling | High (gate) | Need OAuth, data-handling statement, support |
| AI/MCP client users (P4) | Tooling for LLMs | Medium | Early differentiator |
| Legal / employer (provenance) | IP ownership, trademark | High (gate) | **Verify before public distribution** (§9 R1) |

## 6. Requirements (high level)

### Functional (have / gap)
- FR-1 Local edit→build→push of scoped code — **have** (dev/push/build/deploy).
- FR-2 Download/refresh scope from instance — **have**.
- FR-3 Multi-instance / profiles — **have** (login/use/instances, profiles).
- FR-4 AI/MCP analysis (metadata, dependency, impact, docs) — **have** (~60 tools).
- FR-5 Diagnostics (status, doctor, check-env) — **have**.
- FR-6 **OAuth 2.0 / SSO auth** — **GAP (G1)**, top enterprise blocker.
- FR-7 Download progress/resume — **GAP (G3)**.

### Non-functional (have / gap)
- NFR-1 Quality gates / tests — **have** (188 tests, gates, audit=0).
- NFR-2 Cross-platform — **partial** (macOS/Linux; Windows needs WSL — DX1).
- NFR-3 Secure credential storage — **partial/weak** (machine-key obfuscation;
  Basic auth). Enterprise NFR not met.
- NFR-4 Supportability — **GAP** (no SLA, no support channel, bus factor 1).
- NFR-5 Distribution / install ease — **GAP (D5)**: Homebrew/Windows/Keychain,
  npm publish not done.
- NFR-6 ServiceNow version compatibility statement — **GAP**.

## 7. Success metrics (KPIs) — to instrument

The project currently has **no business KPIs** ("readiness 8.5/10" is an internal
self-score). Proposed starter KPI set:

| Goal | KPI | Source |
|---|---|---|
| Adoption | weekly npm downloads; # active workspaces | npm stats; opt-in telemetry (G7) |
| Activation | % installs that reach a first successful `push` | opt-in telemetry / survey |
| Time-to-value | median time from `install` → first `push` | telemetry / user interviews |
| Retention | teams still pushing after 30/90 days | telemetry |
| Reliability | push success rate; CI green rate | logs / CI |
| Community | # external contributors; issue response time | GitHub |

Pre-req: an **opt-in** diagnostics/telemetry mechanism (G7) — privacy-respecting,
off by default. Until then, run structured user interviews (§11).

## 8. Roadmap prioritized by business value (MoSCoW)

Re-frames the engineering backlog (D5, G1–G17, DX1–DX24) by **adoption impact**,
not technical risk.

- **Must (unlock the addressable market):**
  - G1 OAuth 2.0 / SSO (FR-6) — removes the #1 enterprise gate.
  - D5 distribution + first npm release — removes the install gate (no product
    without shipping).
  - ServiceNow compatibility matrix (NFR-6) — enterprise procurement need.
  - Provenance/IP clearance (§9 R1) — legal gate before public push.
- **Should (raise trust & conversion):**
  - Support channel + SECURITY/data-handling + issue templates (NFR-4).
  - Stronger at-rest crypto / OS keychain (AR2/D5) (NFR-3).
  - One-page competitive comparison; quantified value page (§3/§4).
  - Brand unification (one name).
- **Could (delight / stickiness):**
  - Opt-in telemetry for KPIs (G7); download progress/resume (G3); `--flat`
    mode (DX17); `repair` (DX18); richer dry-run/progress UX.
- **Won't (now):** mutation testing (G13), perf bench (G14) — engineering
  hygiene, not adoption levers; revisit post-1.0.

## 9. Risk register

| ID | Risk | Impact | Likelihood | Mitigation |
|---|---|---|---|---|
| **R1** | **Provenance / IP** — code originated with prior "nuvolo" references; now published to a personal account. Ownership & clearance to distribute unverified. | High (legal) | Medium | Verify IP ownership and distribution rights **before** any public release; document a clear license/CLA; "ServiceNow" is a trademark of ServiceNow, Inc. — add disclaimer. |
| R2 | Enterprise auth (Basic only) blocks the paying segment | High | High | Ship OAuth/SSO (G1) before targeting enterprise. |
| R3 | Bus factor 1 — single maintainer | High | Medium | Document ownership; recruit co-maintainer; reduce knowledge silos (docs are now good). |
| R4 | ServiceNow extends native Git, eroding differentiation | Medium | Medium | Lean into the AI/MCP and multi-scope CLI moat; ship fast. |
| R5 | Weak at-rest credential crypto / data handling | Medium | Medium | OS keychain (AR2); publish data-handling statement (SECURITY.md). |
| R6 | No published release / install friction | High | High (current) | D5 distribution; reduce time-to-value. |
| R7 | Brand fragmentation hurts discoverability | Low | High | Unify on one name across npm/repo/CLI. |
| R8 | No user-research loop → building the wrong things | Medium | Medium | Run interviews; instrument KPIs; tie roadmap to demand. |

## 10. Adoption funnel & enterprise-readiness gate

**Funnel (current friction in bold):**
discover → **install (Node 22 / WSL on Windows / not yet published)** → init →
**first push (Basic auth only; weak crypto)** → daily use → **team rollout (no
support/SLA, compatibility unknown)** → advocate.

**Enterprise-readiness checklist (procurement will ask):**
- [ ] OAuth/SSO auth (R2)
- [ ] Data-handling & security statement (SECURITY.md) — *added 2026-06-13*
- [ ] ServiceNow version compatibility matrix
- [ ] Support model / SLA / contact
- [ ] License & IP clearance (R1)
- [ ] At-rest credential strength (keychain)

## 11. Validation plan (next 2–4 weeks, BA actions)

1. **5–8 user interviews** across P1–P3 (esp. SI/consultancy beachhead): confirm
   top pains, current alternative, willingness to switch, must-have auth.
2. **Baseline the value hypotheses** (§3) with 1–2 pilot teams: measure edit-loop
   time, onboarding time, impact-analysis time before/after.
3. **Competitive teardown** vs native Git + Sincronia → one-page comparison.
4. **Decide business model** (OSS + paid support? OSS only? internal?) and
   maintainer/ownership — resolves R1/R3 framing.
5. **Instrument KPIs** (§7) once opt-in telemetry (G7) lands.

## 12. What this document changed (implemented 2026-06-13)

- Added this BA report (vision, personas, quantified value, competitive/SWOT,
  stakeholders, requirements, KPIs, MoSCoW roadmap, risk register, funnel,
  validation plan).
- Added `SECURITY.md` (disclosure + data-handling statement) — closes part of
  the enterprise-readiness gate.
- Added GitHub issue/feature templates + support config — opens the
  user-feedback loop (R8, NFR-4).
- README: ServiceNow trademark disclaimer + compatibility note + links here.
- Logged BA findings as `BA1–BA8` in `TODO` for delivery tracking.

Still **owner actions** (cannot be implemented in-repo): IP/provenance clearance
(R1), business-model decision, OAuth (G1), distribution (D5), brand unification,
and the user-research/validation program (§11).
