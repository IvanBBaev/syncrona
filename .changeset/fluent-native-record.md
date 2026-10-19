---
"@syncrona/fluent": minor
---

- The native Fluent compiler now also builds `Record()`: string, number, boolean, array, `Now.include()`, `Now.ref()` and record values, the SDK's role and view name references, and its "use the X API" hint, matching the SDK 4.13 output byte for byte on the golden fixture. Tables the SDK builds through its own record plugins are an error.
