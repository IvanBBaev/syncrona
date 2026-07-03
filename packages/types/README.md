# @syncrona/types

<!-- badges:start -->
| ![npm: not yet published](https://img.shields.io/badge/npm-not%20yet%20published-lightgrey?style=flat-square&logo=npm&logoColor=white) | [![node](https://img.shields.io/badge/node-%3E%3D22-5FA04E?style=flat-square&logo=nodedotjs&logoColor=white)](https://nodejs.org) | [![license](https://img.shields.io/github/license/IvanBBaev/syncrona?style=flat-square&color=blue&label=license)](../../LICENSE) | [![CI](https://img.shields.io/github/actions/workflow/status/IvanBBaev/syncrona/ci.yml?branch=main&style=flat-square&logo=githubactions&logoColor=white&label=CI)](https://github.com/IvanBBaev/syncrona/actions/workflows/ci.yml) | [![TypeScript](https://img.shields.io/badge/built%20with-TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)](https://www.typescriptlang.org/) |
|:--:|:--:|:--:|:--:|:--:|
<!-- badges:end -->

Shared TypeScript type definitions for the SyncroNow AI toolchain — the `Sync` and
`SN` namespaces consumed by `syncrona`, `@syncrona/mcp-server`, and the
build plugins (e.g. `Sync.Config`, `Sync.PluginRule`, `Sync.FileContext`,
`SN.AppManifest`).

This package ships type declarations only (`index.d.ts`); there is no runtime
code. It is an internal building block of the
[SyncroNow AI](https://github.com/IvanBBaev/syncrona) monorepo rather than a
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
