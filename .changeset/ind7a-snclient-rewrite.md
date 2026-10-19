---
"syncrona": patch
---

- Re-author the ServiceNow REST client (`snClient`) without upstream-derived code: the retry loop, OAuth token wiring, Table API and user-preference calls, client cache and response unwrap helpers have their own structure, with identical requests, retries and error mapping (IND-7, slice 7a).
