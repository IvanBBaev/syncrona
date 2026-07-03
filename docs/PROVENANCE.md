<!-- SPDX-License-Identifier: GPL-3.0-or-later -->

# Provenance & IP clearance

This document consolidates the intellectual-property and licensing story of
SyncroNow AI in one auditable place. It exists so that a reviewer, a lawyer, or a
future maintainer can answer "where did this code come from, under what license,
and what still needs a human sign-off before public distribution?" without
reconstructing it from scattered notes.

> **Status (2026-07):** the engineering and documentation side of provenance is
> **complete and CI-guarded**. What remains is a **legal sign-off that only the
> owner can obtain** — see [§6 Open items](#6-open-items-owner--legal). Every
> public-distribution step (npm publish, tagged GitHub release) is gated on that
> sign-off.

---

## 1. Origin

SyncroNow AI is a **derivative work** of **Sincronia (`sinc`)**, the ServiceNow
build pipeline by **Nuvolo**:

- Upstream project: https://github.com/nuvolo/sincronia
- Upstream license: **GNU General Public License, version 3.0**.

Substantial portions of the build/plugin packages (`babel-*`, `*-plugin`,
`*-preset-servicenow`), the CLI core, and the shared types originate from that
project and **remain under GPL-3.0**.

Work that is **new in this project** — the MCP server, credential store,
`sn-transport`, OAuth/proxy support, the Jira read client, governance/audit
tooling, and the additional CLI commands and test suites — is
Copyright © 2026 Ivan Baev and is likewise licensed under **GPL-3.0-or-later**.

The full attribution lives in [`NOTICE`](../NOTICE).

## 2. License history (why GPL-3.0-or-later)

This is the part a reviewer most needs to understand, because it corrects a real
compliance defect:

1. **Upstream Sincronia is GPL-3.0** (its `LICENSE` file and the
   `@sincronia/core` `package.json`).
2. **This fork was initially relicensed to MIT with no attribution.** Because
   GPL-3.0 is copyleft, a derivative work cannot be silently relicensed to a
   permissive license — that was a **GPL violation that blocked any distribution**.
3. **Corrected on 2026-06-21.** The root `LICENSE` was replaced with the verbatim
   canonical GPL-3.0 text; all workspace `package.json` `license` fields were set
   to `GPL-3.0-or-later`; a `NOTICE` file was added; and the README license
   section was rewritten. The relicense touched **only metadata/text/docs — no
   executable code changed**.

The `-or-later` suffix is the current choice; whether to keep it or pin to
GPL-3.0-**only** is one of the open legal questions in [§6](#6-open-items-owner--legal).

## 3. Current compliance state (in place & enforced)

| Artifact | State | Location |
|---|---|---|
| Root license | Verbatim GPL-3.0 text | [`LICENSE`](../LICENSE) |
| Attribution / NOTICE | Names Sincronia/Nuvolo origin, per-area copyright split, trademark disclaimer | [`NOTICE`](../NOTICE) |
| Workspace `license` fields | All 14 packages declare `GPL-3.0-or-later` | `package.json` + `packages/*/package.json` |
| Per-file SPDX headers | `SPDX-License-Identifier: GPL-3.0-or-later` on **120/120** non-test source `.ts` files (shebang-aware on the 2 bin files) | `packages/*/src/**` |
| README license section | Declares GPL-3.0, points at Sincronia + NOTICE, states the GPL redistribution obligation | [`README.md`](../README.md) |
| Governance note | License + derivative status recorded | [`GOVERNANCE.md`](../GOVERNANCE.md) |
| Drift guard (CI) | `licenseConsistency.test.ts` fails the build on any revert to MIT / missing NOTICE / non-GPL workspace license | `packages/core/src/tests/licenseConsistency.test.ts` |

The drift guard is the key durable control: it asserts the `LICENSE` is GPL (not
the MIT preamble), that a `NOTICE` exists and mentions Sincronia + GPL, that the
root and every workspace `package.json` declare `GPL-3.0-or-later`, and that any
per-package `LICENSE` file is GPL text. A future accidental relicense fails CI.

## 4. Trademarks

"ServiceNow" is a registered trademark of ServiceNow, Inc. This project is an
independent, third-party tool and is **not affiliated with, sponsored by, or
endorsed by ServiceNow, Inc. or Nuvolo.** The disclaimer is carried in both
[`NOTICE`](../NOTICE) and [`README.md`](../README.md).

## 5. Copyleft implication for the business model

GPL-3.0 copyleft means **any distributed fork or derivative must stay open
source under the GPL.** This forecloses a closed-source / proprietary paid tier.
Viable monetization is therefore **OSS-only** or **SaaS / paid-support** around
the open project — not a proprietary closed distribution. This is a deliberate
consequence of honoring the upstream license, not an oversight.

## 6. Open items (owner / legal)

These **cannot be closed by any code change** — they require the owner and/or a
lawyer. They are the actual content of the "IP / provenance clearance" gate:

1. **Legal sign-off before the first public publish.** A lawyer should confirm:
   - the choice of **GPL-3.0-only vs GPL-3.0-or-later**;
   - that **no employer-proprietary or otherwise non-distributable code** is
     mixed into the tree (the author's prior-employment history is out of scope
     for a code audit — only the owner can attest to it);
   - that the Sincronia attribution as written satisfies the GPL's notice and
     corresponding-source obligations.
2. **Confirm the right to distribute the pre-existing code publicly.** The tree
   previously carried `nuvolo` references and now lives on a personal account;
   the owner must confirm ownership / redistribution rights. This is a **hard
   gate on every public step** (npm publish, tagged GitHub release).

## 7. Residual upstream references to clean before public launch

These are **cosmetic / first-impression**, not legal blockers, but should be
resolved before a public launch so the project does not present another tool's
material as its own:

- **README demo images** embed `docs/images/sincronia-development.png` and
  `sincronia-deployment.png` — these depict Sincronia's (`sinc`) workflow, not
  this tool. Replace with SyncroNow AI's own captures / demo asset.
- **README "Examples"** historically linked the upstream Sincronia/Nuvolo video
  material as the primary call-to-action; the primary demo should be this tool.
- **CHANGELOG footer** carries an upstream `@collinparker-nuvolo` contributor
  link inherited from Sincronia's history — legitimate as historical attribution,
  but review it when curating the first public changelog.

---

### Cross-references

- [`NOTICE`](../NOTICE) — the legally binding attribution.
- [`GOVERNANCE.md`](../GOVERNANCE.md) — license + maintainer/bus-factor posture.
- [`docs/ENTERPRISE_READINESS.md`](./ENTERPRISE_READINESS.md) and
  [`ROADMAP.md`](../ROADMAP.md) — where this gate sits among the owner decisions.
