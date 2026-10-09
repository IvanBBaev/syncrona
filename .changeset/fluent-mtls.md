---
"syncrona": minor
"@syncrona/fluent": minor
---

`syncrona fluent` accepts a mutual-TLS client certificate (`SN_CLIENT_CERT` / `SN_CLIENT_KEY`) with a Basic or OAuth profile instead of refusing it. Core hands the TLS settings to the Fluent engine as `tls`, the OAuth token request presents the certificate, and the engine installs a TLS-configured fetch dispatcher for the duration of each instance-side action, restoring the previous one afterwards. `SYNCRONA_CA_BUNDLE` and `SYNCRONA_TLS_REJECT_UNAUTHORIZED` now apply to the Fluent tier as well. API-key profiles are still refused.
