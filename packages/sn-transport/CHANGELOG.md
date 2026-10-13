# @syncrona/sn-transport

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
