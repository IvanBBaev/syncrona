// SPDX-License-Identifier: GPL-3.0-or-later
//
// @syncrona/types — the shared type contract of the syncrona toolchain.
//
// Two namespaces, both type-only (this package ships no runtime code):
//
//   Sync  what syncrona itself defines: the `sync.config.js` project
//         configuration, the build-plugin contract, CLI arguments and the
//         records that flow through the build and push pipelines.
//   SN    what mirrors the ServiceNow side: the application manifest that
//         maps instance records to local files, the instance records the CLI
//         reads, and the port to the optional Fluent (`.now.ts`) adapter.
//
// Consumers import the namespaces only (`import type { Sync, SN } from
// "@syncrona/types"`); every member is part of the published 1.x contract.

export namespace Sync {
  // === Project configuration (`sync.config.js`) ==============================
  //
  // The object a project's `sync.config.js` exports, after syncrona merged it
  // with its defaults. The keys are the documented 1.x configuration surface;
  // renaming one breaks every existing project, so they only ever grow.

  /** The resolved project configuration: the user's `sync.config.js` merged over syncrona's defaults. */
  interface Config {
    /** Directory, relative to the project root, that holds the synced record files (`src` by default). */
    sourceDirectory: string;
    /** Directory, relative to the project root, that `syncrona build` writes its output to. */
    buildDirectory: string;
    /** Upper bound on records pushed in parallel; `push --pushConcurrency` overrides it. */
    pushConcurrency?: number;
    /** Build-plugin rules, tried in order; the first rule whose `match` fits a file decides its plugins. */
    rules?: PluginRule[];
    /** Tables (or single fields of a table) to sync in addition to the built-in table list. */
    includes?: TablePropMap;
    /** Tables (or single fields of a table) to leave out of the sync. */
    excludes?: TablePropMap;
    /** Per-table download options, keyed by table name. */
    tableOptions: ITableOptionsMap;
    /** Seconds between manifest refreshes in `syncrona dev`; 0 turns polling off. */
    refreshInterval: number;
    /** DX17: store records as a flat <table>/<record>~<field>.<ext> tree. */
    flat?: boolean;
    /**
     * Write a `.meta.json` sidecar next to every record's field files, holding
     * the record's non-file columns. Defaults to true; set false to opt out.
     */
    meta?: boolean;
    /**
     * Push local edits to a `.meta.json` sidecar back to the instance. Defaults
     * to true; set false to keep the sidecar as read-only reference data.
     */
    metaPush?: boolean;
    /**
     * Default for `push --create`: create (or adopt) records for local files
     * that are not in the manifest yet. Defaults to false; the CLI flag wins.
     */
    createRecords?: boolean;
    /**
     * Tables `push --create` may create records in even though they do not
     * extend `sys_metadata`. The always-deny list still applies.
     */
    createTables?: string[];
    /**
     * R4: data-model tables to track as editable local records (a record with
     * no field file is represented by its `.meta.json` sidecar alone). Opt-in:
     * defaults to an empty list. Naming a table re-includes it even when it is
     * excluded by default. See docs/DATA_MODEL.md for the documented list.
     */
    dataModelTables?: string[];
    /**
     * SDK-F2: how the sidecars of `sys_db_object`, `sys_dictionary` and
     * `sys_choice` are stored. `"records"` (default) writes one `.meta.json`
     * per record; `"composite"` writes one `data-model/<table>.json` document
     * per table holding the table, its columns and their choices.
     */
    dataModelLayout?: "records" | "composite";
    /**
     * WP3: named table groups (`"uib"`, `"workspace"`, `"ai"`) whose JSON
     * columns — every `json` / `json_translations` column plus the string
     * columns a preset names as JSON (e.g. `sys_ux_macroponent.composition`) —
     * are synced as `.json` field files instead of sidecar strings. WP2:
     * `"flow"` writes each Flow Designer flow and custom action as a
     * read-only, decoded `sys_hub_flow/<name>.flow.json` or
     * `sys_hub_action_type_definition/<name>.action.json` document. WP2c:
     * `"playbook"` writes each Process Automation Designer playbook as a
     * read-only `sys_pd_process_definition/<name>.playbook.json` document. WP2f:
     * `"workflow"` writes each legacy (Workflow Editor) workflow as a read-only
     * `wf_workflow/<name>.workflow.json` document. Opt-in: defaults to an empty
     * list. Unknown names are refused.
     */
    tablePresets?: string[];
  }

  /** `Config.tableOptions`: download options keyed by table name. */
  type ITableOptionsMap = Record<string, ITableOptions>;

  /** How syncrona selects and names the records of one table. */
  interface ITableOptions {
    /** Encoded query that limits which records of the table are synced. */
    query: string;
    /** Column whose value names a record's folder, instead of the table's display column. */
    displayField?: string;
    /** Column(s) appended to the folder name so records sharing a display value stay distinct. */
    differentiatorField?: string | string[];
    /**
     * Explicit sidecar columns for this table. Replaces dictionary discovery,
     * so it can also re-add a column the default rules exclude.
     */
    metaFields?: string[];
    /**
     * Columns whose non-empty values, joined with ".", name each record (a
     * dotted entry is a Table API dot-walk). Set automatically for the
     * data-model tables listed in `dataModelTables`; `displayField` wins.
     */
    nameFields?: string[];
  }

  /**
   * `Config.includes` / `Config.excludes`, keyed by table name: `true` (or
   * `false`) for the whole table, or a map that names individual fields.
   */
  type TablePropMap = Record<string, boolean | FieldMap>;

  /** The fields of one table named in `includes` / `excludes`, keyed by column name. */
  type FieldMap = Record<string, FieldConfig>;

  /** How one included field is stored locally. */
  interface FieldConfig {
    /** The file type, and with it the extension, the field's file is written with. */
    type: SN.FileType;
  }

  // === Build plugins ==========================================================
  //
  // A build plugin is a module that exports `run`. For every file that a rule
  // in `Config.rules` matches, syncrona calls the rule's plugins one after
  // another as `run(context, content, options)`: `content` is the previous
  // plugin's `output` (the file text for the first one), and `options` is the
  // rule entry's `options` value, passed through untouched. The text the last
  // plugin returns is what `build` writes and `push` sends. A result with
  // `success: false` stops the chain and fails that record.

  /** One entry of `Config.rules`: the plugins that process files whose path matches. */
  interface PluginRule {
    /** Tested against the file's path; the first rule that matches wins and no later rule applies. */
    match: RegExp;
    /** The plugins to run in order; an empty list copies the matched files unchanged. */
    plugins: PluginConfig[];
  }

  /** A plugin reference inside a rule. */
  interface PluginConfig {
    /** Package name (resolved from the project's `node_modules`) or a path relative to the project root. */
    name: string;
    /** Plugin-defined settings handed to `run` as its third argument; may be absent at runtime. */
    options: Record<string, any>;
  }

  /** The file a plugin is asked to process, and the record field it belongs to. */
  interface FileContext {
    /** Absolute path of the local file. */
    filePath: string;
    /** Extension of the file including the leading dot (e.g. `.js`). */
    ext: string;
    /** Display name of the record the file belongs to (its folder name). */
    name: string;
    /** Table of the record. */
    tableName: string;
    /** Column of the record the file's text is written to. */
    targetField: string;
    /** sys_id of the record. */
    sys_id: string;
    /** Application scope the record belongs to. */
    scope: string;
    /** The text to use instead of reading `filePath`, when the file exists only in memory. */
    fileContents?: string;
  }

  /** What a plugin's `run` resolves to. */
  interface PluginResults {
    /** False stops the plugin chain and fails the record. */
    success: boolean;
    /** The transformed text; the next plugin's input, or the final value when this plugin is the last. */
    output: string;
  }

  /**
   * The `run` export of a build plugin. `TOptions` is the shape of the rule's
   * `options`; it defaults to `any` so a plugin may declare its own type.
   */
  interface PluginFunc<TOptions = any> {
    (context: FileContext, content: string, options: TOptions): Promise<PluginResults>;
  }

  /** The module shape syncrona loads for a configured plugin. */
  interface Plugin<TOptions = any> {
    /** Transforms one file; see `PluginFunc`. */
    run: PluginFunc<TOptions>;
  }

  /** The outcome of running a file through its whole plugin chain. */
  interface TransformResults {
    /** False when one of the plugins reported failure. */
    success: boolean;
    /** The final text; empty when `success` is false. */
    content: string;
  }

  // === CLI arguments ============================================================

  /** Options every command that takes the shared CLI options receives. */
  interface SharedCmdArgs {
    /** Log verbosity (`error`, `warn`, `info`, `debug`). */
    logLevel: string;
    /** Preview the run without changing the instance or the local tree. */
    dryRun?: boolean;
    /** Stored instance profile to use instead of the active one. */
    instanceProfile?: string;
    /** Non-interactive mode: never prompt. */
    ci?: boolean;
  }

  /** Arguments of `syncrona download`. */
  interface CmdDownloadArgs extends SharedCmdArgs {
    /** Application scope to download. */
    scope: string;
  }

  /** Arguments of `syncrona build`. */
  interface BuildCmdArgs extends SharedCmdArgs {
    /** Git ref to diff against; when set, only changed files are built. */
    diff: string;
    /** Validate the configuration and stop before building. */
    checkConfig?: boolean;
  }

  /** Arguments of `syncrona push`. */
  interface PushCmdArgs extends SharedCmdArgs {
    /** File or directory to push instead of the whole source tree. */
    target?: string;
    /** Git ref to diff against; when set, only changed files are pushed. */
    diff: string;
    /** Switch the session to the manifest's scope when it differs. */
    scopeSwap: boolean;
    /** Name of the update set to record the push in. */
    updateSet: string;
    /** Non-interactive mode: never prompt. */
    ci: boolean;
    /** Upper bound on records pushed in parallel; wins over `Config.pushConcurrency`. */
    pushConcurrency?: number;
    /**
     * Create (or adopt) records for local files that are not in the manifest.
     * Undefined when the flag is absent, so `createRecords` in sync.config.js
     * can supply the default.
     */
    create?: boolean;
    /**
     * R2: delete instance records whose local files are all gone. Per run only;
     * there is deliberately no config switch.
     */
    prune?: boolean;
    /**
     * Lets `--prune` past its mass-delete guard (more than 25 records, or a
     * large share of the manifest) and, under `--ci`, run without --diff or a
     * target.
     */
    allowMassDelete?: boolean;
  }

  // === Build and push pipeline ================================================

  /** A record ready to be built: its table, its sys_id and one context per field file. */
  interface BuildableRecord {
    /** Table of the record. */
    table: string;
    /** sys_id of the record (empty while `push --create` has not created it yet). */
    sysId: string;
    /** File contexts keyed by the column each file is written to. */
    fields: Record<string, FileContext>;
  }

  /** A record whose fields all built: the column values to send. */
  interface RecBuildSuccess {
    success: true;
    /** Built text keyed by column name. */
    builtRec: Record<string, string>;
  }

  /** A record that could not be built. */
  interface RecBuildFail {
    success: false;
    /** Why the build failed, ready for the log. */
    message: string;
  }

  /** The outcome of building one record; narrow it on `success`. */
  type RecBuildRes = RecBuildSuccess | RecBuildFail;

  /** The outcome of pushing one record. */
  interface PushResult {
    /** Whether the instance accepted the record. */
    success: boolean;
    /** Summary line for the log. */
    message: string;
  }

  /** The outcome of building one record into the build directory; same shape as a push result. */
  type BuildResult = PushResult;

  /** The diff manifest `build --diff` writes: the source files that changed. */
  interface DiffFile {
    /** Changed file paths. */
    changed: string[];
  }

  /** A settled task that completed, as `Promise.allSettled` reports it. */
  type SuccessPromiseResult<T> = { status: "fulfilled"; value: T };

  /** A settled task that threw, as `Promise.allSettled` reports it. */
  type FailPromiseResult = { status: "rejected"; reason: any };

  /** Either outcome of a settled task; narrow it on `status`. */
  type PromiseResult<T> = SuccessPromiseResult<T> | FailPromiseResult;

  // === Instance session ==========================================================

  /** The `{ result }` envelope every ServiceNow REST answer is wrapped in. */
  interface SNAPIResponse<T> {
    /** The payload. */
    result: T;
  }

  /** Whether the instance session is in the scope the manifest was made for. */
  interface ScopeCheckResult {
    /** True when both scopes are the same. */
    match: boolean;
    /** Scope recorded in the local manifest. */
    manifestScope: string;
    /** Scope the instance session is currently in. */
    sessionScope: string;
  }

  /** What the `init` wizard asks for to reach an instance. */
  interface LoginAnswers {
    /** Instance host name. */
    instance: string;
    /** User to authenticate as. */
    username: string;
    /** That user's password; kept only in the credential store or `.env`. */
    password: string;
  }

  /** The application the `init` wizard's picker returned. */
  interface AppSelectionAnswer {
    /** Scope of the chosen application. */
    app: string;
  }
}

export namespace SN {
  // === Application manifest =====================================================
  //
  // `sync.manifest.json`: which records of the application are synced, under
  // which local names, and which of their fields are files.

  /** The manifest of one application. */
  interface AppManifest {
    /** Application scope name (e.g. `x_acme_app`). */
    scope: string;
    /**
     * sys_id of the application scope. Optional: manifests written before it
     * existed stay valid, and it is resolved and persisted on first use.
     */
    scopeId?: string;
    /** Synced tables, keyed by table name. */
    tables: TableMap;
  }

  /** Manifest tables keyed by table name. */
  type TableMap = Record<string, TableConfig>;

  /** The manifest entry of one table. */
  interface TableConfig {
    /** Records of the table, keyed by their local name. */
    records: TableConfigRecords;
    /**
     * Columns serialized into each record's `.meta.json` sidecar. Absent when
     * the manifest carries no metadata layer (scoped-endpoint manifests, or
     * `meta: false`), in which case no record lists the sidecar pseudo-file.
     */
    metaFields?: string[];
    /**
     * The subset of `metaFields` the dictionary marks read-only or virtual.
     * Written into the sidecar for reading, never sent back by a push — the
     * Table API would accept and discard them and still answer 200.
     */
    metaReadOnlyFields?: string[];
  }

  /** A table's records keyed by their local (folder) name. */
  type TableConfigRecords = Record<string, MetaRecord>;

  /** One synced record. */
  interface MetaRecord {
    /** Local name of the record (its folder name). */
    name: string;
    /** sys_id of the record. */
    sys_id: string;
    /** The record's fields that are stored as files. */
    files: File[];
  }

  /** One field of a record stored as a local file. */
  interface File {
    /** Column name; the file's base name. */
    name: string;
    /** The file type, which decides the extension. */
    type: FileType;
    /** The field's value, when the answer carried it. */
    content?: string;
  }

  /** The kinds of field file syncrona writes; each is also the file extension. */
  type FileType = "js" | "css" | "xml" | "html" | "scss" | "txt" | "json";

  /** Files a download still has to fetch, keyed by table name. */
  type MissingFileTableMap = Record<string, MissingFileRecord>;

  /** The missing files of one table, keyed by record sys_id. */
  type MissingFileRecord = Record<string, File[]>;

  // === Instance records =========================================================

  /** A scoped application the instance offers for syncing. */
  interface App {
    /** Display name of the application. */
    displayName: string;
    /** Scope name of the application. */
    scope: string;
    /** sys_id of the application. */
    sys_id: string;
  }

  /** The application scope the instance session is in. */
  interface ScopeObj {
    /** Scope name. */
    scope: string;
    /** sys_id of the scope's application. */
    sys_id: string;
  }

  /** A record the CLI only needs to identify by its sys_id. */
  interface RecordRef {
    /** sys_id of the record. */
    sys_id: string;
  }

  /** A `sys_user` row, identified by its sys_id. */
  type UserRecord = RecordRef;

  /** A `sys_user_preference` row, identified by its sys_id. */
  type UserPrefRecord = RecordRef;

  /** A `sys_scope` row, identified by its sys_id. */
  type ScopeRecord = RecordRef;

  /** A `sys_update_set` row, identified by its sys_id. */
  type UpdateSetRecord = RecordRef;

  // --- Fluent tier port (`syncrona fluent <action>`) --------------------------
  //
  // The port between the core CLI and the optional `@syncrona/fluent` adapter,
  // which drives the ServiceNow SDK (`@servicenow/sdk`) orchestrator. Core only
  // ever sees these shapes: it loads the adapter lazily, hands it a credential
  // input, and maps the results to output and an exit code. Nothing here names
  // an SDK type, so core compiles and runs without the SDK installed.

  /** What the SDK's credential resolver accepts: a bearer token or a UI session. */
  type FluentResolvedAuth =
    | { type: "oauth"; token: string; expiresAt?: number }
    | { type: "basic"; token: string; cookie: string; expiresAt?: number };

  /**
   * Called by the SDK whenever it needs (fresh) instance credentials. It may be
   * called more than once in one run: the SDK re-resolves after its cache TTL
   * and after an instance 401.
   */
  interface FluentAuthResolver {
    (): Promise<FluentResolvedAuth>;
  }

  /**
   * TLS settings for the connection to the instance: a mutual-TLS client
   * certificate and key, a CA bundle, and whether the server certificate is
   * verified. Core reads them from the same environment the rest of syncrona
   * uses (`SN_CLIENT_CERT`, `SYNCRONA_CA_BUNDLE`, ...); PEM text or bytes.
   */
  interface FluentTlsOptions {
    cert?: string | Uint8Array;
    key?: string | Uint8Array;
    passphrase?: string;
    ca?: string | Uint8Array;
    rejectUnauthorized: boolean;
  }

  /**
   * The credential core resolved for the active profile, in the form the
   * adapter can bridge. An API-key profile cannot be expressed to the SDK, so
   * it arrives as `unsupported` and the resolver refuses it. Mutual TLS is a
   * transport setting, not an auth method: it rides along as `tls` on a Basic
   * or OAuth input.
   */
  type FluentCredentialInput =
    | { kind: "basic"; username: string; password: string; tls?: FluentTlsOptions }
    | { kind: "oauth"; getToken: () => Promise<string>; tls?: FluentTlsOptions }
    /** A UI session obtained elsewhere: handed to the SDK as is, with no login. */
    | { kind: "session"; token: string; cookie: string; tls?: FluentTlsOptions }
    | { kind: "unsupported"; method: string };

  interface FluentLogger {
    info(message: string): void;
    warn(message: string): void;
    debug(message: string): void;
  }

  interface FluentEngineOptions {
    /** The Fluent project root (the directory holding `now.config.json`). */
    projectDir: string;
    /** `https://<instance>/`; omitted for purely local actions. */
    instanceUrl?: string;
    /** Omitted for purely local actions; the SDK then runs without a credential. */
    auth?: FluentAuthResolver;
    /**
     * TLS settings for every request an engine call makes to the instance
     * (the adapter's UI-session login and the SDK's own requests alike).
     */
    tls?: FluentTlsOptions;
    logger: FluentLogger;
    /**
     * Which engine runs `build`, `pack`, `install` and `installStatus`: `sdk` the
     * ServiceNow SDK, `native` syncrona's own implementation, and `auto` (the
     * default) the SDK when it is installed and the native engine otherwise.
     * Every other action needs the SDK whatever is chosen.
     */
    engine?: FluentEngineChoice;
  }

  type FluentEngineChoice = "auto" | "sdk" | "native";

  interface FluentBuildResult {
    success: boolean;
    errors: string[];
    warnings: string[];
  }

  interface FluentTransformResult {
    changedFiles: string[];
    handledPaths: string[];
  }

  /** Options for `transform`, mapped explicitly onto the SDK's transform modes. */
  type FluentTransformOptions =
    | { mode: "paths"; paths: string[]; tables?: string[]; force?: boolean }
    | { mode: "complete" }
    | { mode: "incremental" }
    | { mode: "update-set"; updateSetId: string };

  /** One topic of the documentation bundled with `@servicenow/sdk` (its `docs` tree of Markdown files). */
  interface FluentDocTopic {
    /** The file's basename without `.md`; unique across the docs tree. */
    name: string;
    tags: string[];
    /** The first paragraph after the first heading. */
    summary: string;
  }

  /**
   * What `explain` found, classified so the CLI can render and exit on it:
   * `list` is the topic index (optionally filtered: strong matches in
   * `topics`, weaker substring matches in `related`); `topic` is the one
   * precise match with its Markdown body; `matches` is several precise matches
   * (or one, with `peek`); `suggestions` is substring matches only; `none`
   * means nothing matched.
   */
  type FluentExplainResult =
    | { kind: "list"; filter?: string; topics: FluentDocTopic[]; related: FluentDocTopic[] }
    | { kind: "topic"; topic: FluentDocTopic; body: string }
    | { kind: "matches"; topics: FluentDocTopic[] }
    | { kind: "suggestions"; topics: FluentDocTopic[] }
    | { kind: "none"; topics: [] };

  interface FluentMoveToAppResult {
    /** False when the instance claimed none of the records, so no transform ran. */
    moved: boolean;
    changedFiles: string[];
    handledPaths: string[];
  }

  interface FluentEngine {
    build(options: {
      frozenKeys?: boolean;
      errorOnConflict?: boolean;
      skipClean?: boolean;
    }): Promise<FluentBuildResult>;
    transform(options: FluentTransformOptions): Promise<FluentTransformResult>;
    pack(options: { packagePath?: string }): Promise<string>;
    install(options: {
      clean?: boolean;
      installAsStoreApp?: boolean;
      installAsync?: boolean;
      demoData?: boolean;
      skipFlowActivation?: boolean;
    }): Promise<{ trackerId?: string; rollbackId?: string }>;
    installStatus(): Promise<{ finished: boolean; id?: string }>;
    types(options: { downloadScripts?: boolean; downloadFluent?: boolean }): Promise<void>;
    addDependency(options: { table: string; ids: string[]; scope: string }): Promise<void>;
    run(options: { script: string; args?: Record<string, unknown> }): Promise<void>;
    createProject(options: {
      name: string;
      scope: string;
      scopeId?: string;
      packageName?: string;
      description?: string;
      templateId?: string;
      projectVersion?: string;
    }): Promise<void>;
    createProjectFromApp(options: { scopeId: string; packageName?: string }): Promise<void>;
    /** Searches the SDK's bundled docs; local, read-only, and never loads the full SDK API. */
    explain(options: { topic?: string; list?: boolean; peek?: boolean }): Promise<FluentExplainResult>;
    /**
     * Claims global records into this global application on the instance
     * (`sys_claim`), then runs an incremental transform that writes them into
     * the project as Fluent sources.
     */
    moveToApp(options: { sysIds: string[] }): Promise<FluentMoveToAppResult>;
    /** The `@servicenow/sdk` version the adapter resolved, when it can tell. */
    sdkVersion(): Promise<string | undefined>;
  }

  /** The shape of the `@syncrona/fluent` module, as core imports it. */
  interface FluentModule {
    createFluentEngine(options: FluentEngineOptions): FluentEngine;
    createFluentAuthResolver(instanceUrl: string, input: FluentCredentialInput): FluentAuthResolver;
  }
}
