---
"@syncrona/babel-preset-servicenow": patch
---

The ServiceNow Babel preset rewrites a property named after any ES3 reserved word to bracket syntax. `delete`, `function`, `in`, `typeof`, `with`, `debugger` and `export` were missing from its list, so code such as `set.delete(key)` reached Rhino unchanged and failed to parse.
