# Support

Thanks for using SyncroNow AI. This is an actively developed but **pre-1.0** project;
please set expectations accordingly.

## Getting help

1. **Read the docs first** — the [README](README.md), the guides in
   [docs/](docs/) (multi-instance, monorepo, plugin development, MCP quickstart),
   and the FAQ / "Getting unstuck" section of the README cover most questions.
2. **Run the built-in diagnostics:**
   - `syncrona check-env` — verifies Node/platform/WSL/Git prerequisites.
   - `syncrona status` (and `status --debug-credentials`) — instance, scope,
     and credential resolution.
   - Re-run any command with `--log-level debug` for detail; set
     `SYNCRONA_DIAGNOSTIC_LOG=1` to capture a local log for a report.
3. **Search existing issues**, then open a new one using the bug/feature
   templates.

## Reporting bugs / requesting features

Open a GitHub issue with the template. For bugs, include the `syncrona check-env`
output, the command + `--log-level debug` output (redact credentials), and your
ServiceNow release if relevant.

## Security issues

Do **not** open a public issue. See [SECURITY.md](SECURITY.md) for private
disclosure.

## Support scope & SLA

This is community/maintainer best-effort support — there is **no commercial SLA**
today. Response times vary. A supported/commercial tier is not yet offered;
enterprise adopters who need an SLA should track this via an issue so demand is
visible (see the roadmap in [docs/BUSINESS_ANALYSIS.md](docs/BUSINESS_ANALYSIS.md)).

## Sponsor development

SyncroNow AI is built and maintained in my own time. If it saves you or your team
time, sponsorship directly funds new features, bug fixes and keeping pace with
ServiceNow's REST surface.

- **[GitHub Sponsors](https://github.com/sponsors/IvanBBaev)** — one-off or
  recurring, with no platform fee taken out (the preferred option).
- **[Ko-fi](https://ko-fi.com/ivanbbaev)** — quick one-off support; it also
  accepts **PayPal**, so it's the fallback for anyone without a GitHub account.
- **[Donate (Donatree)](https://donatr.ee/ivanbbaev/)** — a no-account donation
  page (card, PayPal and more) for a one-off tip.
