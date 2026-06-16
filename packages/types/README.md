# @syncrona/types

Shared TypeScript type definitions for the Syncrona toolchain — the `Sync` and
`SN` namespaces consumed by `@syncrona/core`, `@syncrona/mcp-server`, and the
build plugins (e.g. `Sync.Config`, `Sync.PluginRule`, `Sync.FileContext`,
`SN.AppManifest`).

This package ships type declarations only (`index.d.ts`); there is no runtime
code. It is an internal building block of the
[Syncrona](https://github.com/LeassTaTT/syncrona) monorepo rather than a
general-purpose standalone library.

## Usage

```ts
import type { Sync, SN } from "@syncrona/types";

const rule: Sync.PluginRule = { match: /\.ts$/, plugins: [] };
```

See the repository README and `docs/PLUGIN_DEVELOPMENT.md` for how these types
are used when writing plugins.

## License

MIT — see [LICENSE](LICENSE).
