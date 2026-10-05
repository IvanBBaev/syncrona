// SPDX-License-Identifier: GPL-3.0-or-later
//
// R2, `push --prune`: delete instance records whose local files are all gone.
//
// These tests pin the acceptance tests AT-R2-1..5 at the pipeline level: which
// manifest records are candidates (every file missing, sidecar included; `--diff`
// narrows to deleted paths; an explicit target narrows to its subtree), the table
// policy, the read-only plan (one scope GET per record, refusing out-of-scope
// records), and the DELETE + manifest update. Every request goes to a
// hand-rolled client; nothing leaves the process.
import { jest } from "@jest/globals";
import path from "path";
import { SN } from "@syncrona/types";
export {};

const SOURCE = path.resolve("/proj/src");
const SYS_A = "a".repeat(32);
const SYS_B = "b".repeat(32);
const SYS_C = "c".repeat(32);
const SCOPE = "1".repeat(32);

const mockGetConfig = jest.fn();
const mockGetManifest = jest.fn();
const mockUpdateManifest = jest.fn();
const mockWriteManifestFile = jest.fn();
const mockGetFileContextFromPath = jest.fn();
const mockPathExists = jest.fn();
const mockFindMissingFiles = jest.fn();
const mockLoggerDebug = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  getManifest: (...args: unknown[]) => mockGetManifest(...args),
  updateManifest: (...args: unknown[]) => mockUpdateManifest(...args),
  getSourcePath: () => SOURCE,
}));

jest.unstable_mockModule("../FileUtils.js", () => ({
  writeManifestFile: (...args: unknown[]) => mockWriteManifestFile(...args),
  getFileContextFromPath: (...args: unknown[]) => mockGetFileContextFromPath(...args),
  pathExists: (...args: unknown[]) => mockPathExists(...args),
  splitEncodedPaths: (encoded: string) => encoded.split("|").filter((p) => p !== ""),
  parseUnmappedPath: jest.fn(),
  encodedPathsToFilePaths: jest.fn(),
}));

jest.unstable_mockModule("../downloadPipeline.js", () => ({
  findMissingFiles: (...args: unknown[]) => mockFindMissingFiles(...args),
}));

jest.unstable_mockModule("../PluginManager.js", () => ({
  default: { getFinalFileContents: jest.fn() },
}));

type HttpError = { response?: { status?: number } };
const statusOf = (e: unknown) => (e as HttpError)?.response?.status;

jest.unstable_mockModule("../snClient.js", () => ({
  defaultClient: () => {
    throw new Error("tests must pass an explicit client");
  },
  // A faithful miniature of the real helper: retry while shouldRetry allows.
  retryOnErr: async (
    task: () => Promise<unknown>,
    retries: number,
    _wait: number,
    onRetry?: (left: number) => void,
    shouldRetry?: (e: unknown) => boolean
  ) => {
    for (let left = retries; ; left -= 1) {
      try {
        return await task();
      } catch (e) {
        if ((shouldRetry && !shouldRetry(e)) || left <= 0) throw e;
        onRetry?.(left - 1);
      }
    }
  },
  processPushResponse: jest.fn(),
  getErrorResponseStatus: (e: unknown) => statusOf(e),
  isRetryableRequestError: (e: unknown) => {
    const status = statusOf(e);
    return status === undefined || status >= 500;
  },
  SNClient: jest.fn(),
  resolveCredentials: jest.fn(),
  unwrapSNResponse: jest.fn(),
  unwrapTableAPIFirstItem: async (p: Promise<{ data: { result: unknown } }>, key: string) =>
    ((await p).data.result as Record<string, unknown>[])[0]?.[key],
  unwrapTableAPIFirstItemOrEmpty: jest.fn(),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    warn: jest.fn(),
    info: jest.fn(),
    error: jest.fn(),
    debug: (...a: unknown[]) => mockLoggerDebug(...a),
    silly: jest.fn(),
  },
}));

jest.unstable_mockModule("../progress.js", () => ({
  getProgTick: () => undefined,
}));

let Pipeline: typeof import("../pushPipeline.js");

const file = (name: string, type = "js"): SN.File => ({ name, type } as SN.File);
const META: SN.File = { name: ".meta", type: "json" } as SN.File;

let manifest: SN.AppManifest;

const baseManifest = (): SN.AppManifest =>
  ({
    scope: "x_app",
    scopeId: SCOPE,
    tables: {
      sys_script_include: {
        records: {
          Both: { name: "Both", sys_id: SYS_A, files: [file("script"), META] },
          Half: { name: "Half", sys_id: SYS_B, files: [file("script"), META] },
        },
      },
      sys_ui_script: {
        records: {
          Ui: { name: "Ui", sys_id: SYS_C, files: [file("script")] },
        },
      },
    },
  }) as unknown as SN.AppManifest;

// findMissingFiles' shape: table -> sys_id -> missing file entries.
const missingMap = (entries: [string, string, SN.File[]][]) => {
  const out: Record<string, Record<string, SN.File[]>> = {};
  for (const [table, sysId, files] of entries) {
    out[table] = { ...(out[table] ?? {}), [sysId]: files };
  }
  return out;
};

type ScopeReply = { sys_id: string; sys_scope: string } | undefined;
const makeClient = (scopes: Record<string, ScopeReply | Error> = {}) => {
  const calls: { method: string; url: string }[] = [];
  const getRecordScope = jest.fn(async (table: string, sysId: string) => {
    calls.push({ method: "GET", url: `${table}/${sysId}` });
    const reply = sysId in scopes ? scopes[sysId] : { sys_id: sysId, sys_scope: SCOPE };
    if (reply instanceof Error) throw reply;
    return reply;
  });
  const deleteRecord = jest.fn(async (table: string, sysId: string) => {
    calls.push({ method: "DELETE", url: `${table}/${sysId}` });
    return { status: 204 };
  });
  const getScopeId = jest.fn(async (_scope: string) => {
    calls.push({ method: "GET", url: "sys_scope" });
    return { data: { result: [{ sys_id: SCOPE }] } };
  });
  return { getRecordScope, deleteRecord, getScopeId, calls };
};
type FakeClient = ReturnType<typeof makeClient>;
const asClient = (c: FakeClient) => c as unknown as import("../snClient.js").SNClient;

const candidate = (
  table: string,
  recordName: string,
  sysId: string,
  files: SN.File[] = [file("script")]
): import("../pushPipeline.js").PruneCandidate => ({
  table,
  recordKey: recordName,
  recordName,
  sysId,
  files,
});

beforeAll(async () => {
  Pipeline = await import("../pushPipeline.js");
});

beforeEach(() => {
  jest.clearAllMocks();
  manifest = baseManifest();
  mockGetManifest.mockImplementation(() => manifest);
  mockUpdateManifest.mockImplementation((m: unknown) => {
    manifest = m as SN.AppManifest;
  });
  mockWriteManifestFile.mockResolvedValue(undefined);
  mockGetConfig.mockReturnValue({ tableOptions: {} });
  mockPathExists.mockResolvedValue(false);
  mockGetFileContextFromPath.mockReturnValue(undefined);
});

describe("findPruneCandidates", () => {
  it("AT-R2-1: a record with one of two files missing is not a candidate", async () => {
    mockFindMissingFiles.mockResolvedValue(
      missingMap([
        ["sys_script_include", SYS_A, [file("script"), META]],
        ["sys_script_include", SYS_B, [file("script")]],
      ])
    );
    const found = await Pipeline.findPruneCandidates();
    expect(found).toEqual([
      {
        table: "sys_script_include",
        recordKey: "Both",
        recordName: "Both",
        sysId: SYS_A,
        files: [file("script"), META],
      },
    ]);
  });

  it("skips records with no files, tables with nothing missing, and records still holding a sidecar", async () => {
    (manifest.tables.sys_script_include.records as Record<string, unknown>).Empty = {
      name: "",
      sys_id: "d".repeat(32),
      files: [],
    };
    mockFindMissingFiles.mockResolvedValue(
      missingMap([
        ["sys_script_include", SYS_A, [file("script"), META]],
        ["sys_ui_script", SYS_C, [file("script")]],
      ])
    );
    // Ui's manifest lists no sidecar, but one is on disk: the record is not gone.
    mockPathExists.mockImplementation(async (p: unknown) =>
      String(p) === path.join(SOURCE, "sys_ui_script", "Ui", ".meta.json")
    );
    const found = await Pipeline.findPruneCandidates();
    expect(found.map((c) => c.recordName)).toEqual(["Both"]);
  });

  it("probes the flat sidecar name and falls back to the record key for a nameless record", async () => {
    mockGetConfig.mockReturnValue({ flat: true, tableOptions: {} });
    manifest.tables.sys_ui_script.records.Ui.name = "";
    mockFindMissingFiles.mockResolvedValue(missingMap([["sys_ui_script", SYS_C, [file("script")]]]));
    const found = await Pipeline.findPruneCandidates();
    expect(found.map((c) => c.recordName)).toEqual(["Ui"]);
    expect(mockPathExists).toHaveBeenCalledWith(
      path.join(SOURCE, "sys_ui_script", "Ui~.meta.json")
    );
  });

  it("AT-R2-4: with --diff only records a deleted path maps to stay candidates", async () => {
    mockFindMissingFiles.mockResolvedValue(
      missingMap([
        ["sys_script_include", SYS_A, [file("script"), META]],
        ["sys_ui_script", SYS_C, [file("script")]],
      ])
    );
    const deletedPath = path.join(SOURCE, "sys_ui_script", "Ui", "script.js");
    const unknownPath = path.join(SOURCE, "sys_ui_script", "Stray", "script.js");
    mockGetFileContextFromPath.mockImplementation((p: unknown) =>
      p === deletedPath ? { tableName: "sys_ui_script", sys_id: SYS_C } : undefined
    );
    const found = await Pipeline.findPruneCandidates({
      diffDeleted: [deletedPath, unknownPath],
    });
    expect(found.map((c) => c.sysId)).toEqual([SYS_C]);
  });

  it("an empty --diff deletion list yields no candidates at all", async () => {
    mockFindMissingFiles.mockResolvedValue(
      missingMap([["sys_script_include", SYS_A, [file("script"), META]]])
    );
    await expect(Pipeline.findPruneCandidates({ diffDeleted: [] })).resolves.toEqual([]);
  });

  it("an explicit target keeps only records at, under or above it (folder layout)", async () => {
    mockFindMissingFiles.mockResolvedValue(
      missingMap([
        ["sys_script_include", SYS_A, [file("script"), META]],
        ["sys_ui_script", SYS_C, [file("script")]],
      ])
    );
    const tableTarget = path.join(SOURCE, "sys_ui_script");
    await expect(
      Pipeline.findPruneCandidates({ targets: tableTarget })
    ).resolves.toMatchObject([{ sysId: SYS_C }]);
    const fileTarget = path.join(SOURCE, "sys_script_include", "Both", "script.js");
    await expect(
      Pipeline.findPruneCandidates({ targets: fileTarget })
    ).resolves.toMatchObject([{ sysId: SYS_A }]);
    await expect(
      Pipeline.findPruneCandidates({ targets: path.join(SOURCE, "elsewhere") })
    ).resolves.toEqual([]);
    await expect(Pipeline.findPruneCandidates({ targets: SOURCE })).resolves.toHaveLength(2);
  });

  it("an explicit target in flat layout matches the table directory or the record stem", async () => {
    mockGetConfig.mockReturnValue({ flat: true, tableOptions: {} });
    mockFindMissingFiles.mockResolvedValue(
      missingMap([
        ["sys_script_include", SYS_A, [file("script"), META]],
        ["sys_ui_script", SYS_C, [file("script")]],
      ])
    );
    const stemTarget = path.join(SOURCE, "sys_ui_script", "Ui~script.js");
    await expect(
      Pipeline.findPruneCandidates({ targets: stemTarget })
    ).resolves.toMatchObject([{ sysId: SYS_C }]);
    const otherStem = path.join(SOURCE, "sys_ui_script", "Other~script.js");
    await expect(Pipeline.findPruneCandidates({ targets: otherStem })).resolves.toEqual([]);
    await expect(
      Pipeline.findPruneCandidates({ targets: path.join(SOURCE, "sys_script_include") })
    ).resolves.toMatchObject([{ sysId: SYS_A }]);
  });

  // `Foo~Bar~script.js` is a field file of record `Foo~Bar`; a prefix match on
  // the stem alone would also select record `Foo` and delete it.
  it("a flat target names one record exactly, not every record its stem prefixes", async () => {
    mockGetConfig.mockReturnValue({ flat: true, tableOptions: {} });
    mockGetManifest.mockReturnValue({
      scope: "x_app",
      scopeId: SCOPE,
      tables: {
        sys_ui_script: {
          records: {
            Foo: { name: "Foo", sys_id: SYS_A, files: [file("script")] },
            "Foo~Bar": { name: "Foo~Bar", sys_id: SYS_B, files: [file("script")] },
          },
        },
      },
    });
    mockFindMissingFiles.mockResolvedValue(
      missingMap([
        ["sys_ui_script", SYS_A, [file("script")]],
        ["sys_ui_script", SYS_B, [file("script")]],
      ])
    );
    const dir = path.join(SOURCE, "sys_ui_script");
    await expect(
      Pipeline.findPruneCandidates({ targets: path.join(dir, "Foo~Bar~script.js") })
    ).resolves.toMatchObject([{ sysId: SYS_B }]);
    await expect(
      Pipeline.findPruneCandidates({ targets: path.join(dir, "Foo~script.js") })
    ).resolves.toMatchObject([{ sysId: SYS_A }]);
  });

  it("throws when no manifest is loaded", async () => {
    mockGetManifest.mockReturnValue(undefined);
    await expect(Pipeline.findPruneCandidates()).rejects.toThrow("No manifest has been loaded!");
  });
});

describe("checkPruneTablePolicy", () => {
  it("refuses the shared create-policy deny list", () => {
    expect(Pipeline.checkPruneTablePolicy("sys_properties")).toContain("deny list");
    expect(Pipeline.checkPruneTablePolicy("sys_user_role")).toContain("deny list");
  });

  it("refuses a data-model table even when tableOptions opts it in", () => {
    mockGetConfig.mockReturnValue({ tableOptions: { sys_dictionary: {}, sys_ui_policy: {} } });
    expect(Pipeline.checkPruneTablePolicy("sys_dictionary")).toContain("data-model table");
    expect(Pipeline.checkPruneTablePolicy("sys_ui_policy")).toContain("data-model table");
    mockGetConfig.mockReturnValue({});
  });

  it("refuses a default-excluded table unless tableOptions opts it in", () => {
    expect(Pipeline.checkPruneTablePolicy("sys_report")).toContain("excluded by default");
    mockGetConfig.mockReturnValue({ tableOptions: { sys_report: {} } });
    expect(Pipeline.checkPruneTablePolicy("sys_report")).toBeUndefined();
    mockGetConfig.mockReturnValue({});
    expect(Pipeline.checkPruneTablePolicy("sys_report")).toContain("excluded by default");
  });

  it("allows an ordinary application table", () => {
    expect(Pipeline.checkPruneTablePolicy("sys_script_include")).toBeUndefined();
  });
});

describe("planRecordPrune", () => {
  it("returns an empty plan without touching the client for no candidates", async () => {
    await expect(
      Pipeline.planRecordPrune([], { persistScopeId: false, client: asClient(makeClient()) })
    ).resolves.toEqual({ scopeId: "", plans: [] });
  });

  it("AT-R2-3: refuses an out-of-scope record, and the run sends no DELETE", async () => {
    const client = makeClient({ [SYS_A]: { sys_id: SYS_A, sys_scope: "f".repeat(32) } });
    const plan = await Pipeline.planRecordPrune([candidate("sys_script_include", "Both", SYS_A)], {
      persistScopeId: false,
      client: asClient(client),
    });
    expect(plan.plans[0]).toMatchObject({ action: "error" });
    expect(plan.plans[0].message).toContain("not to this application");
    const results = await Pipeline.pruneRecords(plan, { client: asClient(client) });
    expect(results[0].success).toBe(false);
    expect(client.deleteRecord).not.toHaveBeenCalled();
    expect(manifest.tables.sys_script_include.records.Both).toBeDefined();
  });

  it("names an empty remote scope as unknown", async () => {
    const client = makeClient({ [SYS_A]: { sys_id: SYS_A, sys_scope: "" } });
    const plan = await Pipeline.planRecordPrune([candidate("t_app", "R", SYS_A)], {
      persistScopeId: false,
      client: asClient(client),
    });
    expect(plan.plans[0].message).toContain('scope "unknown"');
  });

  it("plans unverified for a 404, error for a failed GET, a denied table or a malformed sys_id", async () => {
    const client = makeClient({
      [SYS_A]: undefined,
      [SYS_B]: new Error("HTTP 403"),
    });
    const plan = await Pipeline.planRecordPrune(
      [
        candidate("sys_script_include", "Gone", SYS_A),
        candidate("sys_script_include", "Denied", SYS_B),
        candidate("sys_properties", "Prop", SYS_C),
        candidate("sys_script_include", "Bad", "not-a-sys-id"),
        candidate("sys_script_include", "Thrown", "e".repeat(32)),
      ],
      { persistScopeId: false, client: asClient(client) }
    );
    client.getRecordScope.mockRejectedValueOnce("plain failure");
    const thrown = await Pipeline.planRecordPrune(
      [candidate("sys_script_include", "Thrown", "e".repeat(32))],
      { persistScopeId: false, client: asClient(client) }
    );
    expect(plan.plans.map((p) => p.action)).toEqual([
      "unverified",
      "error",
      "error",
      "error",
      "delete",
    ]);
    expect(plan.plans[0].message).toMatch(/404[\s\S]*read ACL[\s\S]*manifest entry is kept/);
    expect(plan.plans[1].message).toContain("HTTP 403");
    expect(plan.plans[2].message).toContain("deny list");
    expect(plan.plans[3].message).toContain("is not a sys_id");
    expect(thrown.plans[0].message).toContain("plain failure");
    // The policy and format refusals never reached the instance.
    expect(client.getRecordScope).toHaveBeenCalledTimes(4);
  });

  it("resolves an unknown scopeId through sys_scope, persisting only when asked", async () => {
    delete (manifest as { scopeId?: string }).scopeId;
    const client = makeClient();
    const dry = await Pipeline.planRecordPrune([candidate("sys_script_include", "Both", SYS_A)], {
      persistScopeId: false,
      client: asClient(client),
    });
    expect(dry.scopeId).toBe(SCOPE);
    expect(mockWriteManifestFile).not.toHaveBeenCalled();
    await Pipeline.planRecordPrune([candidate("sys_script_include", "Both", SYS_A)], {
      persistScopeId: true,
      client: asClient(client),
    });
    expect(manifest.scopeId).toBe(SCOPE);
  });

  it("refuses every candidate when the scope cannot be resolved", async () => {
    delete (manifest as { scopeId?: string }).scopeId;
    const client = makeClient();
    client.getScopeId.mockResolvedValueOnce({ data: { result: [] } });
    const plan = await Pipeline.planRecordPrune(
      [candidate("sys_script_include", "Both", SYS_A), candidate("sys_ui_script", "Ui", SYS_C)],
      { persistScopeId: false, client: asClient(client) }
    );
    expect(plan.plans.map((p) => p.action)).toEqual(["error", "error"]);
    expect(plan.plans[0].message).toContain("scope is unknown");
    expect(client.getRecordScope).not.toHaveBeenCalled();
    client.getScopeId.mockRejectedValueOnce("offline");
    const again = await Pipeline.planRecordPrune([candidate("sys_ui_script", "Ui", SYS_C)], {
      persistScopeId: false,
      client: asClient(client),
    });
    expect(again.plans[0].message).toContain("offline");
  });

  it("AT-R2-5: planning is read-only — GETs only, manifest untouched", async () => {
    const client = makeClient({ [SYS_B]: undefined });
    await Pipeline.planRecordPrune(
      [candidate("sys_script_include", "Both", SYS_A), candidate("sys_script_include", "Half", SYS_B)],
      { persistScopeId: false, client: asClient(client) }
    );
    expect(client.calls.every((c) => c.method === "GET")).toBe(true);
    expect(mockWriteManifestFile).not.toHaveBeenCalled();
  });
});

describe("pruneRecords", () => {
  it("returns no results for an empty plan", async () => {
    await expect(Pipeline.pruneRecords({ scopeId: "", plans: [] })).resolves.toEqual([]);
  });

  it("AT-R2-2: all files missing -> one GET, one DELETE, and the manifest loses the record", async () => {
    mockFindMissingFiles.mockResolvedValue(
      missingMap([
        ["sys_script_include", SYS_A, [file("script"), META]],
        ["sys_script_include", SYS_B, [file("script")]],
      ])
    );
    const client = makeClient();
    const candidates = await Pipeline.findPruneCandidates();
    const plan = await Pipeline.planRecordPrune(candidates, {
      persistScopeId: true,
      client: asClient(client),
    });
    const results = await Pipeline.pruneRecords(plan, { client: asClient(client), retryWaitMs: 0 });

    expect(client.calls).toEqual([
      { method: "GET", url: `sys_script_include/${SYS_A}` },
      { method: "DELETE", url: `sys_script_include/${SYS_A}` },
    ]);
    expect(results).toEqual([
      { success: true, message: `sys_script_include > Both : deleted (${SYS_A}).` },
    ]);
    expect(manifest.tables.sys_script_include.records.Both).toBeUndefined();
    expect(manifest.tables.sys_script_include.records.Half).toBeDefined();
    expect(mockWriteManifestFile).toHaveBeenCalledTimes(1);
  });

  // A 404 on the scope GET is also what a read ACL hiding the record looks
  // like, so it proves nothing: the record is reported, nothing is sent, and
  // the manifest keeps its entry.
  it("skips an unverified record: no DELETE, and the manifest keeps it", async () => {
    const client = makeClient();
    const results = await Pipeline.pruneRecords(
      {
        scopeId: SCOPE,
        plans: [
          {
            candidate: candidate("sys_ui_script", "Ui", SYS_C),
            action: "unverified",
            message: "skipped: the instance answers 404",
          },
        ],
      },
      { client: asClient(client) }
    );
    expect(results[0]).toEqual({
      success: true,
      message: "sys_ui_script > Ui : skipped: the instance answers 404",
    });
    expect(client.deleteRecord).not.toHaveBeenCalled();
    expect(manifest.tables.sys_ui_script.records.Ui).toBeDefined();
    expect(mockWriteManifestFile).not.toHaveBeenCalled();
  });

  it("retries a transient DELETE failure and treats a 404 on retry as landed", async () => {
    const client = makeClient();
    client.deleteRecord
      .mockRejectedValueOnce({ response: { status: 503 } })
      .mockRejectedValueOnce({ response: { status: 404 } });
    const results = await Pipeline.pruneRecords(
      {
        scopeId: SCOPE,
        plans: [{ candidate: candidate("sys_script_include", "Both", SYS_A), action: "delete" }],
      },
      { client: asClient(client), retryWaitMs: 0 }
    );
    expect(client.deleteRecord).toHaveBeenCalledTimes(2);
    expect(mockLoggerDebug).toHaveBeenCalled();
    expect(results[0].success).toBe(true);
    expect(manifest.tables.sys_script_include.records.Both).toBeUndefined();
  });

  it("reports a DELETE refused by the instance and keeps the record in the manifest", async () => {
    const client = makeClient();
    client.deleteRecord.mockRejectedValueOnce(
      Object.assign(new Error("ACL denied"), { response: { status: 403 } })
    );
    client.deleteRecord.mockRejectedValueOnce({ response: { status: 400 } });
    const results = await Pipeline.pruneRecords(
      {
        scopeId: SCOPE,
        plans: [
          { candidate: candidate("sys_script_include", "Both", SYS_A), action: "delete" },
          { candidate: candidate("sys_script_include", "Half", SYS_B), action: "delete" },
        ],
      },
      { client: asClient(client), retryWaitMs: 0 }
    );
    expect(results.map((r) => r.success)).toEqual([false, false]);
    expect(results[0].message).toContain("ACL denied");
    expect(manifest.tables.sys_script_include.records.Both).toBeDefined();
  });

  it("leaves the manifest alone when the table or record entry is already absent", async () => {
    const client = makeClient();
    const results = await Pipeline.pruneRecords(
      {
        scopeId: SCOPE,
        plans: [
          { candidate: candidate("no_such_table", "X", SYS_A), action: "delete" },
          { candidate: candidate("sys_ui_script", "Missing", SYS_C), action: "delete" },
        ],
      },
      { client: asClient(client) }
    );
    expect(results.map((r) => r.success)).toEqual([true, true]);
    expect(mockWriteManifestFile).not.toHaveBeenCalled();
  });
});

// The mass-delete guard: the baseline manifest tracks three records.
describe("pruneVolumeRefusal", () => {
  const manyRecords = (count: number) => {
    const records: Record<string, unknown> = {};
    for (let i = 0; i < count; i += 1) {
      records[`R${i}`] = { name: `R${i}`, sys_id: String(i).padStart(32, "0"), files: [] };
    }
    manifest = { scope: "x_app", tables: { sys_script_include: { records } } } as never;
  };

  it("lets a handful of deletions through however large their share", () => {
    expect(Pipeline.pruneVolumeRefusal(3)).toBeUndefined();
    manyRecords(6);
    expect(Pipeline.pruneVolumeRefusal(5)).toBeUndefined();
  });

  it("refuses more than the share limit of the manifest above the floor", () => {
    manyRecords(20);
    expect(Pipeline.pruneVolumeRefusal(6)).toMatch(
      /^6 of the 20 record\(s\) the manifest tracks would be deleted \(30%\)[\s\S]*--allow-mass-delete/
    );
    manyRecords(40);
    expect(Pipeline.pruneVolumeRefusal(6)).toBeUndefined();
    expect(Pipeline.pruneVolumeRefusal(9)).toMatch(/9 of the 40/);
  });

  it("refuses more than the absolute limit even in a large manifest", () => {
    manyRecords(1000);
    expect(Pipeline.pruneVolumeRefusal(Pipeline.PRUNE_MASS_DELETE_COUNT)).toBeUndefined();
    expect(Pipeline.pruneVolumeRefusal(Pipeline.PRUNE_MASS_DELETE_COUNT + 1)).toMatch(
      /26 of the 1000 record\(s\)/
    );
  });

  it("treats an empty manifest as a full share", () => {
    manifest = { scope: "x_app", tables: {} } as never;
    expect(Pipeline.pruneVolumeRefusal(6)).toMatch(/6 of the 0 record\(s\).*\(100%\)/);
  });
});

describe("persistScopeId", () => {
  it("stores a resolved scope sys_id only when the manifest lacks one", async () => {
    await Pipeline.persistScopeId("other");
    expect(mockWriteManifestFile).not.toHaveBeenCalled();
    delete (manifest as { scopeId?: string }).scopeId;
    await Pipeline.persistScopeId("");
    expect(mockWriteManifestFile).not.toHaveBeenCalled();
    await Pipeline.persistScopeId("scope-9");
    expect(manifest.scopeId).toBe("scope-9");
    expect(mockWriteManifestFile).toHaveBeenCalledTimes(1);
  });
});
