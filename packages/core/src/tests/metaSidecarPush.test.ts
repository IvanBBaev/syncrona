// SPDX-License-Identifier: GPL-3.0-or-later
//
// DX22, push half: an edited `.meta.json` must reach the instance.
//
// The sidecar travels through the push as the pseudo-field ".meta" — one file,
// one manifest entry, one build artifact — and is expanded into real columns at
// the last possible moment. These tests pin that expansion: what is sent, what
// is withheld, and which mistakes must fail loudly rather than answer 200.
import { jest } from "@jest/globals";
import { Sync } from "@syncrona/types";
export {};

const mockGetConfig = jest.fn();
const mockGetManifest = jest.fn();
const updateRecord = jest.fn();
const getFinalFileContents = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  getManifest: (...args: unknown[]) => mockGetManifest(...args),
}));

jest.unstable_mockModule("../PluginManager.js", () => ({
  default: {
    getFinalFileContents: (...args: unknown[]) => getFinalFileContents(...args),
  },
}));

jest.unstable_mockModule("../snClient.js", () => ({
  defaultClient: () => ({ updateRecord }),
  // The retry wrapper is not under test; run the task once and let the real
  // per-record error handling in pushRec do its job.
  retryOnErr: (task: () => unknown) => task(),
  processPushResponse: (_res: unknown, summary: string) => ({
    success: true,
    message: `${summary} pushed`,
  }),
  getErrorResponseStatus: () => undefined,
  isRetryableRequestError: () => false,
  SNClient: jest.fn(),
  resolveCredentials: jest.fn(),
  unwrapSNResponse: jest.fn(),
  unwrapTableAPIFirstItem: jest.fn(),
  unwrapTableAPIFirstItemOrEmpty: jest.fn(),
}));

// No progress bar in a test run: getProgTick's caller falls back to a no-op.
jest.unstable_mockModule("../progress.js", () => ({
  getProgTick: () => undefined,
}));

let pushFiles: typeof import("../pushPipeline.js").pushFiles;

const SIDECAR_PATH = "/proj/src/sys_script_include/IncludeA/.meta.json";
const SCRIPT_PATH = "/proj/src/sys_script_include/IncludeA/script.js";

const ctx = (filePath: string, targetField: string): Sync.FileContext => ({
  filePath,
  ext: ".json",
  name: "IncludeA",
  scope: "x_demo",
  sys_id: "rec-1",
  tableName: "sys_script_include",
  targetField,
});

const record = (fields: Record<string, Sync.FileContext>): Sync.BuildableRecord => ({
  table: "sys_script_include",
  sysId: "rec-1",
  fields,
});

const withSidecar = () =>
  record({
    script: ctx(SCRIPT_PATH, "script"),
    ".meta": ctx(SIDECAR_PATH, ".meta"),
  });

const sidecarOnly = () => record({ ".meta": ctx(SIDECAR_PATH, ".meta") });

const fileContents: Record<string, string> = {};

describe("pushing an edited .meta.json sidecar (DX22)", () => {
  beforeAll(async () => {
    ({ pushFiles } = await import("../pushPipeline.js"));
  });

  beforeEach(() => {
    jest.clearAllMocks();
    mockGetConfig.mockReturnValue({ pushConcurrency: 1 });
    mockGetManifest.mockReturnValue({
      scope: "x_demo",
      tables: {
        sys_script_include: {
          metaFields: ["access", "active", "api_name", "description"],
          metaReadOnlyFields: ["api_name"],
          records: {
            IncludeA: {
              sys_id: "rec-1",
              files: [
                { name: "script", type: "js" },
                { name: ".meta", type: "json" },
              ],
            },
          },
        },
      },
    });
    fileContents[SCRIPT_PATH] = "gs.info('a');";
    fileContents[SIDECAR_PATH] = JSON.stringify({ description: "edited" });
    getFinalFileContents.mockImplementation(async (context: unknown) =>
      fileContents[(context as Sync.FileContext).filePath]
    );
    updateRecord.mockResolvedValue({ data: { result: {} } });
  });

  it("expands the sidecar into columns alongside the field files", async () => {
    fileContents[SIDECAR_PATH] = JSON.stringify({
      description: "edited",
      access: "package_private",
    });

    const results = await pushFiles([withSidecar()]);

    expect(results[0].success).toBe(true);
    expect(updateRecord).toHaveBeenCalledWith("sys_script_include", "rec-1", {
      script: "gs.info('a');",
      description: "edited",
      access: "package_private",
    });
  });

  // ".meta" names no column. Sending it verbatim is the failure this expansion
  // exists to prevent: on a permissive instance it is a silent 200.
  it("never sends the pseudo-field itself", async () => {
    await pushFiles([withSidecar()]);

    const body = updateRecord.mock.calls[0][2] as Record<string, string>;
    expect(Object.keys(body)).not.toContain(".meta");
  });

  it("withholds a read-only column instead of failing the push", async () => {
    fileContents[SIDECAR_PATH] = JSON.stringify({
      api_name: "x_demo.IncludeA",
      active: "false",
    });

    const results = await pushFiles([sidecarOnly()]);

    expect(results[0].success).toBe(true);
    expect(updateRecord).toHaveBeenCalledWith("sys_script_include", "rec-1", {
      active: "false",
    });
  });

  // ServiceNow answers 200 to an update naming a column that does not exist, so
  // a typo must be caught here or the push reports a change that never happened.
  it("fails the record on a column the table does not track", async () => {
    fileContents[SIDECAR_PATH] = JSON.stringify({ descripton: "typo" });

    const results = await pushFiles([withSidecar()]);

    expect(results[0].success).toBe(false);
    expect(results[0].message).toMatch(/descripton/);
    expect(updateRecord).not.toHaveBeenCalled();
  });

  // One bad sidecar must not take the rest of the push down with it.
  it("keeps pushing the other records after a bad sidecar", async () => {
    fileContents[SIDECAR_PATH] = "{not json";

    const results = await pushFiles([
      sidecarOnly(),
      record({ script: ctx(SCRIPT_PATH, "script") }),
    ]);

    expect(results[0].success).toBe(false);
    expect(results[1].success).toBe(true);
    expect(updateRecord).toHaveBeenCalledTimes(1);
  });

  // The sidecar is data, not source: a "*.json" plugin rule would rewrite the
  // very bytes the expansion has to parse.
  it("reads the sidecar without running the plugin chain", async () => {
    await pushFiles([withSidecar()]);

    const calls = getFinalFileContents.mock.calls as [Sync.FileContext, boolean?][];
    const forSidecar = calls.find(([c]) => c.filePath === SIDECAR_PATH);
    const forScript = calls.find(([c]) => c.filePath === SCRIPT_PATH);
    expect(forSidecar?.[1]).toBe(false);
    expect(forScript?.[1]).toBe(true);
  });

  describe("metaPush: false", () => {
    beforeEach(() => {
      mockGetConfig.mockReturnValue({ pushConcurrency: 1, metaPush: false });
    });

    it("still pushes the field files, without the columns", async () => {
      const results = await pushFiles([withSidecar()]);

      expect(results[0].success).toBe(true);
      expect(updateRecord).toHaveBeenCalledWith("sys_script_include", "rec-1", {
        script: "gs.info('a');",
      });
    });

    // An empty body would answer 200 and be reported as a successful push of
    // nothing, which is exactly the lie this feature removes.
    it("reports nothing to push rather than PATCHing an empty body", async () => {
      const results = await pushFiles([sidecarOnly()]);

      expect(results[0].success).toBe(true);
      expect(results[0].message).toMatch(/nothing to push/);
      expect(updateRecord).not.toHaveBeenCalled();
    });
  });
});
