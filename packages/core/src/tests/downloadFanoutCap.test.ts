// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import { SN } from "@syncrona/types";

// REV-89 (PERF-1) / REV-97 (PERF-4): the download/refresh writer and the
// missing-file existence probe must bound their filesystem-handle fan-out.
// Before the fix each ran an unbounded Promise.all across tables×records×files,
// opening one handle per file at once (EMFILE risk on a large scope). These
// tests inject a small cap via `config.writeConcurrency` and assert the peak
// number of in-flight writes / stats never exceeds it. The OLD unbounded code
// peaks at N (== the number of files/records), so it fails these assertions.

const CAP = 4;
const N = 20; // comfortably larger than CAP so a bound is observable

let writeInFlight = 0;
let writePeak = 0;
let statInFlight = 0;
let statPeak = 0;

// A write that records its own concurrency so the pool's peak is observable.
const writeImpl = async () => {
  writeInFlight += 1;
  writePeak = Math.max(writePeak, writeInFlight);
  await new Promise((resolve) => setTimeout(resolve, 5));
  writeInFlight -= 1;
};
// A stat that records its own concurrency the same way.
const statImpl = async (_p: string) => {
  statInFlight += 1;
  statPeak = Math.max(statPeak, statInFlight);
  await new Promise((resolve) => setTimeout(resolve, 5));
  statInFlight -= 1;
  return true;
};

const createDirRecursively = jest.fn(async () => undefined);
const writeSNFileCurry = jest.fn(() => writeImpl);
const writeFlatSNFileCurry = jest.fn(() => async () => undefined);
const writeFileForce = jest.fn(async () => undefined);
const writeManifestFile = jest.fn(async () => undefined);
const pathExists = jest.fn(statImpl);
const SNFileExists = jest.fn(() => async (_file: SN.File) => true);

const getSourcePath = jest.fn(() => "/src");
const getManifestPath = jest.fn(() => "/tmp/manifest.json");
const getConfig = jest.fn(
  () => ({ writeConcurrency: CAP }) as Record<string, unknown>
);
const updateManifest = jest.fn();
const getManifest = jest.fn();

jest.unstable_mockModule("../FileUtils.js", () => ({
  createDirRecursively,
  writeSNFileCurry,
  writeFlatSNFileCurry,
  writeFileForce,
  writeManifestFile,
  pathExists: (...a: unknown[]) =>
    (pathExists as (...x: unknown[]) => unknown)(...a),
  SNFileExists: (...a: unknown[]) =>
    (SNFileExists as (...x: unknown[]) => unknown)(...a),
  appendToPath: (prefix: string) => (suffix: string) => `${prefix}/${suffix}`,
}));

jest.unstable_mockModule("../config.js", () => ({
  getSourcePath,
  getManifestPath,
  getConfig,
  updateManifest,
  getManifest,
}));

jest.unstable_mockModule("../snClient.js", () => ({
  getErrorResponseStatus: jest.fn(),
  isRetryableRequestError: jest.fn(),
  processPushResponse: jest.fn(),
  retryOnErr: jest.fn(),
  SNClient: jest.fn(),
  unwrapTableAPIFirstItem: jest.fn(),
  unwrapTableAPIFirstItemOrEmpty: jest.fn(),
  defaultClient: () => ({ getManifest: jest.fn(), getMissingFiles: jest.fn() }),
  unwrapSNResponse: async (p: Promise<{ data: { result: unknown } }>) =>
    (await p).data.result,
}));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  buildManifestFromTableAPI: jest.fn(),
  buildBulkDownloadFromTableAPI: jest.fn(),
  isScopedEndpointUnavailableError: () => false,
}));

jest.unstable_mockModule("../downloadCheckpoint.js", () => ({
  DownloadCheckpoint: jest.fn(),
  readDownloadCheckpoint: jest.fn(async () => null),
  writeDownloadCheckpoint: jest.fn(async () => undefined),
  deleteDownloadCheckpoint: jest.fn(async () => undefined),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    info: jest.fn(),
    debug: jest.fn(),
    error: jest.fn(),
    success: jest.fn(),
    warn: jest.fn(),
  },
}));

beforeEach(() => {
  jest.clearAllMocks();
  writeInFlight = 0;
  writePeak = 0;
  statInFlight = 0;
  statPeak = 0;
  getConfig.mockReturnValue({ writeConcurrency: CAP });
  writeSNFileCurry.mockImplementation(() => writeImpl);
  writeFlatSNFileCurry.mockImplementation(() => async () => undefined);
  pathExists.mockImplementation(statImpl);
  SNFileExists.mockImplementation(() => async (_file: SN.File) => true);
});

// One table, one record, N field files → the file pool is the only fan-out, so
// the writer's peak concurrency is exactly what we are bounding.
function singleTableManyFiles(): SN.TableMap {
  const files = Array.from({ length: N }, (_, i) => ({
    name: `field${i}`,
    type: "js",
    content: `x${i}`,
  }));
  return {
    sys_script: {
      records: { rec1: { name: "rec1", sys_id: "s1", files } },
    },
  } as unknown as SN.TableMap;
}

// One table, N records that each exist on disk → the record-directory probe is
// the only fan-out, so the stat's peak concurrency is what we are bounding.
function singleTableManyRecords(): SN.AppManifest {
  const records: Record<string, unknown> = {};
  for (let i = 0; i < N; i += 1) {
    records[`rec${i}`] = {
      name: `rec${i}`,
      sys_id: `s${i}`,
      files: [{ name: "script", type: "js" }],
    };
  }
  return {
    scope: "x_test",
    tables: { sys_script: { records } },
  } as unknown as SN.AppManifest;
}

describe("download writer fan-out cap (REV-89)", () => {
  it("never opens more than the configured number of file writes at once", async () => {
    const { processTablesInManifest } = await import("../appUtils.js");
    await processTablesInManifest(singleTableManyFiles(), true);

    // Every file was written, but never more than CAP writes were in flight at
    // once. The old unbounded Promise.all opened all N at once (writePeak === N).
    expect(writeSNFileCurry).toHaveBeenCalledTimes(N);
    expect(writePeak).toBeGreaterThan(0);
    expect(writePeak).toBeLessThanOrEqual(CAP);
  });
});

describe("missing-file probe fan-out cap (REV-97)", () => {
  it("never stats more than the configured number of record dirs at once", async () => {
    const { findMissingFiles } = await import("../appUtils.js");
    await findMissingFiles(singleTableManyRecords());

    // 1 table dir + N record dirs are probed via pathExists; the record-level
    // probe is bounded by CAP. The old unbounded code peaked at N.
    expect(pathExists).toHaveBeenCalledTimes(N + 1);
    expect(statPeak).toBeGreaterThan(0);
    expect(statPeak).toBeLessThanOrEqual(CAP);
  });
});
