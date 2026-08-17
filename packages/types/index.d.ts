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
}

export type TSFIXME = any;
