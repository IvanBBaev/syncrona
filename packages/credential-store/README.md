# @syncro-now-ai/credential-store

<!-- badges:start -->
| ![npm: not yet published](https://img.shields.io/badge/npm-not%20yet%20published-lightgrey?style=flat-square&logo=npm&logoColor=white) | [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org) | [![license](https://img.shields.io/github/license/IvanBBaev/syncrona?style=flat-square&color=blue&label=license)](../../LICENSE) | [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/syncrona/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/syncrona/actions/workflows/ci.yml) | [![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) |
|:--:|:--:|:--:|:--:|:--:|
<!-- badges:end -->

Shared encrypted credential store for SyncroNow AI. It is the single source of
truth for at-rest credential storage used by both the `@syncro-now-ai/core` CLI and
the `@syncro-now-ai/mcp-server`, so the encryption format, key derivation, file
naming, and on-disk layout never diverge between processes.

## Layout

```
~/.syncrona/
  config.json                 # { "activeInstance": "<instance>" }
  credentials/<instance>.enc  # AES-256-GCM "iv:authTag:ciphertext" (hex)
```

## API

Async (used by the core CLI, read + write):

- `saveCredentials(instance, user, password)`
- `loadCredentials(instance)` — throws if missing
- `listInstances()`
- `removeCredentials(instance)` / `removeAllCredentials()`
- `setActiveInstance(instance)` / `getActiveInstance()`
- `resolveCredentialsFromStore(instance?)`
- `getSyncronaDir()`

Sync (used by the MCP server during secrets resolution; never throw, return
`null` on any failure):

- `getActiveInstanceSync()`
- `loadCredentialsSync(instance)`

Low-level primitives are also exported: `getStoreKey`, `getStoreKeySource`,
`getMachineKey`, `encrypt`, `decrypt`, `instanceToFilename`,
`filenameToInstance`.

## Security

The encryption key is resolved by `getStoreKey()` with the precedence:

1. **`SYNCRONA_STORE_KEY`** — an explicit 32-byte key (64 hex chars or base64),
   for CI / secrets managers. Strongest option.
2. **OS keychain (default)** — used automatically when the optional
   `@napi-rs/keyring` dependency is installed; **opt out** with
   `SYNCRONA_USE_KEYCHAIN=0` (e.g. a headless CI box with no keychain). A random
   256-bit master key is kept in the OS keychain (macOS Keychain / Windows
   Credential Manager / libsecret).
3. **Machine-derived key (fallback)** — obfuscation-grade; derived from the
   machine hostname and OS username, so anyone able to run as the same user on
   the same host can decrypt files written with it. Used only when the keychain /
   `@napi-rs/keyring` is unavailable (or explicitly disabled).

Reads fall back to the machine-derived key so pre-existing files keep
decrypting. `getStoreKeySource()` reports which path won (`"env"` /
`"keychain"` / `"machine"`). See the core README "Credential storage security"
section for hardening recommendations.
