---
"@syncrona/fluent": minor
---

- The native Fluent compiler supports `UiPage()` (`sys_ui_page`), byte for byte as SDK 4.13.6 writes it: the page is keyed by its endpoint (by its name in the global scope), and its `html` goes through a port of the SDK's htmlparser2 / fast-xml-parser round trip, including the `<sdk:now-ux-globals>` expansion and the SDK's error messages for invalid markup. An included or imported `.html` file and a character reference in `<textarea>` content are refused for now.
