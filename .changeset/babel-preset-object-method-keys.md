---
"@syncrona/babel-preset-servicenow": patch
---

Quote reserved-word keys of object literal methods and accessors (`get default() {}`, `delete() {}`) as well as plain properties, so the output stays valid for ServiceNow's ES3-era Rhino parser.
