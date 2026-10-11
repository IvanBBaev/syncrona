---
"@syncrona/sn-transport": patch
---

- A malformed numeric `Retry-After` (`1.5`, `-1`, `3,5`) falls back to the jittered backoff instead of triggering an immediate retry.
- The OAuth token manager caches a token whose lifetime is 30 s or less (the expiry skew is capped at half the TTL), and forgets a refresh token the server rejected instead of re-sending it on every later refresh.
- `isSafePathComponent` rejects a component of only dots and whitespace (`.. `), which Windows resolves back to `..`, and a NUL byte.
