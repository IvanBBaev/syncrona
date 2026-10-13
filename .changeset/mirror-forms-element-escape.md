---
"@syncrona/mirror": patch
---

The forms view now escapes `sys_ui_element` names like every other instance string, so a line break or `|` in an element name can no longer inject Markdown lines into a derived form document.
