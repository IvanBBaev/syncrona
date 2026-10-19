---
"syncrona": patch
---

Core internals re-authored as the project's own code (IND-7, slice 7d): the logger, push/build result reporting, scope and update-set switching, the built-in table defaults, the build plugin manager, the command handlers, the setup wizard and the CLI option table. Behaviour is unchanged apart from wording: the scope-mismatch, dev-mode, setup-complete and missing-config messages and the `push --scope-swap` / `--update-set` and `download` help texts are reworded, the watch-mode push summary no longer prints emojis, and a generated `sync.config.js` spaces its empty `excludes` / `includes` / `tableOptions` and `refreshInterval` entries like the other keys.
