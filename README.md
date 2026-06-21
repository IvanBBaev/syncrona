# SyncroNow AI

[![CI](https://github.com/LeassTaTT/syncrona/actions/workflows/ci.yml/badge.svg)](https://github.com/LeassTaTT/syncrona/actions/workflows/ci.yml)

## Overview

SyncroNow AI is a tool for managing ServiceNow code in a more modern way. It allows you to:

1. Store scoped app code in GitHub in an editable way.🐙 (Looking at you studio source control👀)
2. Run your code through build pipelines that enable you to write modern JavaScript and use modern development tools such as [TypeScript](https://www.typescriptlang.org/), [Babel](https://babeljs.io/), and [Webpack](https://webpack.js.org/). 🎉
3. Take control of your development process in ServiceNow! 💪

Because your scoped-app code is downloaded as plain, editable files in a project folder, SyncroNow AI is well suited for **tracking your ServiceNow source code in Git** — giving you real diffs, history, branches and pull requests over code that would otherwise live only inside the instance.

Check out the [tutorial videos](https://www.youtube.com/watch?v=CqdppnM-FvM&list=PL1myMMPgZzOrOeu03YsuNmsDI2k0vadTq)!

**Project documentation**

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — package graph, the two
  ServiceNow clients and their shared transport policy, push/manifest flows,
  MCP request pipeline, and the **module contract** for adding/removing CLI
  commands and MCP tool families (mermaid diagrams).
- [docs/PRODUCT_STATE.md](docs/PRODUCT_STATE.md) — what works today, phase
  history, known gaps and operating constraints.
- [docs/MULTI_INSTANCE.md](docs/MULTI_INSTANCE.md) — credential precedence,
  instance profiles, the dev→prod workflow, and CI.
- [docs/MONOREPO_GUIDE.md](docs/MONOREPO_GUIDE.md) — multi-scope layout,
  per-scope vs shared config, and CI matrices.
- [docs/PLUGIN_DEVELOPMENT.md](docs/PLUGIN_DEVELOPMENT.md) — the plugin
  contract and how to write and wire your own build plugin.
- [docs/BUSINESS_ANALYSIS.md](docs/BUSINESS_ANALYSIS.md) — product vision,
  personas, value proposition, competitive positioning, KPIs, prioritized
  roadmap and risk register.
- [docs/COMPARISON.md](docs/COMPARISON.md) — SyncroNow AI vs ServiceNow native Git,
  Sincronia, and update sets (one-page comparison).
- [docs/ENTERPRISE_READINESS.md](docs/ENTERPRISE_READINESS.md) — what remains
  for a public 1.0 / enterprise release (done / scheduled / owner-gated).
- [ROADMAP.md](ROADMAP.md) — shipped capabilities and the path to v0.5 beta and
  v1.0 (with owner-gated items called out).
- [SECURITY.md](SECURITY.md) — vulnerability reporting and data-handling.
- [SUPPORT.md](SUPPORT.md) — getting help, diagnostics, support scope.
- [CONTRIBUTING.md](CONTRIBUTING.md) — dev setup, quality gates, conventions.
- [CODE_OF_CONDUCT.md](CODE_OF_CONDUCT.md) — community standards.
- [packages/mcp-server/README.md](packages/mcp-server/README.md) — MCP server
  setup, tools, guardrails, and safety notes.
- [CHANGELOG.md](CHANGELOG.md) — notable changes per release.

**Table of Contents**

- [SyncroNow AI](#syncronow-ai)
  - [Overview](#overview)
  - [Installation](#installation)
    - [Requirements](#requirements)
    - [Instructions](#instructions)
  - [How does it work?](#how-does-it-work)
    - [Commands](#commands)
      - [Using the diff option](#using-the-diff-option)
    - [Workflow](#workflow)
    - [File Structure](#file-structure)
      - [sync.config.js](#syncconfigjs)
      - [sync.manifest.json](#syncmanifestjson)
      - [sync.diff.manifest.json](#syncdiffmanifestjson)
      - [.env](#env)
    - [Asymmetric Source Code](#asymmetric-source-code)
    - [Power of Extensions](#power-of-extensions)
  - [Configuration](#configuration)
    - [There are WAY too many files in here!](#there-are-way-too-many-files-in-here)
    - [I'm not seeing all my code files!](#im-not-seeing-all-my-code-files)
    - [Plugin Configuration](#plugin-configuration)
    - [Table Options](#table-options)
  - [FAQ](#faq)
    - [How do I Delete Something?](#how-do-i-delete-something)
    - [How do I Add New Scripts?](#how-do-i-add-new-scripts)
    - [How do I work with multiple instances?](#how-do-i-work-with-multiple-instances)
    - [How do I work with several scoped apps in one repo?](#how-do-i-work-with-several-scoped-apps-in-one-repo)
    - [Getting unstuck](#getting-unstuck)
  - [Examples](#examples)
  - [Plugin List](#plugin-list)

## Installation

### Global CLI quick start

```bash
npm i -g @syncro-now-ai/core
syncro-now-ai login
syncro-now-ai init
```

### Requirements

In order to use SyncroNow AI, you will need:

- [Node.js](https://nodejs.org/en/) version 22.0 or later

> ⚠️ **Windows users:** WSL (Windows Subsystem for Linux) is currently
> **required** — native Windows is not yet supported.
>
> - Install WSL with an Ubuntu distribution (Windows version 1903+; earlier
>   versions are untested/not working)
> - Run all `syncrona` commands from inside the WSL shell
> - (Optional) Windows Terminal is recommended for proper text rendering
>
> Native Windows support (PowerShell install, Windows Credential Manager) is
> on the roadmap.

**ServiceNow compatibility:** SyncroNow AI talks to standard ServiceNow REST/Table
APIs and works with or without the companion scoped app, so it is broadly
release-agnostic. It is actively used against recent ServiceNow releases; a
formal supported-version matrix is being established — if you hit a
release-specific issue, please open an issue with your instance version.

**Authentication:** HTTP Basic auth over HTTPS by default. **OAuth 2.0** is
supported (CLI): set `SN_OAUTH_CLIENT_ID` and `SN_OAUTH_CLIENT_SECRET` (with the
same `SN_USER`/`SN_PASSWORD`, optionally per-profile `_<PROFILE>` suffixes) and
the CLI exchanges them for a Bearer token at `oauth_token.do`, refreshing on
expiry/401. Without those vars it stays on Basic. Use a dedicated least-privilege
integration user. See [SECURITY.md](SECURITY.md) and
[docs/MULTI_INSTANCE.md](docs/MULTI_INSTANCE.md).

### Instructions

1. Create a folder to store the scoped app code.
2. In a terminal, run `npm init` inside the newly created folder and follow the instructions to set up your node module.
3. (Optional) Install the companion server scoped app on your instance — the CLI works against plain ServiceNow REST APIs **with or without** it; the scoped app only enables a few enhanced endpoints.
4. Install `@syncro-now-ai/core`

```bash
npm i -D @syncro-now-ai/core
```

4. Initialize your SyncroNow AI project

```bash
npx syncro-now-ai init
```

If your repository is a monorepo with many scoped apps under `packages/`, run SyncroNow AI from the specific scope directory, for example `packages/cs`. Each scope package should get its own `.env`, `sync.config.js`, and `sync.manifest.json`.

5. [Configure your project!](#configuration)
6. **OPTIONAL BUT HIGHLY RECOMMENDED** Once your project is configured the way you like, you can commit and push it to a git repository for superior tracking and version control! Make sure to create a `.gitignore` file and ignore `node_modules` and `.env` because you **really** don't want those files in your repository.
7. Start dev mode and start working! Every time you save a file that is tracked by SyncroNow AI, it will be built with your ruleset and the result will be placed in ServiceNow!

```bash
npx syncro-now-ai dev
```

## How does it work?

SyncroNow AI takes a two-pronged approach to managing your ServiceNow scoped app. Architecture, creation of records, deletion of records, metadata and other ServiceNow objects besides your actual source code will be managed normally. Your _source code itself_ will be managed inside of your SyncroNow AI project.

### Commands

SyncroNow AI has a few basic commands to help you get the job done

| Command            | Aliases  | Description                                                                                                                                                 | Usage                           |
| ------------------ | -------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------- |
| `refresh`          | `r`      | Refreshes the `sync.manifest.json` file and downloads all new files created in ServiceNow synce the last refresh. Does not override existing file contents. | `npx syncro-now-ai refresh`              |
| `dev`              | `d`      | Starts development mode. Watches files for changes, then builds and pushes them to the corresponding record. Only works on files in the manifest file.      | `npx syncro-now-ai dev`                  |
| `init`             | **none** | Walks you through creating a basic SyncroNow AI project. This is the recommended way to create a SyncroNow AI project from scratch.                               | `npx syncro-now-ai init`                 |
| `push`             | **none** | Builds and pushes all files in your local SyncroNow AI project to the ServiceNow instance in your `.env` file                                                  | `npx syncro-now-ai push`                 |
| `download <scope>` | **none** | Downloads the specified scoped app, overwriting all local files in the way. **Only use this if you know what you are doing!**                               | `npx syncro-now-ai download my_test_app` |
| `build`            | **none** | Builds the local SyncroNow AI project and stores the files locally                                                                                             | `npx syncro-now-ai build`                |
| `deploy`           | **none** | Deploys the files in the build folder to the ServiceNow instance.                                                                                           | `npx syncro-now-ai deploy`               |
| `docs`             | **none** | Generates or logically updates Markdown documentation and Mermaid diagrams describing the downloaded scope (overview, tables, per-record files).            | `npx syncro-now-ai docs`                 |
| `status`           | **none** | Shows extended workspace status: instance/user/scope, config paths, env readiness, and connectivity diagnostics.                                           | `npx syncro-now-ai status`               |
| `check-env`        | **none** | Checks machine prerequisites (Node 22+, supported platform/WSL, Git) and prints actionable fixes.                                                          | `npx syncro-now-ai check-env`            |
| `doctor`           | **none** | Runs local configuration and ServiceNow connectivity diagnostics, and reports actionable failures.                                                         | `npx syncro-now-ai doctor`               |
| `plugins`          | **none** | Shows configured plugin rules and reports plugin package availability (installed or missing) from the current workspace.                                  | `npx syncro-now-ai plugins`              |
| `config <action>`  | **none** | Inspect configuration. `config show-defaults` prints the built-in default includes/excludes and settings applied before `sync.config.js`.                  | `npx syncro-now-ai config show-defaults` |
| `mcp`              | **none** | Starts standalone MCP server and can auto-configure local MCP client files (`.vscode/mcp.json`, `.syncrona-mcp/secrets.json`).                            | `npx syncro-now-ai mcp`                  |
| `login [instance]` | **none** | Saves ServiceNow credentials in the encrypted global CredentialStore and optionally sets active instance.                                                  | `npx syncro-now-ai login dev123.service-now.com` |
| `logout [instance]`| **none** | Removes stored credentials for one instance (or all with `--all`) from the global CredentialStore.                                                       | `npx syncro-now-ai logout dev123.service-now.com` |
| `instances`        | **none** | Lists instances saved in the global CredentialStore and marks the active one.                                                                              | `npx syncro-now-ai instances`            |
| `use <instance>`   | **none** | Sets active instance from the global CredentialStore for subsequent commands.                                                                              | `npx syncro-now-ai use dev123.service-now.com` |

`init` wizard behavior notes:

1. Prefers credentials from environment when available.
2. Falls back to the active CredentialStore instance before prompting.
3. Persists selected credentials to the global CredentialStore and writes `.env`.
4. Runs a lightweight initial doctor connection check at the end of setup.

#### Credential storage security

The global CredentialStore writes each instance's credentials to
`~/.syncrona/credentials/<instance>.enc`, encrypted with AES-256-GCM. The
encryption key is resolved with this precedence:

1. **`SYNCRONA_STORE_KEY`** — an explicit 32-byte key (64 hex characters or
   base64). Use this for CI/CD and shared environments, sourced from a secrets
   manager. This is the strongest option.
2. **OS keychain** — opt in with `SYNCRONA_USE_KEYCHAIN=1`. A random 256-bit
   master key is generated once and stored in the OS keychain (macOS Keychain /
   Windows Credential Manager / libsecret), via the optional `@napi-rs/keyring`
   dependency. The on-disk files stay useless without keychain access.
3. **Machine-derived key (default)** — derived from your machine hostname and
   username. This is **obfuscation-grade, not strong cryptography**.

> ⚠️ With the default machine-derived key, anyone who can read the `.enc` file
> **and** run code as your user on the same machine (or who knows your hostname +
> username) can decrypt the credentials. It guards against casual inspection and
> accidental file sharing — not a compromised account, stolen disk, or malware
> running as your user. Configure an explicit key or the keychain for real
> at-rest protection.

Reads fall back to the machine-derived key, so credential files written before
this change keep decrypting; the next `syncro-now-ai login` re-encrypts them with the
resolved key.

Recommendations:

- Treat the machine as a trust boundary. Rely on OS file permissions
  (`~/.syncrona` is created with user-only access) and full-disk encryption.
- For **CI/CD and shared environments**, set `SYNCRONA_STORE_KEY` from a secrets
  manager (or prefer plain environment variables over the on-disk store).
- On a workstation, enable `SYNCRONA_USE_KEYCHAIN=1` for keychain-backed keys.
- Always use a dedicated integration user with least-privilege roles, and rotate
  its password if a credential file may have been exposed.

#### Using the diff option

`--diff <branch>` means **different things for `push` and `build`** — both use
`git diff <branch>...` against your source folder, but apply it differently:

- **`syncro-now-ai push --diff <branch>`** pushes **only the files that changed**
  versus that branch. This is the "changed-only" push — use it to push just your
  feature's edits instead of the whole scope.

  ```bash
  npx syncro-now-ai push --diff main
  ```

- **`syncro-now-ai build --diff <branch>`** builds **all** source files but also
  writes a `sync.diff.manifest.json` recording which files changed, so a later
  `syncro-now-ai deploy` can target just those (an audit/deploy-tracking trail).

  ```bash
  npx syncro-now-ai build --diff main
  ```

Without `--diff`, `push` and `build` act on the entire source folder.

#### Using dry-run mode

For commands that can change remote or local artifacts (`push`, `deploy`, `download`, and `build`), you can preview effects without applying writes by adding `--dry-run`.

```bash
npx syncro-now-ai push --dry-run
```

#### Using instance profiles

To work with multiple ServiceNow instances from one workspace, define profile-specific env vars and select them with `--instance-profile`.

```bash
SN_INSTANCE_DEV=dev123.service-now.com
SN_USER_DEV=dev.user
SN_PASSWORD_DEV=dev.password

npx syncro-now-ai status --instance-profile dev
```

Profile vars (`SN_INSTANCE_<PROFILE>`, `SN_USER_<PROFILE>`, `SN_PASSWORD_<PROFILE>`) fall back to base vars when a specific value is missing.

#### Manifest refresh in dev mode

In `dev` mode SyncroNow AI periodically re-reads the instance manifest to pick up
records created in ServiceNow since you started (it does **not** overwrite local
file contents). The interval defaults to **30 seconds** (`refreshInterval` in
`sync.config.js`). Overlapping refreshes are guarded — a slow refresh never
stacks. On a slow network, raise the interval or disable polling:

```bash
npx syncro-now-ai dev --refresh-interval 60   # poll every 60s
npx syncro-now-ai dev --refresh-interval 0    # disable polling; refresh manually with `syncro-now-ai refresh`
```

Run with `--log-level debug` to see `Manifest refresh took Xms` and per-file
rule matches.

### Workflow

![Development Workflow](docs/images/sincronia-development.png)

![Deployment Workflow](docs/images/sincronia-deployment.png)

### File Structure

When you download your source code using SyncroNow AI, it creates a folder structure that goes as follows:

```text
project_folder/
  src/
    table_name/
      record_name/
        field_name.extension
```

Records are shown as folders because there are times where there are multiple code files per record. This makes it very important that you **never have records with the exact same display value in the same table!** If you do, then you will notice issues building your files to the right record in ServiceNow.

#### sync.config.js

This is the configuration file for SyncroNow AI. [Learn More](#configuration)

#### sync.manifest.json

Keeps track of all ServiceNow files that are watched by SyncroNow AI. **Do not manually modify it**

#### sync.diff.manifest.json

Tracks changed files for build and deploy commands when using diff option.

#### .env

Stores login credentials and and the instance URL. **Do not commit this to git**

### Asymmetric Source Code

When you download your source code using SyncroNow AI, you are effectively 'taking control' of that code. **Once the code is in your project, you no longer want to edit it directly in ServiceNow!** This is why putting your code into source control is highly recommended. **Anything else besides code, such as tables, configuration of script records, metadata, etc. must still be tracked in ServiceNow and passed along with your preferred method of moving ServiceNow architecture**

Modern javascript development workflows are **asymmetric**, meaning that the source code you write is usually not the code that gets executed. It is built using various tools and compiled/transpiled into some more compatible or smaller javascript code that is run by browsers or node environments.

SyncroNow AI takes advantage of this same principle by allowing you to leverage some of those same tools. This means that you will no longer be able to store your source code directly in ServiceNow, instead you will have a local version of your source code that gets built and the result of that build will be put into ServiceNow.

**EXAMPLE**

Let's say I want to develop using TypeScript. Once I have the right plugin configuration for my needs, this Typescript file:

```typescript
// Example/script.ts
class Example {
  constructor(message: string) {
    gs.info(message);
  }
  sayHello() {
    gs.info("Hello, SyncroNow AI!");
  }
}
```

becomes

```javascript
// ServiceNow `Example` script include.
"use strict";

function _classCallCheck(instance, Constructor) {
  if (!(instance instanceof Constructor)) {
    throw new TypeError("Cannot call a class as a function");
  }
}

function _defineProperties(target, props) {
  for (var i = 0; i < props.length; i++) {
    var descriptor = props[i];
    descriptor.enumerable = descriptor.enumerable || false;
    descriptor.configurable = true;
    if ("value" in descriptor) descriptor.writable = true;
    Object.defineProperty(target, descriptor.key, descriptor);
  }
}

function _createClass(Constructor, protoProps, staticProps) {
  if (protoProps) _defineProperties(Constructor.prototype, protoProps);
  if (staticProps) _defineProperties(Constructor, staticProps);
  return Constructor;
}

var Example =
  /*#__PURE__*/
  (function () {
    function Example(message) {
      _classCallCheck(this, Example);

      gs.info(message);
    }

    _createClass(Example, [
      {
        key: "sayHello",
        value: function sayHello() {
          gs.info("Hello, SyncroNow AI!");
        },
      },
    ]);

    return Example;
  })();
```

### Power of Extensions

File extensions are typically only one short blurb (e.g. `.js`, `.css`, etc.). When you use SyncroNow AI, you may find that you want to treat one `.js` file differently than another. That's where extensions can become more powerful! You could create an extension in your project such as `.server.js` and `.client.js` which you could combine with the [rules](#plugin-configuration) configuration of SyncroNow AI to have _two different build pipelines_. You could use Webpack for client scripts and Babel for server scripts! Pretty cool huh?

As long as the main filename stays the same, you can add as many extensions as you want.

**EXAMPLE**

`script.js` becomes `script.servicenow.js` or `script.ts` or `script.what.ever.you.want.js`

## Configuration

SyncroNow AI aims to be as configurable as possible. To do that, it creates a special javascript file in your project directory called `sync.config.js`. It's contents will look something like this:

```javascript
module.exports = {
  // Directory where your source files will be kept and will be watched by SyncroNow AI
  // during development.
  sourceDirectory: "src",
  //Directory where local builds will be stored
  buildDirectory: "build",
  // This is where you will configure your plugins. You match based on plugins.
  // Order your rules by MOST SPECIFIC extension first! The first match is the
  // only one that gets executed.
  rules: [],
  // === INCLUDES/EXCLUDES apply on top of the default config! See more below ===
  // Tables/fields to exclude (AKA not download or track) from SyncroNow AI
  excludes: {},
  // Tables/fields to explicitly include in your SyncroNow AI project.
  // Can override excludes if necessary.
  includes: {},
  //How often syncrona will refresh the manifest in development mode
  refreshInterval: 30,
};
```

If you find that your config is getting too large, you can use typical nodejs techniques for splitting it into smaller modules and loading them into the `sync.config.js`.

### There are WAY too many files in here!

**OR**

### I'm not seeing all my code files!

When you first set up your project, you may notice you may have more files than you want to manage or some files are missing. This can be easily resolved by tweaking your `includes` and `excludes` section of your `sync.config.js`. SyncroNow AI attempts to establish sane defaults for these values [here](packages/core/src/defaultOptions.ts) (and you can list them with `syncro-now-ai config show-defaults`).

If you think there is something wrong with the default setup, feel free to submit a pull request! 🐙👍

The `excludes` and `includes` sections in your `sync.config.js` act as additions to that default setting. You can override parts of it or turn parts of it off.

Once you have updated your includes and excludes, run `npx syncro-now-ai refresh` to load the new files and update the manifest. You will have to manually delete any newly excluded tables/fields.

```javascript
// sync.config.js
module.exports = {
  excludes: {
    // Turns off the default exclusion of the `sys_scope_privilege` table
    sys_scope_privilege: false,
    // Excludes everything from the `my_cool_table` table
    my_cool_table: true,
    // Excludes the `cool_script` field specifically from the `new_cool_table` table.
    // Other valid fields will be included.
    new_cool_table: {
      cool_script: true,
    },
  },
  includes: {
    // Turns off the default inclusion of the `content_css` table
    content_css: false,
    // Explicitly includes the `sys_report` table. Overrides any excludes on the
    // same table.
    sys_report: true,
    // Explicitly pulls in the `neat_script_field` as a `js` file in spite of whatever
    // type of field it might be in ServiceNow. Useful for text fields that
    // represent code.
    special_code_table: {
      neat_script_field: {
        type: "js",
      },
    },
  },
};
```

### Plugin Configuration

Plugins are where the true 💪 **POWER** 💪 of SyncroNow AI comes from! The `rules` section is used to configure plugins. When configuring plugins, **Make sure to always put your rules in the order you want them matched! The first rule that gets matched will be the only one that runs!**

```javascript
// sync.config.js
module.exports = {
  rules: [
    {
      // The match argument is a regular expression that will match on your desired files
      // The order matters, so put your most specific rules first!
      // If there is a file that ends in `.secret.ts` it will match here and
      // NO PLUGINS WILL BE RUN
      match: /\.secret\.ts$/,
      plugins: [],
    },
    {
      // If there are just generic TypeScript files that have no other extension, they will
      // match on this rule instead.
      match: /\.ts$/,
      // List of plugins to run on the matched files. Each plugin will run in order.
      // THE RESULT OF THE PREVIOUS PLUGIN WILL BE PASSED TO THE NEXT PLUGIN so make
      // sure they are in the right order!
      plugins: [
        {
          // The name of the plugin, it is the same as the name of the NPM package of
          // the plugin.
          name: "@syncro-now-ai/typescript-plugin",
          // Options to pass to the plugin. This will be defined by the plugin itself.
          // In this case, we are telling the typescript plugin to only type check and
          // not transpile.
          options: {
            transpile: false,
          },
        },
      ],
    },
  ],
};
```

### Table Options

**This is a relatively new feature and potentially subject to change**

The `tableOptions` section allows for special setups on any table. Example:

```javascript
// sync.config.js
module.exports = {
  // ...
  tableOptions: {
    some_table: {
      // sets the field used for the record folder name
      displayField: "some_field",
      // Allows to de-duplicate records based on certain fields
      differentiatorField: "sys_id",
      // can be an array, if there isn't a value in a field, it moves to the next one
      differentiatorField: ["some_field", "sys_id"],
      // an encoded query to filter records by
      query: "some_field=test",
    },
  },
};
```

**When to use each option**

- **`displayField`** — the field whose value names each record's folder. Use it
  when a table's default display value is empty, non-unique, or not filesystem-
  friendly (e.g. records keyed by a code field rather than `name`). Picking a
  field with a clear, unique value per record keeps the folder tree readable.
- **`differentiatorField`** — appended in parentheses to disambiguate records
  that share the same `displayField` value (otherwise they would collide on the
  same folder and one would overwrite the other — see the "never have records
  with the same display value" warning under [File Structure](#file-structure)).
  Use it when a table legitimately has duplicate display values; point it at a
  field that differs between them (e.g. `version`, or `sys_id` as a last resort).
  An array tries each field in order until one has a value.
- **`query`** — an encoded query that limits which records are tracked for the
  table. Use it to scope large tables down to the records you actually edit.

**Note on differentiatorField**

This feature will currently put a colon in the filename, which breaks the
Windows filesystem (and WSL paths under `/mnt`). Prefer a non-`sys_id`
differentiator where possible, and avoid it entirely if your team works on
native Windows.

## FAQ

### How do I Delete Something?

Deleting something in SyncroNow AI is relatively simple. Just follow these steps:

1. Turn off dev mode if you are currently running SyncroNow AI
2. Delete the record in ServiceNow
3. Run `npx syncro-now-ai refresh`
4. Remove the files from your project

Why is this not automatic? Deleting files can be a dangerous game and it should be a deliberate action!

### How do I Add New Scripts?

1. Turn off dev mode if you are currently running SyncroNow AI
2. Create the record in ServiceNow
3. Run `npx syncro-now-ai refresh` and the files will get created automatically 👍

### How do I work with multiple instances?

Use the global credential store (`syncro-now-ai login` / `syncro-now-ai use`) or
instance-profile env vars and `--instance-profile`. `syncro-now-ai status` shows
which instance and credential source are active. Full guide:
[docs/MULTI_INSTANCE.md](docs/MULTI_INSTANCE.md).

### How do I work with several scoped apps in one repo?

Treat each scope as its own project under `packages/`, run commands from the
scope directory, and share `node_modules`/plugins at the root. Full guide:
[docs/MONOREPO_GUIDE.md](docs/MONOREPO_GUIDE.md).

### Getting unstuck

- **"credentials missing" after logging in** — the stored credential file may
  not decrypt on this machine. Run `syncro-now-ai status --debug-credentials`; if it
  reports a decrypt failure, re-run `syncro-now-ai login`.
- **Connecting to the wrong instance** — run `syncro-now-ai status` and check
  `Credentials from:`. A stale project `.env` wins over the store; fix or remove
  it, or pass `--instance-profile`.
- **`syncro-now-ai download` overwrote my edits** — `download` is destructive by
  design (it confirms first; `--ci` skips the prompt). Keep your source in git
  so a bad download is a `git checkout` away.
- **A push failed partway** — fix the cause and run `syncro-now-ai push` again; it
  offers to resume only the records that failed last time.
- **Slow network** — `syncro-now-ai dev --refresh-interval 60` polls less often, and
  `syncro-now-ai push --concurrency 5` throttles parallel pushes.
- **Environment problems** — `syncro-now-ai check-env` verifies Node, platform/WSL,
  and Git, and prints actionable fixes.

## Examples

After downloading a scope, run `npx syncro-now-ai docs` to generate Markdown
documentation and Mermaid diagrams for it (overview, tables, per-record files) —
a quick way to explore what a real SyncroNow AI project looks like. The
[tutorial videos](https://www.youtube.com/watch?v=CqdppnM-FvM&list=PL1myMMPgZzOrOeu03YsuNmsDI2k0vadTq)
linked above also walk through a complete project setup.

## Plugin List

| Name                                                                       | Description                                 |
| -------------------------------------------------------------------------- | ------------------------------------------- |
| [@syncro-now-ai/babel-plugin](packages/babel-plugin/README.md)                 | Runs Babel on .js/.ts files                 |
| [@syncro-now-ai/prettier-plugin](packages/prettier-plugin/README.md)           | Prettifies your output files using Prettier |
| [@syncro-now-ai/sass-plugin](packages/sass-plugin/README.md)                   | Runs the Sass compiler on your files        |
| [@syncro-now-ai/typescript-plugin](packages/typescript-plugin/README.md)       | Type checks and compiles TypeScript files   |
| [@syncro-now-ai/webpack-plugin](packages/webpack-plugin/README.md)             | Creates Webpack bundles with your files     |
| [@syncro-now-ai/eslint-plugin](packages/eslint-plugin/README.md)               | Runs ESLint on your files on build          |

## Trademarks & license

ServiceNow is a registered trademark of ServiceNow, Inc. This project is an
independent, third-party tool and is not affiliated with, endorsed by, or
sponsored by ServiceNow, Inc. All other trademarks are the property of their
respective owners. SyncroNow AI is released under the [MIT License](LICENSE).
