---
"syncrona": patch
---

- Internal: `FileUtils` and the download pipeline are re-authored in this project's own code (IND-7b). Behaviour, the on-disk layout, manifest handling and the exported API are unchanged; the missing-file scan now collects into one ledger, and new tests pin its answer shape.
