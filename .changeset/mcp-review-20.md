---
"@syncrona/mcp-server": patch
---

- `sync_suggest_tests` no longer takes the class name from the word "class" in a header comment (e.g. `/* Utility class for incident routing. */`): an ES6 class is recognised only when its body or `extends` clause follows the name, so a `Class.create()` Script Include gets `new <ClassName>()` instead of `new for()`.
