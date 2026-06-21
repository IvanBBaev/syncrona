# @syncro-now-ai/types

Shared TypeScript type definitions for the SyncroNow AI toolchain — the `Sync` and
`SN` namespaces consumed by `@syncro-now-ai/core`, `@syncro-now-ai/mcp-server`, and the
build plugins (e.g. `Sync.Config`, `Sync.PluginRule`, `Sync.FileContext`,
`SN.AppManifest`).

This package ships type declarations only (`index.d.ts`); there is no runtime
code. It is an internal building block of the
[SyncroNow AI](https://github.com/LeassTaTT/syncrona) monorepo rather than a
general-purpose standalone library.

## Usage

```ts
import type { Sync, SN } from "@syncro-now-ai/types";

const rule: Sync.PluginRule = { match: /\.ts$/, plugins: [] };
```

See the repository README and `docs/PLUGIN_DEVELOPMENT.md` for how these types
are used when writing plugins.

## License

MIT — see [LICENSE](LICENSE).
