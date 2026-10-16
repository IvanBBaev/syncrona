---
"syncrona": patch
---

- A playbook document withholds secret-typed values inside its decoded payloads (`designer_state`, gzip-encoded columns), as a flow document already did; before, only variable values and input defaults were redacted.
