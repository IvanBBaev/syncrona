---
"@syncrona/fluent": minor
---

Add a native Fluent install that needs no `@servicenow/sdk`: `nativeInstall` packs the built app, checks the previous install and the scope on the instance, uninstalls first on a clean reinstall, uploads the archive to the app-client upload processor, polls the install tracker and activates the app's flows, following the SDK's install protocol. `nativeInstallStatus` reports whether the last install finished.
