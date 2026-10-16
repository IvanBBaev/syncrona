---
"@syncrona/sn-transport": minor
"@syncrona/types": minor
"@syncrona/fluent": minor
"syncrona": minor
---

Inject a UI session into the Fluent tier, the counterpart of now-sdk's `SN_SDK_SESSION_TOKEN` / `SN_SDK_SESSION_COOKIE`. When `SN_SESSION_COOKIE` (with its `SN_SESSION_TOKEN` CSRF token) is set, the `fluent` actions hand that session to the SDK as is, ahead of the profile's method and without a login; a token without a cookie is refused. `FluentCredentialInput` gains a `session` kind, which `createFluentAuthResolver` returns unchanged. The variables are environment-only: `syncrona login` never stores them and clears stale ones from `.env`, and syncrona never renews the session. Other commands, and `fluent types --native`, keep using the profile.
