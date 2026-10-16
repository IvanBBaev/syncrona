---
"syncrona": patch
---

- A playbook document withholds secret-typed values inside its decoded payloads (`designer_state`, gzip-encoded columns), as a flow document already did; before, only variable values and input defaults were redacted.
- A secret-typed input default or static value whose text was gzip-encoded JSON is withheld in flow, action and playbook documents; the assembler had decoded it into `payloads`, where the redaction never looked.
