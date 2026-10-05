export namespace Sync {
  interface SharedCmdArgs {
    logLevel: string;
    dryRun?: boolean;
    instanceProfile?: string;
    ci?: boolean;
  }

  interface CmdDownloadArgs extends SharedCmdArgs {
    scope: string;
  }
  interface PushCmdArgs extends SharedCmdArgs {
    target?: string;
    diff: string;
    scopeSwap: boolean;
    updateSet: string;
    ci: boolean;
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
  interface BuildCmdArgs extends SharedCmdArgs {
    diff: string;
    checkConfig?: boolean;
  }
  interface Config {
    sourceDirectory: string;
    buildDirectory: string;
    pushConcurrency?: number;
    rules?: PluginRule[];
    includes?: TablePropMap;
    excludes?: TablePropMap;
    tableOptions: ITableOptionsMap;
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
  }

  interface ITableOptionsMap {
    [table: string]: ITableOptions;
  }

  interface ITableOptions {
    displayField?: string;
    differentiatorField?: string | string[];
    query: string;
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

  interface FieldConfig {
    type: SN.FileType;
  }
  interface FieldMap {
    [fieldName: string]: FieldConfig;
  }
  interface TablePropMap {
    [table: string]: boolean | FieldMap;
  }
  interface PluginRule {
    match: RegExp;
    plugins: PluginConfig[];
  }
  interface PluginConfig {
    name: string;
    options: { [property: string]: any };
  }
  interface FileSyncParams {
    filePath: string;
    name: string;
    tableName: string;
    targetField: string;
    ext: string;
  }

  interface FileContext extends FileSyncParams {
    sys_id: string;
    scope: string;
    fileContents?: string;
  }

  interface ServerRequestConfig {
    url: string;
    data: string;
    method: string;
  }

  interface Plugin {
    run: PluginFunc;
  }

  interface PluginFunc {
    (
      context: FileContext,
      content: string,
      options: any
    ): Promise<PluginResults>;
  }

  interface PluginResults {
    success: boolean;
    output: string;
  }

  type TransformResults = {
    success: boolean;
    content: string;
  };

  interface ScopeCheckResult {
    manifestScope: string;
    sessionScope: string;
    match: boolean;
  }
  interface LoginAnswers {
    instance: string;
    username: string;
    password: string;
  }

  interface AppSelectionAnswer {
    app: string;
  }

  interface DiffFile {
    changed: Array<string>;
  }

  type RecordContextMap = Record<string, FileContext>;
  type TableContextTree = Record<string, RecordContextMap>;
  type AppFileContextTree = Record<string, TableContextTree>;

  interface PushResult {
    success: boolean;
    message: string;
  }

  interface BuildResult extends PushResult {}

  interface BuildRecord {
    result: Sync.PromiseResult<Record<string, string>>;
    summary: string;
    context: Sync.FileContext;
  }

  type SuccessPromiseResult<T> = { status: "fulfilled"; value: T };
  type FailPromiseResult = { status: "rejected"; reason: any };
  type PromiseResult<T> = SuccessPromiseResult<T> | FailPromiseResult;

  interface SNAPIResponse<T> {
    result: T;
  }

  interface BuildableRecord {
    table: string;
    sysId: string;
    fields: Record<string, Sync.FileContext>;
  }

  interface RecBuildFail {
    success: false;
    message: string;
  }

  interface RecBuildSuccess {
    success: true;
    builtRec: Record<string, string>;
  }

  type RecBuildRes = RecBuildFail | RecBuildSuccess;
}

export namespace SN {
  interface AppManifest {
    tables: TableMap;
    scope: string;
    /**
     * sys_id of the application scope. Optional: manifests written before it
     * existed stay valid, and it is resolved and persisted on first use.
     */
    scopeId?: string;
  }

  interface TableMap {
    [tableName: string]: TableConfig;
  }

  interface TableConfig {
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

  interface TableConfigRecords {
    [name: string]: MetaRecord;
  }

  interface MetaRecord {
    files: File[];
    name: string;
    sys_id: string;
  }

  interface File {
    name: string;
    type: FileType;
    content?: string;
  }

  interface Field {
    name: string;
    type: string;
  }

  interface Record {
    sys_id: string;
  }

  interface TableAPIResult {
    result: Record[];
  }

  type FileType = "js" | "css" | "xml" | "html" | "scss" | "txt" | "json";

  interface TypeMap {
    [type: string]: string;
  }

  interface MissingFileTableMap {
    [tableName: string]: MissingFileRecord;
  }
  interface MissingFileRecord {
    [sys_id: string]: File[];
  }
  interface ScopeObj {
    scope: string;
    sys_id: string;
  }
  interface App {
    scope: string;
    displayName: string;
    sys_id: string;
  }

  interface UserRecord {
    sys_id: string;
  }

  interface UserPrefRecord {
    sys_id: string;
  }

  interface ScopeRecord {
    sys_id: string;
  }

  interface UpdateSetRecord {
    sys_id: string;
  }

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
   * The credential core resolved for the active profile, in the form the
   * adapter can bridge. API-key and mutual-TLS profiles cannot be expressed to
   * the SDK, so they arrive as `unsupported` and the resolver refuses them.
   */
  type FluentCredentialInput =
    | { kind: "basic"; username: string; password: string }
    | { kind: "oauth"; getToken: () => Promise<string> }
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
    logger: FluentLogger;
  }

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

export type TSFIXME = any;
