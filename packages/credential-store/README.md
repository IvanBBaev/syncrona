# @syncrona/credential-store

Shared encrypted credential store for Syncrona. It is the single source of
truth for at-rest credential storage used by both the `@syncrona/core` CLI and
the `@syncrona/mcp-server`, so the encryption format, key derivation, file
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

Low-level primitives are also exported: `getMachineKey`, `encrypt`, `decrypt`,
`instanceToFilename`, `filenameToInstance`.

## Security

At-rest protection is **obfuscation-grade**. The encryption key is derived from
the machine hostname and OS username, so anyone able to run as the same user on
the same host can decrypt the files. See the core README "Credential storage
security" section for hardening recommendations.
