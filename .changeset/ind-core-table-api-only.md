---
"syncrona": minor
---

- The CLI no longer uses a scoped application's REST API on the instance. `init`, `refresh`, `download`, `push`, `status` and `doctor` talk to the Table API only: the manifest and the file contents are built from Table API reads, the session scope is read from the `apps.current_app` user preference (`sys_user_preference`), and an ATF step script is pushed by updating its `script` input in `sys_variable_value`. `SYNCRONA_SCOPED_API_PREFIXES` no longer affects the CLI, and `status` no longer reports a scoped-endpoint capability. Writing an ATF step script needs write access to `sys_variable_value`, which stock instance ACLs can refuse; a refused write fails that file with a 401/403 error instead of being retried.
