// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import { Sync } from "@syncrona/types";

export {};

// REV-99 (PERF-6): buildFiles used to fan out with an unbounded Promise.all —
// one plugin build + file-write chain per record all in flight at once, so a
// large scope could exhaust file descriptors and thrash the event loop. It now
// routes through the same bounded mapWithConcurrency helper pushFiles uses,
// capped at the resolved push-concurrency limit. This test instruments the
// per-record build seam (PluginManager.getFinalFileContents) with an in-flight
// counter and proves the peak concurrency never exceeds the configured cap even
// when there are far more records than the cap. Against the old unbounded code
// the peak would equal the record count (25) and blow past the cap (4).

const CAP = 4;
const RECORD_COUNT = 25;

let inFlight = 0;
let peakInFlight = 0;
const getFinalFileContents = jest.fn(async (context: Sync.FileContext) => {
  inFlight += 1;
  peakInFlight = Math.max(peakInFlight, inFlight);
  // Hold the slot across a real async boundary so overlapping builds are
  // observable; the unbounded version would open all of them simultaneously.
  await new Promise((resolve) => setTimeout(resolve, 8));
  inFlight -= 1;
  return `built:${context.targetField}`;
});

jest.unstable_mockModule("../PluginManager.js", () => ({
  __esModule: true,
  default: {
    getFinalFileContents: (...args: unknown[]) =>
      getFinalFileContents(...(args as [Sync.FileContext])),
  },
}));

// writeBuildFile touches these; keep them in-memory so nothing hits the disk.
jest.unstable_mockModule("../FileUtils.js", () => ({
  getFileContextFromPath: jest.fn(),
  encodedPathsToFilePaths: jest.fn(),
  getBuildExt: jest.fn(() => "js"),
  createDirRecursively: jest.fn(async () => undefined),
  writeFileForce: jest.fn(async () => undefined),
}));

const mockGetConfig = jest.fn();
jest.unstable_mockModule("../config.js", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
  getSourcePath: () => "/proj/src",
  getBuildPath: () => "/proj/build",
}));

jest.unstable_mockModule("../progress.js", () => ({
  getProgTick: () => undefined,
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    getLogLevel: () => "info",
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

// pushPipeline imports the SN client at module load; stub the IO surface so the
// import graph stays hermetic (buildFiles never calls any of these).
jest.unstable_mockModule("../snClient.js", () => ({
  isRetryableRequestError: jest.fn(),
  processPushResponse: jest.fn(),
  retryOnErr: jest.fn(),
  SNClient: jest.fn(),
  defaultClient: jest.fn(),
  getErrorResponseStatus: jest.fn(),
}));

// jest.unstable_mockModule does not hoist under ESM: import the SUT dynamically
// after the mocks are registered.
let buildFiles: typeof import("../pushPipeline.js").buildFiles;

const makeRecord = (i: number): Sync.BuildableRecord => ({
  table: "sys_script",
  sysId: `rec_${i}`,
  fields: {
    script: {
      filePath: `/proj/src/sys_script/rec_${i}/script.js`,
      name: `rec_${i}`,
      tableName: "sys_script",
      targetField: "script",
      ext: ".js",
      sys_id: `rec_${i}`,
      scope: "x_test_app",
    },
  },
});

describe("buildFiles concurrency cap (REV-99 / PERF-6)", () => {
  beforeEach(async () => {
    inFlight = 0;
    peakInFlight = 0;
    jest.clearAllMocks();
    mockGetConfig.mockReturnValue({ pushConcurrency: CAP });
    ({ buildFiles } = await import("../pushPipeline.js"));
  });

  it("never runs more than the configured push-concurrency builds at once", async () => {
    const records = Array.from({ length: RECORD_COUNT }, (_, i) => makeRecord(i));

    const results = await buildFiles(records);

    // Every record was built and written successfully, in order.
    expect(results).toHaveLength(RECORD_COUNT);
    expect(results.every((r) => r.success)).toBe(true);
    expect(getFinalFileContents).toHaveBeenCalledTimes(RECORD_COUNT);

    // The regression: the old unbounded Promise.all opened all 25 builds at
    // once (peak === 25). The bounded fan-out holds the peak at or below the cap.
    expect(peakInFlight).toBeLessThanOrEqual(CAP);
    // ...while still parallelising up to the cap (not accidentally serialised).
    expect(peakInFlight).toBeGreaterThan(1);
  });
});
