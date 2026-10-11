---
"@syncrona/webpack-plugin": patch
---

- A failed bundle reports webpack's errors in the thrown message instead of only on stderr, so an MCP client sees why the build failed.
