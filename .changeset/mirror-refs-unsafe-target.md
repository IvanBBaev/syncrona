---
"@syncrona/mirror": patch
---

Generating the derived views no longer aborts when a mirrored `sys_dictionary` reference column names a target table that is not a safe path component (for example a hand-edited `../escape`). The refs view now skips verifying that column and names it once in the anomaly list, as it already did for other unreadable tree content.
