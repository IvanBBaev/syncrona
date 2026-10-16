---
"syncrona": patch
---

- A JSON field file that is not valid JSON is refused with Node's parse message alone; the line and column it already names are no longer appended a second time.
- A JSON field file is also withheld on download when an `Authorization` header holds a value, or when a credential-named key sits inside a JSON document stored as a string (a component's `props`, a tool's `inputs`); before, both reached the working tree.
