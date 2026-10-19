# @syncrona/sn-transport

## 1.2.0

### Minor Changes

- - New `bearer` auth method for a pre-issued OAuth access token, the counterpart of now-sdk's `SN_SDK_SESSION_BEARER_TOKEN`. Set `SN_BEARER_TOKEN` (optionally with `SN_AUTH_METHOD=bearer`, aliases `bearer-token` and `access-token`), and the CLI, the MCP server and the Fluent tier send `Authorization: Bearer <token>`. Like the SDK, a token in the environment is inferred ahead of every other method unless `SN_AUTH_METHOD` names a different one. The token is environment-only: `syncrona login` refuses `--auth-method bearer` and clears a stale `SN_BEARER_TOKEN` from `.env` on a re-login, and syncrona never refreshes the token. The per-profile `SN_BEARER_TOKEN_<PROFILE>` suffix works like every other auth variable.
- Inject a UI session into the Fluent tier, the counterpart of now-sdk's `SN_SDK_SESSION_TOKEN` / `SN_SDK_SESSION_COOKIE`. When `SN_SESSION_COOKIE` (with its `SN_SESSION_TOKEN` CSRF token) is set, the `fluent` actions hand that session to the SDK as is, ahead of the profile's method and without a login; a token without a cookie is refused. `FluentCredentialInput` gains a `session` kind, which `createFluentAuthResolver` returns unchanged. The variables are environment-only: `syncrona login` never stores them and clears stale ones from `.env`, and syncrona never renews the session. Other commands, and `fluent types --native`, keep using the profile.
- The scoped API prefix helpers are removed: `DEFAULT_SCOPED_API_PREFIXES`, `sanitizeScopedPrefix`, `SCOPED_API_PREFIXES_ENV`, `parseConfiguredScopedApiPrefixes` and `orderScopedApiPrefixes` are no longer exported, and `SYNCRONA_SCOPED_API_PREFIXES` has no effect. Neither client calls a scoped application's REST API any more.

### Patch Changes

- Docs: package READMEs drop the legacy upstream references. The fluent README states the ServiceNow SDK licensing notes inline, the MCP server examples use a neutral `x_acme_*` scope, and the repository `NOTICE` now carries only the project copyright and the ServiceNow trademark notice.

## 1.1.0

### Patch Changes

- 976a3d5: - A malformed numeric `Retry-After` (`1.5`, `-1`, `3,5`) falls back to the jittered backoff instead of triggering an immediate retry.
  - The OAuth token manager caches a token whose lifetime is 30 s or less (the expiry skew is capped at half the TTL), and forgets a refresh token the server rejected instead of re-sending it on every later refresh.
  - `isSafePathComponent` rejects a component of only dots and whitespace (`.. `), which Windows resolves back to `..`, and a NUL byte; `foldNameComponent` drops a NUL from a display name instead of producing such a component.
  - `resolveUniqueNames` keeps a collision-suffixed name off another record's plain name (`Foo`/`foo` → `foo_B` versus a record already named `foo_B`).

## 1.0.0

## 0.9.4

## 0.9.3

### Minor Changes

- Adds the mirror's error taxonomy and path-safety policy, so a sweep classifies a failure the same way whichever call site hit it.
- Input that was silently ignored is now either honored or reported.

## 0.9.1

### Patch Changes

- Package metadata: set the npm `homepage` to the project site
  (https://ivanbbaev.github.io/syncrona/) and sharpen the package descriptions.
  No runtime or API changes.

## 0.4.2
