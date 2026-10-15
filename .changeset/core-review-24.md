---
"syncrona": patch
---

- `push` of an ATF step's metadata alone (no `inputs.script` in the update) no longer calls the `pushATFfile` route with no script: it failed the metadata push on an instance without the route, and on one with it asked the server app to blank the step script.
- A missing `pushATFfile` route is no longer retried: the wrapped error dropped the 4xx status, so `push` retried it and `dev` requeued it as a transient failure.
