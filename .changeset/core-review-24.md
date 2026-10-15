---
"syncrona": patch
---

- `push` of an ATF step's metadata alone (no `inputs.script` in the update) no longer calls the `pushATFfile` route with no script: it failed the metadata push on an instance without the route, and on one with it asked the server app to blank the step script.
- A missing `pushATFfile` route is no longer retried: the wrapped error dropped the 4xx status, so `push` retried it and `dev` requeued it as a transient failure.
- An editor backup (`script.js~`, `script.bak`, `script.tmp`) no longer counts as a field's local file on the download side: `refresh` and `repair` reported a deleted `script.js` as present, and `download` kept the backup instead of restoring it, while `push` ignored the backup — so the field could be neither pulled nor pushed.
- `mirror sync` / `mirror status` now apply the CLI's TLS settings (`SYNCRONA_CA_BUNDLE`, `SYNCRONA_TLS_REJECT_UNAUTHORIZED`, the mTLS client certificate) to the OAuth token request and to every sweep request; they used the platform defaults, so an instance behind a private CA or requiring a client certificate failed where every other command worked.
