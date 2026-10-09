# @syncrona/fluent

**Optional Fluent tier** for SyncroNow AI. It powers `syncrona fluent <action>`
by driving the ServiceNow SDK (`@servicenow/sdk`) orchestrator. That covers
building, transforming, packing and installing Fluent (`.now.ts`) applications,
plus generating types, adding dependencies and running project scripts.

The core CLI works without this package. Install it, together with the SDK, only
if you build Fluent applications:

```sh
npm install --save-dev @syncrona/fluent @servicenow/sdk
```

If either package is missing, `syncrona fluent` exits 1 with a single
install hint. No other command is affected.

## What lives here

- `createFluentEngine(options, deps?)`: implements the `SN.FluentEngine` port
  from `@syncrona/types`.
  - The SDK is loaded on the first call, never at import, because loading it
    costs about a second.
  - It is resolved from the Fluent project first, then from this package.
  - SDK telemetry is turned off (`NO_TELEMETRY=1`).
- `createFluentAuthResolver(instanceUrl, input)`: bridges a stored syncrona
  profile to the SDK's credential resolver.
  - A Basic profile logs in through the UI session (`angular.do`), so the
    session-only endpoints work: `sn_appclient_upload_processor.do`,
    `xmlhttp.do` and `fluent_update_set_export.do`.
  - An OAuth profile hands over its bearer token.
  - API-key profiles are refused, because the SDK cannot use them. A
    mutual-TLS client certificate works with either Basic or OAuth: core hands
    the adapter the TLS material as `tls`.
  - The resolver never memoizes. The SDK's own `LazyCredential` caches the
    result and re-resolves after an instance 401.
- `loginUiSession(instanceUrl, user, password, fetch?)`: the two-step UI login.
  It returns `{ type: "basic", token, cookie }` and never logs credentials.
- `explainDocs(docs, options)` and `defaultSdkDocsLoader(projectDir)`: back
  `fluent explain`. The loader finds the `docs` directory the SDK bundles and
  the public `@servicenow/sdk-api/docs` module without evaluating the SDK; it
  throws `FluentDocsUnavailableError` when either is missing.

## TLS

The UI login, the OAuth token request and the SDK's own requests all use Node's
native `fetch`. When the credential carries `tls` (a client certificate from
`SN_CLIENT_CERT` / `SN_CLIENT_KEY`, a CA bundle from `SYNCRONA_CA_BUNDLE`, or
`SYNCRONA_TLS_REJECT_UNAUTHORIZED=0`), the engine installs a TLS-configured
dispatcher as Node's global fetch dispatcher for the duration of each
instance-side action and restores the previous one afterwards, even when the
action throws. The dispatcher is built from the constructor of Node's default
dispatcher, so no extra dependency is needed; when the default dispatcher is
not an undici `Agent` (a proxy agent, for example), the action fails with
`FluentTlsUnavailableError` instead of silently skipping the TLS settings.
Because the slot is process-global, run one TLS-configured action at a time.

`syncrona fluent run` runs a project script locally and passes it no instance
credential.

## Licensing

This package is GPL-3.0-or-later. It does **not** vendor the ServiceNow SDK,
which ServiceNow publishes under MIT terms and the user installs separately as a
peer dependency.
See [`docs/PROVENANCE.md`](../../docs/PROVENANCE.md).
