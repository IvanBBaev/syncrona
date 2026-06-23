# Governance

This document states honestly how SyncroNow AI is maintained, what support to
expect, and how decisions are made. It exists because "who sustains this?" is a
fair question any adopting team will ask.

## Project status

Pre-1.0 (`0.x`), **single-maintainer** open-source project under GPL-3.0-or-later.
It is engineered to a high bar (quality gates, tests, audit, governance docs) but
its **bus factor is 1** — see "Sustainability" below. Adopt accordingly: it is
suitable for teams comfortable running an OSS dev tool, not yet for buyers who
require a vendor support SLA.

## Maintainership

- **Maintainer:** Ivan Baev (project author).
- **Decision rights:** the maintainer is the final decision-maker on scope,
  architecture, and releases.
- **Co-maintainers wanted.** Reducing bus factor is an explicit goal. Sustained,
  high-quality contributors will be invited as co-maintainers. If you depend on
  this tool and want a seat, open a discussion.

## Support model

- **Best-effort, no SLA.** This is volunteer open source. There is no guaranteed
  response or fix time.
- **Channels:** GitHub Issues (bugs/features) and Discussions (questions). Use
  the issue/feature templates. Security reports go through `SECURITY.md`
  (private), **never** a public issue.
- **Response targets (aspirational, not contractual):** acknowledge new
  issues within ~1 week; security reports within a few business days.
- **Paid/priority support:** none today. If demand is validated, a support tier
  may be offered (GPL allows selling support); see `docs/BUSINESS_ANALYSIS.md`.

## Triage

- Incoming issues are labeled by type (bug / enhancement / question / docs) and
  priority. Bugs with a clear repro and a failing test are prioritized.
- A change is "done" only when it passes `npm run check` (build, typecheck, lint,
  tests, coverage gates, docs-drift). Red gates are never merged.
- `main` is protected: PRs require the CI checks to pass.

## How decisions are made

- **Small changes:** PR + green gates.
- **Behavior/architecture/contract changes:** open an issue or discussion first
  describing the problem and proposed approach; the maintainer decides. Larger
  proposals are tracked in `TODO` with a stable id and recorded in `DONE` when
  shipped.
- **Roadmap:** see `ROADMAP.md`. It is currently maintainer-derived; tying it to
  validated user demand is an open priority (`docs/BUSINESS_ANALYSIS.md` BA1).

## Releasing

Releases use Changesets and are **owner-gated** (npm scope ownership + 2FA, IP
clearance) — see `.github/workflows/release.yml`. Versions move in lockstep
across the `@syncro-now-ai/*` packages.

## Sustainability & continuity

- **Knowledge is in the repo, not a head:** architecture docs, a detailed
  `TODO`/`DONE` history, tests, and machine-enforced gates make the project
  picked-up-able by another maintainer.
- **If the maintainer steps away:** the GPL-3.0 license guarantees the community
  can fork and continue. The intent is to hand off rather than abandon — co-
  maintainers are the mitigation.
- **License:** GPL-3.0-or-later; a derivative of [Sincronia](https://github.com/nuvolo/sincronia)
  (see `NOTICE`). Copyleft means any distributed fork stays open.

## Contributing

See `CONTRIBUTING.md` and `CODE_OF_CONDUCT.md`. Contributions are accepted under
the project license (GPL-3.0-or-later).
