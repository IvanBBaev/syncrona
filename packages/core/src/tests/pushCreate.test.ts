// SPDX-License-Identifier: GPL-3.0-or-later
//
// R1, `push --create`: records for local files the manifest does not know yet.
//
// These tests pin the acceptance tests AT-R1-1..6 at the pipeline level: create
// vs adopt vs refuse, the table policy (deny list, allowlist, sys_metadata
// hierarchy), the read-only plan a dry run relies on, the lookup-before-retry
// that keeps a timed-out POST from duplicating a record, and the manifest
// writes. Every request goes to a hand-rolled client; nothing leaves the process.
import { jest } from "@jest/globals";
import { Sync } from "@syncrona/types";
export {};

const mockGetConfig = jest.fn();
const mockGetManifest = jest.fn();
const mockUpdateManifest = jest.fn();
const mockWriteManifestFile = jest.fn();
const mockGetFileContextFromPath = jest.fn();
const mockParseUnmappedPath = jest.fn();
const mockEncodedPathsToFilePaths = jest.fn();
const getFinalFileContents = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerInfo = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  getManifest: (...args: unknown[]) => mockGetManifest(...args),
  updateManifest: (...args: unknown[]) => mockUpdateManifest(...args),
}));

jest.unstable_mockModule("../FileUtils.js", () => ({
  writeManifestFile: (...args: unknown[]) => mockWriteManifestFile(...args),
  getFileContextFromPath: (...args: unknown[]) => mockGetFileContextFromPath(...args),
  parseUnmappedPath: (...args: unknown[]) => mockParseUnmappedPath(...args),
  encodedPathsToFilePaths: (...args: unknown[]) => mockEncodedPathsToFilePaths(...args),
}));

jest.unstable_mockModule("../PluginManager.js", () => ({
  default: {
    getFinalFileContents: (...args: unknown[]) => getFinalFileContents(...args),
  },
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
  // Mirrors the real policy: no HTTP status (a timeout, a reset) or a 5xx retries.
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
    warn: (...a: unknown[]) => mockLoggerWarn(...a),
    info: (...a: unknown[]) => mockLoggerInfo(...a),
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

// sys_db_object as a tiny in-memory hierarchy.
const HIERARCHY: Record<string, string> = {
  sys_script_include: "sys_metadata",
  sys_script: "sys_metadata",
  sys_ui_script: "sys_metadata",
  incident: "task",
  task: "",
  loop_a: "loop_b",
  loop_b: "loop_a",
};

const makeClient = () => {
  // The idempotency lookup goes through tableAPIGet as `<field>=<value>^sys_scope=<id>`;
  // nameLookup answers it with sys_ids, and each row carries the looked-up column
  // back the way the instance does.
  const nameLookup = jest.fn(
    async (_t: string, _f: string, _n: string, _s: string): Promise<string[]> => []
  );
  const tableAPIGet = jest.fn(async (table: string, query: string, _fields?: string) => {
    if (table !== "sys_db_object") {
      const m = /^([^=^]+)=([^^]*)\^sys_scope=(.*)$/.exec(query);
      if (!m) return { data: { result: [] as unknown } };
      const [, field, value, scope] = m;
      const sysIds = await nameLookup(table, field, value, scope);
      return { data: { result: sysIds.map((sys_id) => ({ sys_id, [field]: value })) as unknown } };
    }
    const name = query.replace(/^name=/, "");
    return name in HIERARCHY
      ? ok([{ name, "super_class.name": HIERARCHY[name] }])
      : ok([]);
  });
  const getScopeId = jest.fn((_scope: string) => ok([{ sys_id: "scope-1" }]));
  const createRecord = jest.fn(
    async (_t: string, _b: Record<string, string>): Promise<{ sys_id: string }> => ({
      sys_id: "new-1",
    })
  );
  const getRecordScope = jest.fn(
    async (
      _t: string,
      sysId: string
    ): Promise<{ sys_id: string; sys_scope: string } | undefined> => ({
      sys_id: sysId,
      sys_scope: "scope-1",
    })
  );
  return { tableAPIGet, getScopeId, nameLookup, createRecord, getRecordScope };
};
type FakeClient = ReturnType<typeof makeClient>;
const asClient = (c: FakeClient) =>
  c as unknown as import("../snClient.js").SNClient;

const candidate = (
  table: string,
  recordName: string,
  files: Partial<import("../pushPipeline.js").CreateCandidateFile>[] = [{}]
): import("../pushPipeline.js").CreateCandidate => ({
  table,
  recordName,
  files: files.map((file) => ({
    filePath: `/proj/src/${table}/${recordName}/script.js`,
    field: "script",
    ext: ".js",
    isSidecar: false,
    ...file,
  })),
});

let manifest: Record<string, unknown>;
const ENV = "SYNCRONA_CREATE_TABLE_ALLOWLIST";
let savedEnv: string | undefined;

beforeAll(async () => {
  Pipeline = await import("../pushPipeline.js");
});

beforeEach(() => {
  jest.clearAllMocks();
  savedEnv = process.env[ENV];
  delete process.env[ENV];
  manifest = { scope: "x_demo", tables: {} };
  mockGetManifest.mockImplementation(() => manifest);
  mockUpdateManifest.mockImplementation((next: unknown) => {
    manifest = next as Record<string, unknown>;
  });
  mockGetConfig.mockReturnValue({ pushConcurrency: 1 });
  getFinalFileContents.mockImplementation(async () => "gs.info('new');");
});

afterEach(() => {
  if (savedEnv === undefined) delete process.env[ENV];
  else process.env[ENV] = savedEnv;
});

describe("getAppFileListWithCandidates", () => {
  const known: Sync.FileContext = {
    filePath: "/proj/src/sys_script/Known/script.js",
    name: "Known",
    tableName: "sys_script",
    targetField: "script",
    ext: ".js",
    sys_id: "k-1",
    scope: "x_demo",
  };

  beforeEach(() => {
    mockGetFileContextFromPath.mockImplementation((p: unknown) =>
      p === known.filePath ? known : undefined
    );
    mockParseUnmappedPath.mockImplementation((p: unknown) => {
      const m = /\/src\/([^/]+)\/([^/]+)\/([^/.]+)(\.[a-z]+)$/.exec(String(p));
      return m ? { table: m[1], recordName: m[2], field: m[3], ext: m[4], isSidecar: false } : undefined;
    });
  });

  it("groups unmapped paths per record and keeps known records as records", async () => {
    const out = await Pipeline.getAppFileListWithCandidates(
      [
        known.filePath,
        "/proj/src/sys_script_include/New/script.js",
        "/proj/src/sys_script_include/New/script.js",
        "/proj/src/sys_script_include/New/client.js",
        "/proj/src/README",
      ],
      { create: true }
    );
    expect(out.records).toHaveLength(1);
    expect(out.candidates).toHaveLength(1);
    expect(out.candidates[0].files.map((f) => f.field)).toEqual(["script", "client"]);
    expect(out.candidates[0].conflict).toBeUndefined();
    expect(mockLoggerWarn.mock.calls[0][0]).toContain("push --create");
  });

  it("marks a record whose field is claimed by two files as a conflict", async () => {
    mockParseUnmappedPath.mockImplementation((p: unknown) => ({
      table: "sys_script_include",
      recordName: "New",
      field: "script",
      ext: String(p).endsWith(".ts") ? ".ts" : ".js",
      isSidecar: false,
    }));
    const out = await Pipeline.getAppFileListWithCandidates(
      ["/proj/src/sys_script_include/New/script.js", "/proj/src/sys_script_include/New/script.ts"],
      { create: true }
    );
    expect(out.candidates[0].conflict).toContain('field "script"');
  });

  it("never parses unmapped paths without create, and resolves encoded paths", async () => {
    mockEncodedPathsToFilePaths.mockImplementation(async () => [
      "/proj/src/sys_script_include/New/script.js",
    ]);
    const out = await Pipeline.getAppFileListWithCandidates("encoded", { create: false });
    expect(out.candidates).toEqual([]);
    expect(mockParseUnmappedPath).not.toHaveBeenCalled();
    expect(mockLoggerWarn.mock.calls[0][0]).not.toContain("push --create");
    await expect(Pipeline.getAppFileList("encoded")).resolves.toEqual([]);
  });
});

describe("manifestTypeForExt", () => {
  it.each([
    [".js", false, "js"],
    [".HTML", false, "html"],
    [".ts", false, "js"],
    [".mjs", false, "js"],
    [".md", false, "txt"],
    [".json", true, "json"],
  ])("%s (sidecar %s) -> %s", (ext, sidecar, type) => {
    expect(Pipeline.manifestTypeForExt(ext, sidecar)).toBe(type);
  });
});

describe("table policy", () => {
  it("allows a sys_metadata descendant and caches the walk", async () => {
    const client = makeClient();
    const cache = new Map<string, boolean>();
    await expect(
      Pipeline.checkCreateTablePolicy(asClient(client), "sys_script_include", cache)
    ).resolves.toEqual({ allowed: true });
    await Pipeline.checkCreateTablePolicy(asClient(client), "sys_script_include", cache);
    expect(client.tableAPIGet).toHaveBeenCalledTimes(1);
    expect(client.tableAPIGet).toHaveBeenCalledWith(
      "sys_db_object",
      "name=sys_script_include",
      "name,super_class.name",
      1
    );
  });

  // AT-R1-4: a denied table is refused before any request.
  it("refuses a denied table without a network call, even when allowlisted", async () => {
    process.env[ENV] = "sys_user";
    mockGetConfig.mockReturnValue({ createTables: ["sys_user"] });
    const client = makeClient();
    const res = await Pipeline.checkCreateTablePolicy(asClient(client), "sys_user");
    expect(res.allowed).toBe(false);
    expect(client.tableAPIGet).not.toHaveBeenCalled();
  });

  // AT-R1-5: a table outside sys_metadata is refused unless allowlisted.
  it("refuses a table that does not extend sys_metadata", async () => {
    const client = makeClient();
    const res = await Pipeline.checkCreateTablePolicy(asClient(client), "incident");
    expect(res).toMatchObject({ allowed: false });
    expect((res as { reason: string }).reason).toContain("createTables");
  });

  it("allows a table listed under createTables or in the environment without a walk", async () => {
    const client = makeClient();
    mockGetConfig.mockReturnValue({ createTables: ["incident"] });
    await expect(Pipeline.checkCreateTablePolicy(asClient(client), "incident")).resolves.toEqual({
      allowed: true,
    });
    mockGetConfig.mockReturnValue({});
    process.env[ENV] = "u_custom";
    await expect(Pipeline.checkCreateTablePolicy(asClient(client), "u_custom")).resolves.toEqual({
      allowed: true,
    });
    expect(client.tableAPIGet).not.toHaveBeenCalled();
  });

  it("stops on sys_metadata itself, an unknown table and a cyclic hierarchy", async () => {
    const client = makeClient();
    await expect(Pipeline.extendsSysMetadata(asClient(client), "sys_metadata")).resolves.toBe(false);
    await expect(Pipeline.extendsSysMetadata(asClient(client), "u_missing")).resolves.toBe(false);
    await expect(Pipeline.extendsSysMetadata(asClient(client), "loop_a")).resolves.toBe(false);
  });

  // A reply without a result list says nothing about the table; reading it as
  // "outside sys_metadata" let an allowlisted table be planned as a create.
  it("refuses to judge a table from a non-array sys_db_object answer", async () => {
    const client = makeClient();
    client.tableAPIGet.mockImplementation(() => ok({}));
    await expect(Pipeline.extendsSysMetadata(asClient(client), "x")).rejects.toThrow(
      'sys_db_object answered without a result list for table "x"'
    );
  });

  // A result list whose first entry is not a record carries no super_class
  // either; reading it as "no parent" is the same decision on no evidence.
  it.each<[string, unknown[]]>([
    ["null", [null]],
    ["a number", [1]],
    ["a string", ["x"]],
    ["a nested array", [[]]],
  ])("refuses to judge a table from a first row that is %s", async (_label, result) => {
    const client = makeClient();
    client.tableAPIGet.mockImplementation(() => ok(result));
    await expect(Pipeline.extendsSysMetadata(asClient(client), "x")).rejects.toThrow(
      'sys_db_object answered with a result that is not a record for table "x"'
    );
  });

  // A record that does not carry this table's super_class as a string, or names
  // another table, is not the hierarchy asked for; a real root table answers
  // `"super_class.name": ""`.
  it.each<[string, unknown[]]>([
    ["an empty record", [{}]],
    ["a record without super_class.name", [{ name: "x" }]],
    ["a numeric super_class.name", [{ name: "x", "super_class.name": 5 }]],
    ["a null super_class.name", [{ name: "x", "super_class.name": null }]],
    ["an object super_class.name", [{ name: "x", "super_class.name": { value: "sys_metadata" } }]],
    ["another table's record", [{ name: "y", "super_class.name": "" }]],
  ])("refuses to judge a table from %s", async (_label, result) => {
    const client = makeClient();
    client.tableAPIGet.mockImplementation(() => ok(result));
    await expect(Pipeline.extendsSysMetadata(asClient(client), "x")).rejects.toThrow(
      'sys_db_object answered with a record that does not describe table "x"'
    );
  });

  it("reads an empty super_class.name as a root table, with or without the name field", async () => {
    const client = makeClient();
    client.tableAPIGet.mockImplementation(() => ok([{ name: "x", "super_class.name": "" }]));
    await expect(Pipeline.extendsSysMetadata(asClient(client), "x")).resolves.toBe(false);
    client.tableAPIGet.mockImplementation(() => ok([{ "super_class.name": "" }]));
    await expect(Pipeline.extendsSysMetadata(asClient(client), "x")).resolves.toBe(false);
  });

  it("still reads an empty result list as a table without a parent", async () => {
    const client = makeClient();
    client.tableAPIGet.mockImplementation(() => ok([]));
    const missing = new Set<string>();
    await expect(Pipeline.extendsSysMetadata(asClient(client), "x", new Map(), missing)).resolves.toBe(false);
    expect([...missing]).toEqual(["x"]);
  });
});

describe("resolveScopeId", () => {
  it("uses the manifest scopeId without a request", async () => {
    manifest.scopeId = "cached";
    const client = makeClient();
    await expect(Pipeline.resolveScopeId(asClient(client), true)).resolves.toBe("cached");
    expect(client.getScopeId).not.toHaveBeenCalled();
  });

  it("persists a looked-up scopeId only when asked", async () => {
    const client = makeClient();
    await expect(Pipeline.resolveScopeId(asClient(client), false)).resolves.toBe("scope-1");
    expect(mockWriteManifestFile).not.toHaveBeenCalled();
    await Pipeline.resolveScopeId(asClient(client), true);
    expect(manifest.scopeId).toBe("scope-1");
    expect(mockWriteManifestFile).toHaveBeenCalledTimes(1);
  });

  it("throws when the scope cannot be resolved or no manifest is loaded", async () => {
    const client = makeClient();
    client.getScopeId.mockImplementation(() => ok([]));
    await expect(Pipeline.resolveScopeId(asClient(client), false)).rejects.toThrow(/x_demo/);
    mockGetManifest.mockImplementation(() => undefined);
    await expect(Pipeline.resolveScopeId(asClient(client), false)).rejects.toThrow(/manifest/);
  });
});

describe("planRecordCreation", () => {
  it("returns an empty plan for no candidates without touching the client", async () => {
    await expect(
      Pipeline.planRecordCreation([], { persistScopeId: false })
    ).resolves.toEqual({ scopeId: "", plans: [] });
  });

  // AT-R1-6: the plan behind a dry run sends only GETs and writes nothing.
  it("plans create, adopt and error with GET-only requests", async () => {
    const client = makeClient();
    client.nameLookup.mockImplementation(async (_t, _f, name) =>
      name === "Existing" ? ["ex-1"] : name === "Twice" ? ["a", "b"] : []
    );
    const plan = await Pipeline.planRecordCreation(
      [
        candidate("sys_script_include", "New"),
        candidate("sys_script_include", "Existing"),
        candidate("sys_script_include", "Twice"),
        candidate("sys_user", "Bob"),
        { ...candidate("sys_script", "Clash"), conflict: "two files" },
      ],
      { persistScopeId: false, client: asClient(client) }
    );
    expect(plan.scopeId).toBe("scope-1");
    expect(plan.plans.map((p) => p.action)).toEqual([
      "create",
      "adopt",
      "error",
      "error",
      "error",
    ]);
    expect(plan.plans[1].sysId).toBe("ex-1");
    expect(plan.plans[2].message).toContain("more than one");
    expect(plan.plans[4].message).toBe("two files");
    expect(client.nameLookup).toHaveBeenCalledWith(
      "sys_script_include",
      "name",
      "New",
      "scope-1"
    );
    expect(client.createRecord).not.toHaveBeenCalled();
    expect(mockWriteManifestFile).not.toHaveBeenCalled();
  });

  it("uses the configured displayField and restores a / in the name", async () => {
    mockGetConfig.mockReturnValue({ tableOptions: { sys_script: { displayField: "u_label" } } });
    const client = makeClient();
    const plan = await Pipeline.planRecordCreation([candidate("sys_script", "A〳B")], {
      persistScopeId: false,
      client: asClient(client),
    });
    expect(plan.plans[0]).toMatchObject({ nameField: "u_label", nameValue: "A/B" });
  });

  const PREV = "a".repeat(32);

  it("adopts a record an interrupted run created once a GET confirms it, without a lookup", async () => {
    const client = makeClient();
    const plan = await Pipeline.planRecordCreation([candidate("sys_script_include", "New")], {
      persistScopeId: true,
      known: { "sys_script_include:New": PREV },
      client: asClient(client),
    });
    expect(plan.plans[0]).toMatchObject({ action: "adopt", sysId: PREV });
    expect(client.getRecordScope).toHaveBeenCalledWith("sys_script_include", PREV);
    expect(client.nameLookup).not.toHaveBeenCalled();
  });

  // The checkpoint is a local file: a sys_id from it is a claim, not a fact.
  it("falls back to the ordinary lookup when the checkpoint's record is gone", async () => {
    const client = makeClient();
    client.getRecordScope.mockResolvedValueOnce(undefined);
    const plan = await Pipeline.planRecordCreation([candidate("sys_script_include", "New")], {
      persistScopeId: false,
      known: { "sys_script_include:New": PREV },
      client: asClient(client),
    });
    expect(plan.plans[0].action).toBe("create");
    expect(client.nameLookup).toHaveBeenCalledTimes(1);
  });

  it("adopts a checkpoint record of a table with no scope column", async () => {
    const client = makeClient();
    client.getRecordScope.mockResolvedValueOnce({ sys_id: PREV, sys_scope: "" });
    const plan = await Pipeline.planRecordCreation([candidate("sys_script_include", "New")], {
      persistScopeId: false,
      known: { "sys_script_include:New": PREV },
      client: asClient(client),
    });
    expect(plan.plans[0]).toMatchObject({ action: "adopt", sysId: PREV });
  });

  it.each([
    ["another scope", { sys_id: PREV, sys_scope: "global" }, PREV, /belongs to scope "global"/],
    ["a failed GET", new Error("HTTP 500"), PREV, /could not verify the record .*HTTP 500/],
    ["a non-Error failure", "raw", PREV, /could not verify the record .*raw/],
    ["a malformed sys_id", undefined, "../x", /not a sys_id/],
  ])("refuses a checkpoint record on %s", async (_label, reply, sysId, message) => {
    const client = makeClient();
    if (reply instanceof Error || typeof reply === "string") {
      client.getRecordScope.mockRejectedValueOnce(reply);
    } else if (reply) {
      client.getRecordScope.mockResolvedValueOnce(reply);
    }
    const plan = await Pipeline.planRecordCreation([candidate("sys_script_include", "New")], {
      persistScopeId: false,
      known: { "sys_script_include:New": sysId },
      client: asClient(client),
    });
    expect(plan.plans[0].action).toBe("error");
    expect(plan.plans[0].message).toMatch(message);
    expect(client.nameLookup).not.toHaveBeenCalled();
  });

  it("refuses a table with a differentiatorField", async () => {
    mockGetConfig.mockReturnValue({
      tableOptions: { sys_script_include: { differentiatorField: "sys_id" } },
    });
    const client = makeClient();
    const plan = await Pipeline.planRecordCreation([candidate("sys_script_include", "New")], {
      persistScopeId: false,
      client: asClient(client),
    });
    expect(plan.plans[0].message).toContain("differentiatorField");
  });

  it("turns a lookup failure into an error plan", async () => {
    const client = makeClient();
    client.nameLookup.mockRejectedValueOnce(new Error("boom"));
    client.nameLookup.mockRejectedValueOnce("raw");
    const plan = await Pipeline.planRecordCreation(
      [candidate("sys_script_include", "A"), candidate("sys_script_include", "B")],
      { persistScopeId: false, client: asClient(client) }
    );
    expect(plan.plans.map((p) => p.message)).toEqual(["boom", "raw"]);
  });
});

// Review findings on the idempotency lookup and adoption: an adoption must not
// claim a sys_id the manifest or the same run already tracks, and a lookup hit
// counts only when the instance returns the very key columns that were asked for.
describe("planRecordCreation safety", () => {
  const SYS_TRACKED = "c".repeat(32);
  const lookupRows = (client: FakeClient, rows: Record<string, unknown>[]) =>
    client.tableAPIGet.mockImplementation(async (table: string, query: string) => {
      if (table === "sys_db_object") {
        const name = query.replace(/^name=/, "");
        return name in HIERARCHY
          ? { data: { result: [{ name, "super_class.name": HIERARCHY[name] }] as unknown } }
          : { data: { result: [] as unknown } };
      }
      return { data: { result: rows as unknown } };
    });
  const lookupCalls = (client: FakeClient) =>
    client.tableAPIGet.mock.calls.filter(([t]) => t !== "sys_db_object");

  it("refuses to adopt a sys_id the manifest tracks under another record", async () => {
    manifest.tables = {
      sys_script_include: {
        records: { Old: { name: "Old", sys_id: SYS_TRACKED, files: [] } },
      },
    };
    const client = makeClient();
    client.nameLookup.mockResolvedValue([SYS_TRACKED]);
    const plan = await Pipeline.planRecordCreation([candidate("sys_script_include", "Renamed")], {
      persistScopeId: false,
      client: asClient(client),
    });
    expect(plan.plans[0]).toMatchObject({ action: "error", sysId: SYS_TRACKED });
    expect(plan.plans[0].message).toMatch(
      /already tracked in the manifest as sys_script_include > Old; refusing to adopt/
    );
  });

  it("refuses a checkpoint sys_id the manifest tracks under another table", async () => {
    manifest.tables = {
      sys_script: { records: { Other: { name: "Other", sys_id: SYS_TRACKED, files: [] } } },
    };
    const client = makeClient();
    const plan = await Pipeline.planRecordCreation([candidate("sys_script_include", "New")], {
      persistScopeId: false,
      known: { "sys_script_include:New": SYS_TRACKED },
      client: asClient(client),
    });
    expect(plan.plans[0]).toMatchObject({ action: "error", sysId: SYS_TRACKED });
    expect(plan.plans[0].message).toContain("sys_script > Other");
  });

  it("adopts one sys_id once per run and refuses the second candidate", async () => {
    const client = makeClient();
    client.nameLookup.mockResolvedValue(["same-1"]);
    const plan = await Pipeline.planRecordCreation(
      [candidate("sys_script_include", "A"), candidate("sys_script_include", "B")],
      { persistScopeId: false, client: asClient(client) }
    );
    expect(plan.plans.map((p) => p.action)).toEqual(["adopt", "error"]);
    expect(plan.plans[1].message).toContain("sys_script_include > A");
  });

  it("asks for sys_id and the lookup columns, and accepts a reference value", async () => {
    const client = makeClient();
    lookupRows(client, [{ sys_id: "ex-1", name: { link: "https://x", value: "Existing" } }]);
    const plan = await Pipeline.planRecordCreation([candidate("sys_script_include", "Existing")], {
      persistScopeId: false,
      client: asClient(client),
    });
    expect(plan.plans[0]).toMatchObject({ action: "adopt", sysId: "ex-1" });
    expect(lookupCalls(client)).toEqual([
      ["sys_script_include", "name=Existing^sys_scope=scope-1", "sys_id,name", 2],
    ]);
  });

  it.each([
    ["a row without the lookup column", { sys_id: "ex-1" }, /carries no "name" column/],
    ["a row whose value differs", { sys_id: "ex-1", name: "existing" }, /whose name is "existing"/],
  ])("fails closed on %s", async (_label, row, message) => {
    const client = makeClient();
    lookupRows(client, [row]);
    const plan = await Pipeline.planRecordCreation([candidate("sys_script_include", "Existing")], {
      persistScopeId: false,
      client: asClient(client),
    });
    expect(plan.plans[0].action).toBe("error");
    expect(plan.plans[0].message).toMatch(message);
  });

  // A table the instance does not have used to pass straight through: the
  // hierarchy walk found no sys_db_object row, read that as "outside
  // sys_metadata", and an allowlisted name was planned as a create.
  it.each([
    ["listed under createTables", { createTables: ["u_ghost"] }],
    ["not listed anywhere", {}],
  ])("refuses a table that does not exist on the instance, %s", async (_label, config) => {
    mockGetConfig.mockReturnValue(config);
    const client = makeClient();
    const plan = await Pipeline.planRecordCreation([candidate("u_ghost", "Thing")], {
      persistScopeId: false,
      client: asClient(client),
    });
    expect(plan.plans[0].action).toBe("error");
    expect(plan.plans[0].message).toMatch(
      /table u_ghost does not exist on the instance \(no sys_db_object record is named "u_ghost"\)/
    );
    expect(lookupCalls(client)).toEqual([]);
  });

  it("refuses a create when sys_db_object answers without a result list", async () => {
    mockGetConfig.mockReturnValue({ createTables: ["u_odd"] });
    const client = makeClient();
    client.tableAPIGet.mockImplementation(async (table: string) =>
      table === "sys_db_object" ? { data: {} as { result: unknown } } : { data: { result: [] as unknown } }
    );
    const plan = await Pipeline.planRecordCreation([candidate("u_odd", "Thing")], {
      persistScopeId: false,
      client: asClient(client),
    });
    expect(plan.plans[0].action).toBe("error");
    expect(plan.plans[0].message).toMatch(/sys_db_object answered without a result list for table "u_odd"/);
    expect(lookupCalls(client)).toEqual([]);
  });

  it.each<[string, unknown[]]>([
    ["null", [null]],
    ["a number", [1]],
    ["a string", ["x"]],
    ["a nested array", [[]]],
  ])("refuses a create when the first sys_db_object row is %s", async (_label, result) => {
    mockGetConfig.mockReturnValue({ createTables: ["u_odd"] });
    const client = makeClient();
    client.tableAPIGet.mockImplementation(async (table: string) =>
      table === "sys_db_object" ? { data: { result: result as unknown } } : { data: { result: [] as unknown } }
    );
    const plan = await Pipeline.planRecordCreation([candidate("u_odd", "Thing")], {
      persistScopeId: false,
      client: asClient(client),
    });
    expect(plan.plans[0].action).toBe("error");
    expect(plan.plans[0].message).toMatch(/sys_db_object answered with a result that is not a record for table "u_odd"/);
    expect(lookupCalls(client)).toEqual([]);
  });

  it.each<[string, unknown[]]>([
    ["an empty record", [{}]],
    ["a record without super_class.name", [{ name: "u_odd" }]],
    ["a numeric super_class.name", [{ name: "u_odd", "super_class.name": 5 }]],
    ["a null super_class.name", [{ name: "u_odd", "super_class.name": null }]],
    ["an object super_class.name", [{ name: "u_odd", "super_class.name": { value: "sys_metadata" } }]],
    ["another table's record", [{ name: "u_other", "super_class.name": "" }]],
  ])("refuses a create when the sys_db_object row is %s", async (_label, result) => {
    mockGetConfig.mockReturnValue({ createTables: ["u_odd"] });
    const client = makeClient();
    client.tableAPIGet.mockImplementation(async (table: string) =>
      table === "sys_db_object" ? { data: { result: result as unknown } } : { data: { result: [] as unknown } }
    );
    const plan = await Pipeline.planRecordCreation([candidate("u_odd", "Thing")], {
      persistScopeId: false,
      client: asClient(client),
    });
    expect(plan.plans[0].action).toBe("error");
    expect(plan.plans[0].message).toMatch(/sys_db_object answered with a record that does not describe table "u_odd"/);
    expect(lookupCalls(client)).toEqual([]);
  });

  // A table outside sys_metadata is looked up without a sys_scope term, so the
  // returned row's own sys_scope is what keeps another application's record
  // from being adopted.
  const unscopedRows = (client: FakeClient, extra: Record<string, unknown>) =>
    client.tableAPIGet.mockImplementation(async (table: string, query: string) => {
      if (table === "sys_db_object") {
        const name = query.replace(/^name=/, "");
        return name in HIERARCHY
          ? { data: { result: [{ name, "super_class.name": HIERARCHY[name] }] as unknown } }
          : { data: { result: [] as unknown } };
      }
      const [, field, value] = /^([^=^]+)=([^^]*)/.exec(query) ?? [];
      return { data: { result: [{ sys_id: "inc-1", [field]: value, ...extra }] as unknown } };
    });

  it("refuses to adopt a record of an unscoped table that belongs to another scope", async () => {
    mockGetConfig.mockReturnValue({ createTables: ["incident"] });
    const client = makeClient();
    unscopedRows(client, { sys_scope: "other-scope" });
    const plan = await Pipeline.planRecordCreation([candidate("incident", "Thing")], {
      persistScopeId: false,
      client: asClient(client),
    });
    expect(plan.plans[0]).toMatchObject({ action: "error", scoped: false });
    expect(plan.plans[0].message).toMatch(
      /matching incident record inc-1 belongs to scope "other-scope", not to this application \(scope-1\); refusing to adopt it/
    );
    const [[, query, fields]] = lookupCalls(client);
    expect(query).not.toContain("sys_scope");
    expect(String(fields).split(",")).toContain("sys_scope");
  });

  it.each([
    ["this application's scope", { sys_scope: "scope-1" }],
    ["an empty scope", { sys_scope: "" }],
    ["no scope column", {}],
  ])("adopts a record of an unscoped table with %s", async (_label, extra) => {
    mockGetConfig.mockReturnValue({ createTables: ["incident"] });
    const client = makeClient();
    unscopedRows(client, extra);
    const plan = await Pipeline.planRecordCreation([candidate("incident", "Thing")], {
      persistScopeId: false,
      client: asClient(client),
    });
    expect(plan.plans[0]).toMatchObject({ action: "adopt", sysId: "inc-1", scoped: false });
  });

  it("refuses a name holding ^ before any lookup request on the table", async () => {
    const client = makeClient();
    const plan = await Pipeline.planRecordCreation([candidate("sys_script_include", "A^B")], {
      persistScopeId: false,
      client: asClient(client),
    });
    expect(plan.plans[0].action).toBe("error");
    expect(plan.plans[0].message).toMatch(/contains "\^", which separates conditions/);
    expect(lookupCalls(client)).toEqual([]);
  });
});

describe("createRecords", () => {
  const planFor = async (client: FakeClient, cands: import("../pushPipeline.js").CreateCandidate[]) =>
    Pipeline.planRecordCreation(cands, { persistScopeId: true, client: asClient(client) });

  it("returns nothing for an empty plan", async () => {
    await expect(Pipeline.createRecords({ scopeId: "", plans: [] })).resolves.toEqual({
      results: [],
      records: [],
      failedTables: [],
    });
  });

  // AT-R1-1: create posts the built fields with the name and the scope, and
  // records the new sys_id in the manifest and the checkpoint.
  it("creates a record and adds it to the manifest", async () => {
    const client = makeClient();
    const onCreated = jest.fn();
    const plan = await planFor(client, [
      candidate("sys_script_include", "New", [{}, { field: "description", ext: ".md", filePath: "/p/d.md" }]),
    ]);
    const outcome = await Pipeline.createRecords(plan, {
      client: asClient(client),
      onCreated,
      retryWaitMs: 0,
    });
    expect(client.createRecord).toHaveBeenCalledWith("sys_script_include", {
      script: "gs.info('new');",
      description: "gs.info('new');",
      name: "New",
      sys_scope: "scope-1",
    });
    expect(onCreated).toHaveBeenCalledWith("sys_script_include:New", "new-1");
    expect(outcome.results).toEqual([
      { success: true, message: "sys_script_include > New : created (new-1)." },
    ]);
    const tables = manifest.tables as Record<string, { records: Record<string, unknown> }>;
    expect(tables.sys_script_include.records.New).toEqual({
      name: "New",
      sys_id: "new-1",
      files: [
        { name: "script", type: "js" },
        { name: "description", type: "txt" },
      ],
    });
    expect(manifest.scopeId).toBe("scope-1");
  });

  // AT-R1-2: one same-name record in scope is adopted, then PATCHed by pushFiles.
  it("adopts an existing record and hands its files back for pushFiles", async () => {
    manifest.tables = {
      sys_script_include: { records: { Other: { name: "Other", sys_id: "o", files: [] } } },
    };
    const client = makeClient();
    client.nameLookup.mockImplementation(async (_t, _f, name) => [
      name === "Ghost" ? "gh-1" : "ex-1",
    ]);
    const adoptedCtx: Sync.FileContext = {
      filePath: "/proj/src/sys_script_include/Existing/script.js",
      name: "Existing",
      tableName: "sys_script_include",
      targetField: "script",
      ext: ".js",
      sys_id: "ex-1",
      scope: "x_demo",
    };
    mockGetFileContextFromPath.mockImplementation((p: unknown) =>
      p === adoptedCtx.filePath ? adoptedCtx : undefined
    );
    const plan = await planFor(client, [
      candidate("sys_script_include", "Existing"),
      candidate("sys_script_include", "Ghost", [{ filePath: "/gone.js" }]),
    ]);
    const outcome = await Pipeline.createRecords(plan, { client: asClient(client) });
    expect(client.createRecord).not.toHaveBeenCalled();
    expect(outcome.results).toEqual([]);
    expect(outcome.records).toEqual([
      { table: "sys_script_include", sysId: "ex-1", fields: { script: adoptedCtx } },
    ]);
    const tables = manifest.tables as Record<string, { records: Record<string, unknown> }>;
    expect(Object.keys(tables.sys_script_include.records).sort()).toEqual([
      "Existing",
      "Ghost",
      "Other",
    ]);
  });

  // AT-R1-3: more than one hit, or a refused table, is a failed result and no write.
  it("reports error plans as failures and sends nothing", async () => {
    const client = makeClient();
    client.nameLookup.mockImplementation(async () => ["a", "b"]);
    const plan = await planFor(client, [candidate("sys_script_include", "Twice")]);
    const outcome = await Pipeline.createRecords(plan, { client: asClient(client) });
    expect(outcome.results[0].success).toBe(false);
    expect(outcome.results[0].message).toContain("more than one");
    expect(outcome.failedTables).toEqual(["sys_script_include"]);
    expect(client.createRecord).not.toHaveBeenCalled();
  });

  it("looks the record up before retrying a failed POST, and adopts what the POST created", async () => {
    const client = makeClient();
    const plan = await planFor(client, [candidate("sys_script_include", "New")]);
    client.createRecord.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    client.nameLookup.mockImplementationOnce(async () => ["late-1"]);
    const onCreated = jest.fn();
    const outcome = await Pipeline.createRecords(plan, {
      client: asClient(client),
      onCreated,
      retryWaitMs: 0,
    });
    expect(client.createRecord).toHaveBeenCalledTimes(1);
    expect(onCreated).toHaveBeenCalledWith("sys_script_include:New", "late-1");
    expect(outcome.results[0].message).toContain("created (late-1)");
  });

  it("retries the POST when the lookup finds nothing, up to the retry limit", async () => {
    const client = makeClient();
    const plan = await planFor(client, [candidate("sys_script_include", "New")]);
    client.createRecord
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockResolvedValueOnce({ sys_id: "second-1" });
    const outcome = await Pipeline.createRecords(plan, { client: asClient(client), retryWaitMs: 0 });
    expect(client.createRecord).toHaveBeenCalledTimes(2);
    expect(outcome.results[0].message).toContain("created (second-1)");

    client.createRecord.mockReset();
    client.createRecord.mockRejectedValue({ response: { status: 503 } });
    const failed = await Pipeline.createRecords(plan, { client: asClient(client), retryWaitMs: 0 });
    expect(failed.results[0].success).toBe(false);
    expect(client.createRecord).toHaveBeenCalledTimes(4);
  });

  it("does not retry a non-retryable error, and fails on an ambiguous lookup after a timeout", async () => {
    const client = makeClient();
    const plan = await planFor(client, [candidate("sys_script_include", "New")]);
    client.createRecord.mockRejectedValueOnce({ response: { status: 400 } });
    const rejected = await Pipeline.createRecords(plan, { client: asClient(client), retryWaitMs: 0 });
    expect(rejected.results[0].success).toBe(false);
    // A failed POST names its table, so `push --prune` holds deletions there.
    expect(rejected.failedTables).toEqual(["sys_script_include"]);
    expect(client.createRecord).toHaveBeenCalledTimes(1);

    client.createRecord.mockRejectedValueOnce(new Error("ETIMEDOUT"));
    client.nameLookup.mockImplementationOnce(async () => ["a", "b"]);
    const ambiguous = await Pipeline.createRecords(plan, { client: asClient(client), retryWaitMs: 0 });
    expect(ambiguous.results[0].message).toContain("after a failed create");
  });

  it("fails a record whose build fails, without posting it", async () => {
    const client = makeClient();
    const plan = await planFor(client, [candidate("sys_script_include", "New")]);
    getFinalFileContents.mockImplementation(async () => {
      throw new Error("plugin exploded");
    });
    const outcome = await Pipeline.createRecords(plan, { client: asClient(client) });
    expect(outcome.results[0].success).toBe(false);
    expect(client.createRecord).not.toHaveBeenCalled();
  });
});
