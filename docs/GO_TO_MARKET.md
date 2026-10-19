# Go-to-Market (one-pager)

> Companion to `BUSINESS_ANALYSIS.md`. This is the missing "how will anyone find
> it?" plan. A niche dev tool wins on **narrow, targeted** reach, not broad
> marketing. Motion: **bottom-up developer adoption**.

## Positioning

> **"Treat ServiceNow code like real application code — versioned, testable,
> automatable, and AI-analyzable, from your own editor."**

The durable hook is the **workflow** (local-first Git + multi-scope CLI + build
pipeline); the **AI/MCP** layer is the timely attention-grabber. Lead with
workflow, hook with AI.

## Beachhead (who first)

1. **ServiceNow consultancies / SIs (P3)** — multi-instance, Git/CI-mature, feel
   the pain daily, adopt tooling fastest. Primary.
2. **Internal platform teams (P2)** building several scoped apps. Secondary.
3. AI-forward ServiceNow devs (P4) — the content wedge, not the entry point.

## Channels (ranked by fit)

| Channel | Why | Effort |
|---|---|---|
| **ServiceNow Developer Community / forums** | Exactly the audience; high intent | Low |
| **r/servicenow, ServiceNow Discord/Slack groups** | Practitioners; honest feedback | Low |
| **dev.to / personal blog — "AI + ServiceNow" posts** | Rides the MCP/AI wave; SEO durability | Medium |
| **LinkedIn (ServiceNow dev/architect circles)** | Where SIs and leads actually are | Low |
| **Demo video / GIF (90s: edit→save→pushed→AI impact graph)** | Shows, not tells; shareable | Medium |
| **Show HN / Hacker News** | One-shot spike; only after polish | Low |
| **npm + Homebrew + GitHub topics/README SEO** | Passive discovery | Low |

## Content plan (the MCP/AI angle is the timely asset)

- "Give your LLM eyes into ServiceNow: MCP for scoped-app metadata & impact"
- "Local-first ServiceNow development: Git, TypeScript, CI for scoped apps"
- The one-page comparison (`docs/COMPARISON.md`) as a shareable post.
- A 90-second demo GIF in the README (edit → push-on-save → AI impact graph).

## Launch checklist (must be TRUE before broad launch)

- [ ] **Demand validated** — ≥5 SI/dev interviews confirm the pain + willingness
  to switch (`docs/VALIDATION_INTERVIEWS.md`). *Do this before spending on reach.*
- [ ] IP/legal clear (GPL variant + proprietary-code sign-off — BA8)
- [ ] Published to npm + Homebrew tap live (`brew install … && init` works)
- [ ] README: value statement on top, 90s demo GIF, quickstart that works cold
- [ ] `docs/COMPATIBILITY.md` filled with at least one verified ServiceNow release
- [ ] Support expectations set (`GOVERNANCE.md`); issue templates live
- [ ] Brand unified on one name (BA6)

## Sequencing

1. **Validate** (interviews) — gate; cheap; decides whether to invest at all.
2. **Soft launch** to the ServiceNow community + 1–2 design-partner SIs.
3. **Content** (blog + demo) to compound discovery on the AI wave.
4. **Broad launch** (Show HN / wider) only once quickstart + support hold up.

## Post-launch metrics (tie to KPIs in BUSINESS_ANALYSIS §7)

npm weekly downloads · install→first-`push` activation rate · 30/90-day
retention · GitHub stars/issues/external PRs · interview-sourced qualitative fit.
Set **target values** (currently missing) before launch so you can call
success/failure.
