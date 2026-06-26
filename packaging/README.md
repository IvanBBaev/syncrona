# Packaging & distribution

Install paths for the SyncroNow AI CLI (`@syncro-now-ai/core`). All published
distribution is **owner-gated** behind IP/provenance clearance, repo-public, and
npm scope ownership + 2FA — the scaffolding here is ready to activate once those
decisions land.

## 1. npm (primary)

```sh
npm install -g @syncro-now-ai/core
syncro-now-ai --help
```

Publishing is automated via Changesets + provenance in
[`.github/workflows/release.yml`](../.github/workflows/release.yml). Requires the
`NPM_TOKEN` secret and a public repo (provenance attestations).

## 2. Homebrew (macOS / Linux)

[`homebrew/syncro-now-ai.rb`](homebrew/syncro-now-ai.rb) is the source-of-truth
formula template. On each tagged core release, the release workflow copies it to
the `homebrew-tap` repo and fills in the published tarball `url` + `sha256`.

```sh
brew tap ivanbbaev/tap
brew install syncro-now-ai
```

> The `url`/`sha256` in the template are placeholders until the first npm publish.

## 3. Windows

[`windows/install.ps1`](windows/install.ps1) verifies Node >= 22 and installs the
CLI globally from npm.

```powershell
powershell -ExecutionPolicy Bypass -File install.ps1
```

Credential storage on Windows uses the **Windows Credential Manager** natively
via the optional `@napi-rs/keyring` dependency. As of D5 the keychain is the
**default** backend (opt out with `SYNCRONA_USE_KEYCHAIN=0`). Native Windows is
supported in addition to WSL; WSL remains the recommended path for parity with
the documented Unix workflows.
