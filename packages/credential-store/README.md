# @syncro-now-ai/credential-store

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
   for CI / secrets managers.
2. **OS keychain** — opt in with `SYNCRONA_USE_KEYCHAIN=1`; a random 256-bit
   master key is kept in the OS keychain via the optional `@napi-rs/keyring`.
3. **Machine-derived key (default)** — obfuscation-grade; derived from the
   machine hostname and OS username, so anyone able to run as the same user on
   the same host can decrypt files written with it.

Reads fall back to the machine-derived key so pre-existing files keep
decrypting. `getStoreKeySource()` reports which path won (`"env"` /
`"keychain"` / `"machine"`). See the core README "Credential storage security"
section for hardening recommendations.
