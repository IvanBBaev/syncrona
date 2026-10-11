---
"@syncrona/sn-transport": patch
---

- A malformed numeric `Retry-After` (`1.5`, `-1`, `3,5`) falls back to the jittered backoff instead of triggering an immediate retry.
