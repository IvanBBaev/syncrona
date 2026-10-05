// SPDX-License-Identifier: GPL-3.0-or-later
//
// R4, create half: `push --create` for data-model records.
//
// A data-model record is often represented by its sidecar alone, on a table the
// manifest has never described, and it is frequently named by several columns
// (a dictionary entry is `<name>.<element>`). These tests pin the create path
// for that shape: the always-denied tables, the column discovery that lets a
// sidecar-only record be created on a table without metaFields, and the
// composite idempotency lookup that keeps a retry from creating a duplicate.
import { jest } from "@jest/globals";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export {};

const mockGetConfig = jest.fn();
const mockGetManifest = jest.fn();
const mockUpdateManifest = jest.fn();
const mockDiscover = jest.fn();
const getFinalFileContents = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  getManifest: (...args: unknown[]) => mockGetManifest(...args),
  updateManifest: (...args: unknown[]) => mockUpdateManifest(...args),
}));

jest.unstable_mockModule("../FileUtils.js", () => ({
  writeManifestFile: jest.fn(),
  getFileContextFromPath: jest.fn(),
  parseUnmappedPath: jest.fn(),
  encodedPathsToFilePaths: jest.fn(),
}));

jest.unstable_mockModule("../PluginManager.js", () => ({
  default: {
    getFinalFileContents: (...args: unknown[]) => getFinalFileContents(...args),
  },
}));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  discoverTableMetaFields: (...args: unknown[]) => mockDiscover(...args),
}));
// pushPipeline reads findMissingFiles for `--prune`; stubbing the module keeps the
// real downloadPipeline (and its wider manifestBuilder import) out of this suite.
jest.unstable_mockModule("../downloadPipeline.js", () => ({
  findMissingFiles: jest.fn(async () => ({})),
}));

type Resp = Promise<{ data: { result: unknown } }>;
jest.unstable_mockModule("../snClient.js", () => ({
  defaultClient: () => {
    throw new Error("tests must pass an explicit client");
  },
  retryOnErr: (task: () => unknown) => task(),
  processPushResponse: (_res: unknown, summary: string) => ({
    success: true,
    message: `${summary} pushed`,
  }),
  getErrorResponseStatus: () => undefined,
  isRetryableRequestError: (e: unknown) => {
    const status = (e as { response?: { status?: number } })?.response?.status;
    return status === undefined || status >= 500;
  },
  SNClient: jest.fn(),
  resolveCredentials: jest.fn(),
  unwrapSNResponse: async (p: Resp) => (await p).data.result,
  unwrapTableAPIFirstItem: async (p: Resp, key: string) =>
    ((await p).data.result as Record<string, unknown>[])[0]?.[key],
  unwrapTableAPIFirstItemOrEmpty: jest.fn(),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
    silly: jest.fn(),
  },
}));

jest.unstable_mockModule("../progress.js", () => ({
  getProgTick: () => undefined,
}));

let Pipeline: typeof import("../pushPipeline.js");

const ok = (result: unknown) => Promise.resolve({ data: { result } });

const HIERARCHY: Record<string, string> = {
  sys_dictionary: "sys_metadata",
  sys_db_object: "sys_metadata",
  sys_choice: "sys_metadata",
  x_demo_rule: "sys_metadata",
};

const makeClient = () => {
  // Rows a composite lookup (`col=val^...^sys_scope=...`) answers with.
  const lookupHits: { sys_id: string }[][] = [];
  const tableAPIGet = jest.fn((table: string, query: string) => {
    if (table === "sys_db_object" && query.startsWith("name=")) {
      const name = query.slice("name=".length);
      return name in HIERARCHY ? ok([{ name, "super_class.name": HIERARCHY[name] }]) : ok([]);
    }
    if (query.includes("^sys_scope=")) return ok(lookupHits.shift() ?? []);
    return ok([]);
  });
  const getScopeId = jest.fn((_scope: string) => ok([{ sys_id: "scope-1" }]));
  const findRecordByName = jest.fn(
    async (_t: string, _f: string, _n: string, _s: string): Promise<string[]> => []
  );
  const createRecord = jest.fn(
    async (_t: string, _b: Record<string, string>): Promise<{ sys_id: string }> => ({
      sys_id: "new-1",
    })
  );
  return { tableAPIGet, getScopeId, findRecordByName, createRecord, lookupHits };
};
type FakeClient = ReturnType<typeof makeClient>;
const asClient = (c: FakeClient) => c as unknown as import("../snClient.js").SNClient;

let tmpDir: string;

/** A sidecar-only candidate whose .meta.json really exists on disk. */
const sidecarCandidate = (
  table: string,
  recordName: string,
  content: unknown
): import("../pushPipeline.js").CreateCandidate => {
  const dir = path.join(tmpDir, table, recordName);
  fs.mkdirSync(dir, { recursive: true });
  const filePath = path.join(dir, ".meta.json");
  fs.writeFileSync(filePath, typeof content === "string" ? content : JSON.stringify(content));
  return {
    table,
    recordName,
    files: [{ filePath, field: ".meta", ext: ".json", isSidecar: true }],
  };
};

const DICTIONARY_ROW = {
  name: "x_demo_task",
  element: "u_foo",
  column_label: "Foo",
  internal_type: "string",
  max_length: "40",
};
const DICTIONARY_COLUMNS = ["column_label", "element", "internal_type", "max_length", "name"];

let manifest: Record<string, unknown>;

beforeAll(async () => {
  Pipeline = await import("../pushPipeline.js");
});

beforeEach(() => {
  jest.clearAllMocks();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-dm-create-"));
  manifest = { scope: "x_demo", scopeId: "scope-1", tables: {} };
  mockGetManifest.mockImplementation(() => manifest);
  mockUpdateManifest.mockImplementation((next: unknown) => {
    manifest = next as Record<string, unknown>;
  });
  mockGetConfig.mockReturnValue({
    pushConcurrency: 1,
    dataModelTables: ["sys_dictionary", "sys_db_object", "sys_properties", "sys_user_role"],
  });
  getFinalFileContents.mockImplementation(async (context: unknown) =>
    fs.readFileSync((context as { filePath: string }).filePath, "utf8")
  );
  mockDiscover.mockImplementation(async () => ({
    fields: DICTIONARY_COLUMNS,
    readOnly: ["sys_updated_on"],
  }));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const planFor = (client: FakeClient, cands: import("../pushPipeline.js").CreateCandidate[]) =>
  Pipeline.planRecordCreation(cands, { persistScopeId: false, client: asClient(client) });

describe("push --create for data-model records (R4)", () => {
  it("keeps create denied for sys_properties and sys_user_role, without a request", async () => {
    const client = makeClient();
    const plan = await planFor(client, [
      sidecarCandidate("sys_properties", "x_demo.flag", { name: "x_demo.flag", value: "true" }),
      sidecarCandidate("sys_user_role", "x_demo.admin", { name: "x_demo.admin" }),
    ]);
    expect(plan.plans.map((p) => p.action)).toEqual(["error", "error"]);
    for (const p of plan.plans) expect(p.message).toMatch(/denied|not allowed|never/i);
    expect(client.tableAPIGet).not.toHaveBeenCalled();
    expect(client.findRecordByName).not.toHaveBeenCalled();
    const outcome = await Pipeline.createRecords(plan, { client: asClient(client) });
    expect(outcome.results.every((r) => !r.success)).toBe(true);
    expect(client.createRecord).not.toHaveBeenCalled();
  });

  it("matches a composite-named record by its naming columns and the scope", async () => {
    const client = makeClient();
    const plan = await planFor(client, [
      sidecarCandidate("sys_dictionary", "x_demo_task.u_foo", DICTIONARY_ROW),
    ]);
    expect(plan.plans[0].action).toBe("create");
    expect(plan.plans[0].lookup).toEqual({ name: "x_demo_task", element: "u_foo" });
    expect(client.findRecordByName).not.toHaveBeenCalled();
    expect(client.tableAPIGet).toHaveBeenCalledWith(
      "sys_dictionary",
      "name=x_demo_task^element=u_foo^sys_scope=scope-1",
      "sys_id",
      2
    );
  });

  // Closes the WP-1 limitation: a sidecar-only record on a table with no
  // metaFields used to fail on the degraded-manifest check.
  it("creates a sidecar-only record on a table the manifest lacks, and keeps the discovered columns", async () => {
    const client = makeClient();
    const plan = await planFor(client, [
      sidecarCandidate("sys_dictionary", "x_demo_task.u_foo", DICTIONARY_ROW),
    ]);
    const outcome = await Pipeline.createRecords(plan, { client: asClient(client), retryWaitMs: 0 });

    expect(outcome.results).toEqual([
      { success: true, message: "sys_dictionary > x_demo_task.u_foo : created (new-1)." },
    ]);
    expect(mockDiscover).toHaveBeenCalledTimes(1);
    expect(mockDiscover.mock.calls[0][1]).toBe("sys_dictionary");
    const [table, body] = client.createRecord.mock.calls[0];
    expect(table).toBe("sys_dictionary");
    // The sidecar carries the naming columns; no synthetic display-name column.
    expect(body).toEqual({ ...DICTIONARY_ROW, sys_scope: "scope-1" });
    const tables = manifest.tables as Record<string, Record<string, unknown>>;
    expect(tables.sys_dictionary.metaFields).toEqual(DICTIONARY_COLUMNS);
    expect(tables.sys_dictionary.metaReadOnlyFields).toEqual(["sys_updated_on"]);
    expect((tables.sys_dictionary.records as Record<string, unknown>)["x_demo_task.u_foo"]).toEqual({
      name: "x_demo_task.u_foo",
      sys_id: "new-1",
      files: [{ name: ".meta", type: "json" }],
    });
  });

  it("creates a single-name data-model record with its display column", async () => {
    const client = makeClient();
    mockDiscover.mockImplementation(async () => ({ fields: ["label", "name"], readOnly: [] }));
    const plan = await planFor(client, [
      sidecarCandidate("sys_db_object", "x_demo_task", { name: "x_demo_task", label: "Task" }),
    ]);
    expect(plan.plans[0].lookup).toBeUndefined();
    const outcome = await Pipeline.createRecords(plan, { client: asClient(client), retryWaitMs: 0 });
    expect(outcome.results[0].success).toBe(true);
    expect(client.createRecord.mock.calls[0][1]).toMatchObject({
      name: "x_demo_task",
      label: "Task",
      sys_scope: "scope-1",
    });
    const tables = manifest.tables as Record<string, Record<string, unknown>>;
    expect(tables.sys_db_object.metaFields).toEqual(["label", "name"]);
    expect(tables.sys_db_object.metaReadOnlyFields).toBeUndefined();
  });

  it("uses the manifest's own columns, without discovery, when the table is known", async () => {
    manifest.tables = { sys_dictionary: { metaFields: DICTIONARY_COLUMNS, records: {} } };
    const client = makeClient();
    const plan = await planFor(client, [
      sidecarCandidate("sys_dictionary", "x_demo_task.u_foo", DICTIONARY_ROW),
    ]);
    const outcome = await Pipeline.createRecords(plan, { client: asClient(client), retryWaitMs: 0 });
    expect(outcome.results[0].success).toBe(true);
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it("discovers columns for a documented data-model table even when it is not opted in", async () => {
    mockGetConfig.mockReturnValue({ pushConcurrency: 1, dataModelTables: [] });
    mockDiscover.mockImplementation(async () => ({ fields: ["label", "name"], readOnly: [] }));
    const client = makeClient();
    const plan = await planFor(client, [
      sidecarCandidate("sys_db_object", "x_demo_task", { name: "x_demo_task" }),
    ]);
    const outcome = await Pipeline.createRecords(plan, { client: asClient(client), retryWaitMs: 0 });
    expect(mockDiscover).toHaveBeenCalledTimes(1);
    expect(outcome.results[0].success).toBe(true);
  });

  it("does not discover columns under metaPush: false", async () => {
    mockGetConfig.mockReturnValue({
      pushConcurrency: 1,
      dataModelTables: ["sys_db_object"],
      metaPush: false,
    });
    const client = makeClient();
    const plan = await planFor(client, [
      sidecarCandidate("sys_db_object", "x_demo_task", { name: "x_demo_task" }),
    ]);
    await Pipeline.createRecords(plan, { client: asClient(client), retryWaitMs: 0 });
    expect(mockDiscover).not.toHaveBeenCalled();
  });

  it("fails the record, posting nothing, when the dictionary yields no columns", async () => {
    mockDiscover.mockImplementation(async () => ({ fields: [], readOnly: [] }));
    const client = makeClient();
    const plan = await planFor(client, [
      sidecarCandidate("sys_dictionary", "x_demo_task.u_foo", DICTIONARY_ROW),
    ]);
    const outcome = await Pipeline.createRecords(plan, { client: asClient(client) });
    expect(outcome.results[0].success).toBe(false);
    expect(outcome.results[0].message).toMatch(/could not read the columns of sys_dictionary/);
    expect(client.createRecord).not.toHaveBeenCalled();
  });

  it("adopts the one record the composite lookup finds", async () => {
    const client = makeClient();
    client.lookupHits.push([{ sys_id: "ex-1" }]);
    const plan = await planFor(client, [
      sidecarCandidate("sys_dictionary", "x_demo_task.u_foo", DICTIONARY_ROW),
    ]);
    expect(plan.plans[0]).toMatchObject({ action: "adopt", sysId: "ex-1" });
  });

  it("refuses to guess between several matches, naming the columns", async () => {
    const client = makeClient();
    client.lookupHits.push([{ sys_id: "a" }, { sys_id: "b" }]);
    const plan = await planFor(client, [
      sidecarCandidate("sys_dictionary", "x_demo_task.u_foo", DICTIONARY_ROW),
    ]);
    expect(plan.plans[0].action).toBe("error");
    expect(plan.plans[0].message).toContain(
      "more than one sys_dictionary record with name=x_demo_task, element=u_foo exists"
    );
  });

  it.each([
    ["a naming column is empty", { ...DICTIONARY_ROW, element: "" }, /missing: element/],
    ["a naming column is absent", { name: "x_demo_task" }, /missing: element/],
    ["the sidecar is not an object", ["x"], /must be a JSON object/],
    ["the sidecar is not JSON", "{ nope", /could not read/],
  ])("refuses a composite create when %s", async (_label, content, message) => {
    const client = makeClient();
    const plan = await planFor(client, [
      sidecarCandidate("sys_dictionary", "x_demo_task.u_foo", content),
    ]);
    expect(plan.plans[0].action).toBe("error");
    expect(plan.plans[0].message).toMatch(message);
    expect(client.tableAPIGet).not.toHaveBeenCalled();
  });

  it("accepts number and boolean naming values", async () => {
    const client = makeClient();
    const plan = await planFor(client, [
      sidecarCandidate("sys_dictionary", "x_demo_task.1", { name: "x_demo_task", element: 1 }),
    ]);
    expect(plan.plans[0].lookup).toEqual({ name: "x_demo_task", element: "1" });
  });

  it("refuses a composite create without a sidecar", async () => {
    const client = makeClient();
    const plan = await planFor(client, [
      {
        table: "sys_dictionary",
        recordName: "x_demo_task.u_foo",
        files: [
          { filePath: "/p/calculation.js", field: "calculation", ext: ".js", isSidecar: false },
        ],
      },
    ]);
    expect(plan.plans[0].message).toMatch(/must be set in its \.meta\.json sidecar\.$/);
  });

  it("looks up by the naming columns before retrying a failed POST", async () => {
    const client = makeClient();
    const plan = await planFor(client, [
      sidecarCandidate("sys_dictionary", "x_demo_task.u_foo", DICTIONARY_ROW),
    ]);
    client.createRecord.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    client.lookupHits.push([{ sys_id: "late-1" }]);
    const outcome = await Pipeline.createRecords(plan, { client: asClient(client), retryWaitMs: 0 });
    expect(client.createRecord).toHaveBeenCalledTimes(1);
    expect(client.findRecordByName).not.toHaveBeenCalled();
    expect(outcome.results[0].message).toContain("created (late-1)");
  });

  it("fails on an ambiguous composite lookup after a failed POST", async () => {
    const client = makeClient();
    const plan = await planFor(client, [
      sidecarCandidate("sys_dictionary", "x_demo_task.u_foo", DICTIONARY_ROW),
    ]);
    client.createRecord.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    client.lookupHits.push([{ sys_id: "a" }, { sys_id: "b" }]);
    const outcome = await Pipeline.createRecords(plan, { client: asClient(client), retryWaitMs: 0 });
    expect(outcome.results[0].success).toBe(false);
    expect(outcome.results[0].message).toContain(
      "more than one sys_dictionary record with name=x_demo_task, element=u_foo exists after a failed create."
    );
  });

  it("keeps an operator's displayField over the composite rule", async () => {
    mockGetConfig.mockReturnValue({
      pushConcurrency: 1,
      dataModelTables: ["sys_dictionary"],
      tableOptions: { sys_dictionary: { query: "", displayField: "column_label" } },
    });
    const client = makeClient();
    const plan = await planFor(client, [
      sidecarCandidate("sys_dictionary", "Foo", DICTIONARY_ROW),
    ]);
    expect(plan.plans[0].lookup).toBeUndefined();
    expect(client.findRecordByName).toHaveBeenCalledWith(
      "sys_dictionary",
      "column_label",
      "Foo",
      "scope-1"
    );
  });

  it("does not discover columns for a table that is not a data-model table", async () => {
    mockGetConfig.mockReturnValue({ pushConcurrency: 1, dataModelTables: [] });
    const client = makeClient();
    const plan = await planFor(client, [
      sidecarCandidate("x_demo_rule", "Rule", { name: "Rule" }),
    ]);
    const outcome = await Pipeline.createRecords(plan, { client: asClient(client) });
    expect(mockDiscover).not.toHaveBeenCalled();
    // Without metaFields the sidecar still fails as before.
    expect(outcome.results[0].success).toBe(false);
  });
});
