// SPDX-License-Identifier: GPL-3.0-or-later
//
// SDK-F2: under dataModelLayout "composite" the metadata of sys_db_object,
// sys_dictionary and sys_choice lives in the data-model documents. `push`
// refuses a stray per-record sidecar of those tables; `dev` must not push it
// either — the watcher skips it with one warning per path — while every other
// file (a field file of the same record, a sidecar of an ordinary table, or any
// sidecar under the records layout) keeps flowing to pushFiles.
import { jest } from "@jest/globals";
import path from "path";
import { Sync } from "@syncrona/types";

const mockGroupAppFiles = jest.fn((ctxs: Sync.FileContext[]) =>
  ctxs.map((c) => ({ table: c.tableName, sysId: c.sys_id, fields: {} }))
);
const mockPushFiles = jest.fn(async (recs: unknown[]) =>
  recs.map(() => ({ success: true, message: "ok" }))
);
const mockGetFileContextFromPath = jest.fn((filePath: string) => ({
  filePath,
  name: path.basename(path.dirname(filePath)),
  tableName: "sys_choice",
  targetField: ".meta",
  ext: ".json",
  sys_id: `id:${filePath}`,
  scope: "x_demo",
}));
const mockWarn = jest.fn();
let config: Record<string, unknown> = {};
const SRC = path.resolve("/work/src");

type Handler = (p: string) => void;
let handlers: Record<string, Handler> = {};

jest.unstable_mockModule("../config.js", () => ({
  getConfig: () => config,
  getSourcePath: () => SRC,
  reloadManifest: async () => undefined,
}));
jest.unstable_mockModule("../logMessages.js", () => ({ logFilePush: jest.fn() }));
jest.unstable_mockModule("../appUtils.js", () => ({
  groupAppFiles: (ctxs: Sync.FileContext[]) => mockGroupAppFiles(ctxs),
  pushFiles: (recs: unknown[]) => mockPushFiles(recs),
}));
jest.unstable_mockModule("../FileUtils.js", () => ({
  getFileContextFromPath: (p: string) => mockGetFileContextFromPath(p),
}));
jest.unstable_mockModule("../Logger.js", () => ({
  logger: { warn: (...a: unknown[]) => mockWarn(...a), info: jest.fn(), error: jest.fn() },
}));
jest.unstable_mockModule("chokidar", () => ({
  __esModule: true,
  watch: () => ({
    on: (event: string, handler: Handler) => {
      handlers[event] = handler;
    },
    close: async () => undefined,
  }),
}));

let startWatching: typeof import("../Watcher.js").startWatching;
let stopWatching: typeof import("../Watcher.js").stopWatching;

beforeAll(async () => {
  ({ startWatching, stopWatching } = await import("../Watcher.js"));
});

const flush = async (): Promise<void> => {
  jest.advanceTimersByTime(350);
  for (let i = 0; i < 5; i += 1) await Promise.resolve();
};

const ALL = ["sys_db_object", "sys_dictionary", "sys_choice"];
const STRAY = path.join(SRC, "sys_choice", "x_demo_task.u_foo.1", ".meta.json");
const STRAY_FLAT = path.join(SRC, "sys_dictionary", "x_demo_task.u_foo~.meta.json");
const FIELD = path.join(SRC, "sys_dictionary", "x_demo_task.u_foo", "calculation.js");
const ORDINARY = path.join(SRC, "sys_script_include", "Foo", ".meta.json");

const pushedPaths = () =>
  mockGetFileContextFromPath.mock.calls.map((c) => c[0]);

beforeEach(() => {
  jest.useFakeTimers();
  jest.clearAllMocks();
  handlers = {};
  config = { dataModelLayout: "composite", dataModelTables: ALL };
  startWatching(SRC);
});

afterEach(async () => {
  await stopWatching();
  jest.useRealTimers();
});

describe("dev under the composite layout", () => {
  it("skips a stray per-record sidecar of a composite table, warning once per path", async () => {
    handlers.change(STRAY);
    handlers.change(STRAY_FLAT);
    await flush();
    handlers.change(STRAY);
    await flush();
    expect(pushedPaths()).toEqual([]);
    expect(mockPushFiles.mock.calls.every(([recs]) => recs.length === 0)).toBe(true);
    const warnings = mockWarn.mock.calls.map((c) => String(c[0]));
    expect(warnings).toHaveLength(2);
    expect(warnings[0]).toContain(
      `${STRAY} is a per-record sidecar, but dataModelLayout is "composite": ` +
        "sys_choice metadata lives in the data-model documents."
    );
    expect(warnings[0]).toMatch(/will not be pushed[\s\S]*Keep one layout per record/);
    expect(warnings[1]).toContain(`${STRAY_FLAT} is a per-record sidecar`);
  });

  it("skips a newly added stray sidecar instead of queueing it", async () => {
    handlers.add(STRAY);
    await flush();
    expect(pushedPaths()).toEqual([]);
    expect(String(mockWarn.mock.calls[0][0])).toContain(`${STRAY} is a per-record sidecar`);
  });

  it("still pushes field files and sidecars of tables the documents do not cover", async () => {
    handlers.change(FIELD);
    handlers.change(ORDINARY);
    await flush();
    expect(pushedPaths().sort()).toEqual([FIELD, ORDINARY].sort());
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("pushes the same sidecar under the records layout", async () => {
    config = { dataModelTables: ALL };
    handlers.change(STRAY);
    await flush();
    expect(pushedPaths()).toEqual([STRAY]);
    expect(mockWarn).not.toHaveBeenCalled();
  });

  it("pushes it when the config cannot be read", async () => {
    config = undefined as unknown as Record<string, unknown>;
    handlers.change(STRAY);
    await flush();
    expect(pushedPaths()).toEqual([STRAY]);
  });
});
