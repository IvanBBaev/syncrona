---
"@syncrona/fluent": minor
---

- The native Fluent compiler supports `DataPolicy()`: the `sys_data_policy2` record and a `sys_data_policy_rule` per entry of `rules`, byte for byte with SDK 4.13.6. Like the SDK, it reports a table outside the app's scope, a rule that is both mandatory and read-only, and a mandatory rule on a table outside the scope, and skips a rule that is not an object; a `mandatory` or `readOnly` other than a boolean or `'ignore'` is an error.
