// SPDX-License-Identifier: GPL-3.0-or-later
//
// DX22 regression, second half: routing the sidecar FETCH.
//
// Labelling the manifest is not enough. `.meta` names no column, and the scoped
// bulk endpoint projects the requested names straight onto a GlideRecord — ask
// x_nuvo_sinc for it and the record comes back with no content for it, no file
// is written, and the next run finds the same record missing again. So the
// sidecar half of every request has to leave the scoped endpoint alone and go
// through the Table API, which is the only path that knows how to read those
// columns and serialize them.
//
// These tests pin that split, the merge of the two halves, and the enrichment
// call on the refresh path itself.
import { jest } from "@jest/globals";
import { SN } from "@syncrona/types";
import { META_FILE_NAME } from "../metaFields.js";

const writtenFiles: { table: string; record: string; file: string }[] = [];

const createDirRecursively = jest.fn(async () => undefined);
const writeSNFileCurry = jest.fn(
  () => async (file: SN.File, parentPath: string) => {
    const parts = parentPath.split("/");
    writtenFiles.push({
      table: parts[parts.length - 2] ?? "",
      record: parts[parts.length - 1] ?? "",
      file: file.name,
    });
  }
);
const writeFlatSNFileCurry = jest.fn(() => async () => undefined);
const writeFileForce = jest.fn(async () => undefined);
const writeManifestFile = jest.fn(async () => undefined);
const pathExists = jest.fn(async (_p: string) => false);
const SNFileExists = jest.fn(() => async (_file: SN.File) => false);

const getSourcePath = jest.fn(() => "/src");
const getManifestPath = jest.fn(() => "/tmp/manifest.json");
const getConfig = jest.fn(() => ({ tableOptions: {} }) as Record<string, unknown>);
const updateManifest = jest.fn();
const getManifest = jest.fn();

const getManifestApi = jest.fn();
const getMissingFilesApi = jest.fn();
const mockBuildBulkDownloadFromTableAPI = jest.fn();
const mockBuildManifestFromTableAPI = jest.fn();
const mockAttachMetaFieldsToManifest = jest.fn(async (manifest: unknown) => manifest);

jest.unstable_mockModule("../FileUtils.js", () => ({
  createDirRecursively,
  writeSNFileCurry: (...a: unknown[]) =>
    (writeSNFileCurry as (...x: unknown[]) => unknown)(...a),
  writeFlatSNFileCurry,
  writeFileForce,
  writeManifestFile,
  pathExists: (...a: unknown[]) => (pathExists as (...x: unknown[]) => unknown)(...a),
  SNFileExists: (...a: unknown[]) => (SNFileExists as (...x: unknown[]) => unknown)(...a),
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
  defaultClient: () => ({
    getManifest: getManifestApi,
    getMissingFiles: getMissingFilesApi,
  }),
  unwrapSNResponse: async (p: Promise<{ data: { result: unknown } }>) =>
    (await p).data.result,
}));

jest.unstable_mockModule("../manifestBuilder.js", () => ({
  attachMetaFieldsToManifest: (...a: unknown[]) =>
    (mockAttachMetaFieldsToManifest as (...x: unknown[]) => unknown)(...a),
  buildManifestFromTableAPI: (...a: unknown[]) =>
    (mockBuildManifestFromTableAPI as (...x: unknown[]) => unknown)(...a),
  buildBulkDownloadFromTableAPI: (...a: unknown[]) =>
    (mockBuildBulkDownloadFromTableAPI as (...x: unknown[]) => unknown)(...a),
  isScopedEndpointUnavailableError: (e: unknown) => {
    const err = e as { response?: { status?: number } } | null;
    return Boolean(err && [400, 403, 404].includes(err.response?.status as number));
  },
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

// One enriched table: the file field plus the sidecar the enrichment attached.
const enrichedManifest = (): SN.AppManifest => ({
  scope: "x_demo",
  tables: {
    sys_script_include: {
      metaFields: ["access", "api_name"],
      records: {
        IncludeA: {
          name: "IncludeA",
          sys_id: "rec-1",
          files: [
            { name: "script", type: "js" },
            { name: META_FILE_NAME, type: "json" },
          ],
        },
      },
    },
  },
});

type MissingMap = Record<string, Record<string, SN.File[]>>;

const fileNamesIn = (missing: MissingMap): string[] =>
  Object.values(missing)
    .flatMap((records) => Object.values(records))
    .flatMap((files) => files.map((f) => f.name));

beforeEach(() => {
  writtenFiles.length = 0;
  jest.clearAllMocks();
  pathExists.mockImplementation(async () => false);
  SNFileExists.mockImplementation(() => async () => false);
  mockAttachMetaFieldsToManifest.mockImplementation(async (m: unknown) => m);
});

describe("the sidecar half never reaches the scoped bulk endpoint", () => {
  it("splits the request: file fields to getMissingFiles, .meta to the Table API", async () => {
    getMissingFilesApi.mockImplementation(async () => ({
      data: {
        result: {
          sys_script_include: {
            records: {
              IncludeA: {
                name: "IncludeA",
                sys_id: "rec-1",
                files: [{ name: "script", type: "js", content: "gs.info('a');" }],
              },
            },
          },
        },
      },
    }));
    mockBuildBulkDownloadFromTableAPI.mockImplementation(async () => ({
      sys_script_include: {
        records: {
          IncludeA: {
            name: "IncludeA",
            sys_id: "rec-1",
            files: [{ name: META_FILE_NAME, type: "json", content: "{}" }],
          },
        },
      },
    }));

    const { processMissingFiles } = await import("../downloadPipeline.js");
    const incomplete = await processMissingFiles(enrichedManifest());

    // The bug in one assertion: before the split, ".meta" went out to a scoped
    // endpoint that cannot answer it.
    const scopedRequest = getMissingFilesApi.mock.calls[0]?.[0] as MissingMap;
    expect(fileNamesIn(scopedRequest)).toEqual(["script"]);

    const tableApiRequest = mockBuildBulkDownloadFromTableAPI.mock.calls[0]?.[0] as MissingMap;
    expect(fileNamesIn(tableApiRequest)).toEqual([META_FILE_NAME]);
    // …and it is given the manifest's metaFields, or it could not project them.
    expect(mockBuildBulkDownloadFromTableAPI.mock.calls[0]?.[4]).toEqual({
      sys_script_include: ["access", "api_name"],
    });

    // Both halves are merged into one table for the writer, so the record ends
    // up with its script AND its sidecar rather than whichever arrived last.
    expect(writtenFiles.map((w) => w.file).sort()).toEqual([META_FILE_NAME, "script"]);
    expect(incomplete).toEqual([]);
  });

  it("asks the Table API only, and only once, when the record needs just the sidecar", async () => {
    // The steady state after the first refresh: scripts already on disk, the
    // sidecar new. Nothing is missing on the scoped side, so it must not be
    // called at all rather than called with an empty map.
    SNFileExists.mockImplementation(
      () => async (file: SN.File) => file.name !== META_FILE_NAME
    );
    pathExists.mockImplementation(async () => true);
    mockBuildBulkDownloadFromTableAPI.mockImplementation(async () => ({
      sys_script_include: {
        records: {
          IncludeA: {
            name: "IncludeA",
            sys_id: "rec-1",
            files: [{ name: META_FILE_NAME, type: "json", content: "{}" }],
          },
        },
      },
    }));

    const { processMissingFiles } = await import("../downloadPipeline.js");
    await processMissingFiles(enrichedManifest());

    expect(getMissingFilesApi).not.toHaveBeenCalled();
    expect(mockBuildBulkDownloadFromTableAPI).toHaveBeenCalledTimes(1);
    expect(writtenFiles.map((w) => w.file)).toEqual([META_FILE_NAME]);
  });

  it("keeps the sidecar when the scoped half answers without the table at all", async () => {
    // The scoped endpoint is free to answer with fewer tables than were asked
    // for — a record the caller may not read comes back missing rather than as
    // an error. The merge has to carry the Table API's half through instead of
    // dropping it because the base map has no entry to merge it into.
    getMissingFilesApi.mockImplementation(async () => ({ data: { result: {} } }));
    mockBuildBulkDownloadFromTableAPI.mockImplementation(async () => ({
      sys_script_include: {
        records: {
          IncludeA: {
            name: "IncludeA",
            sys_id: "rec-1",
            files: [{ name: META_FILE_NAME, type: "json", content: "{}" }],
          },
        },
      },
    }));

    const { processMissingFiles } = await import("../downloadPipeline.js");
    await processMissingFiles(enrichedManifest());

    expect(writtenFiles.map((w) => w.file)).toEqual([META_FILE_NAME]);
  });

  it("splits the same way on the download path, not just on refresh", async () => {
    // `download` builds its missing map from the whole manifest rather than
    // from what is absent on disk, and it fetches through its own copy of the
    // strategy. The routing has to be the same one or a first-time download —
    // the very command a new project runs — writes scripts and no sidecars.
    getMissingFilesApi.mockImplementation(async () => ({
      data: {
        result: {
          sys_script_include: {
            records: {
              IncludeA: {
                name: "IncludeA",
                sys_id: "rec-1",
                files: [{ name: "script", type: "js", content: "gs.info('a');" }],
              },
            },
          },
        },
      },
    }));
    mockBuildBulkDownloadFromTableAPI.mockImplementation(async () => ({
      sys_script_include: {
        records: {
          IncludeA: {
            name: "IncludeA",
            sys_id: "rec-1",
            files: [{ name: META_FILE_NAME, type: "json", content: "{}" }],
          },
        },
      },
    }));

    const { downloadAllFiles } = await import("../downloadPipeline.js");
    await downloadAllFiles(enrichedManifest());

    const scopedRequest = getMissingFilesApi.mock.calls[0]?.[0] as MissingMap;
    expect(fileNamesIn(scopedRequest)).toEqual(["script"]);
    const tableApiRequest = mockBuildBulkDownloadFromTableAPI.mock.calls[0]?.[0] as MissingMap;
    expect(fileNamesIn(tableApiRequest)).toEqual([META_FILE_NAME]);
    expect(writtenFiles.map((w) => w.file).sort()).toEqual([META_FILE_NAME, "script"]);
  });

  it("re-throws a failure that is not a missing scoped app", async () => {
    // The latch exists to stop probing an endpoint that is gone. A 500 is not
    // that: falling back on it would turn a broken instance into a slow, silent
    // Table-API crawl instead of a failed run the caller can see.
    getMissingFilesApi.mockImplementation(async () => {
      throw { response: { status: 500 } };
    });
    mockBuildBulkDownloadFromTableAPI.mockImplementation(async () => ({}));

    const { processMissingFiles } = await import("../downloadPipeline.js");
    await expect(processMissingFiles(enrichedManifest())).rejects.toMatchObject({
      response: { status: 500 },
    });
  });

  it("sends the whole request through the Table API once the scoped app is gone", async () => {
    getMissingFilesApi.mockImplementation(async () => {
      throw { response: { status: 404 } };
    });
    mockBuildBulkDownloadFromTableAPI.mockImplementation(
      async (missing: unknown) => ({
        sys_script_include: {
          records: {
            IncludeA: {
              name: "IncludeA",
              sys_id: "rec-1",
              files: Object.values(
                Object.values(missing as MissingMap)[0]
              )[0].map((f) => ({ ...f, content: "x" })),
            },
          },
        },
      })
    );

    const { processMissingFiles } = await import("../downloadPipeline.js");
    await processMissingFiles(enrichedManifest());

    // Two calls: the sidecar half always goes there, and the file half falls
    // back after the 404. The merged result still carries both files.
    expect(mockBuildBulkDownloadFromTableAPI).toHaveBeenCalledTimes(2);
    expect(writtenFiles.map((w) => w.file).sort()).toEqual([META_FILE_NAME, "script"]);
  });
});

describe("merging the two halves under instance-supplied record names", () => {
  // A record's name is instance data — the display value of a row somebody
  // created — so `__proto__` and `constructor` are both names a person can type
  // into a Script Include. The two halves of a DX22 fetch are merged by keying
  // records on that name, and the merge both looked the key up and assigned it
  // through the prototype chain. The two neighbouring functions in this file
  // (partitionMetaRequests, buildManifestRecordNames) each carry an INJ-2 note
  // saying exactly why they must not; the merge between them did not.
  //
  // This is the steady state of an upgrade, not an exotic one: the scripts are
  // already on disk and only the sidecars are missing, so the scoped half
  // answers for one record and the Table-API half answers for all of them.
  const strayManifest = (): SN.AppManifest =>
    JSON.parse(`{
      "scope": "x_demo",
      "tables": {
        "sys_script_include": {
          "metaFields": ["access"],
          "records": {
            "IncludeA": { "name": "IncludeA", "sys_id": "rec-1", "files": [
              { "name": "script", "type": "js" },
              { "name": "${META_FILE_NAME}", "type": "json" }] },
            "__proto__": { "name": "__proto__", "sys_id": "rec-2", "files": [
              { "name": "script", "type": "js" },
              { "name": "${META_FILE_NAME}", "type": "json" }] },
            "constructor": { "name": "constructor", "sys_id": "rec-3", "files": [
              { "name": "script", "type": "js" },
              { "name": "${META_FILE_NAME}", "type": "json" }] }
          }
        }
      }
    }`);

  // Built by JSON.parse rather than as a literal on purpose: `{ __proto__: x }`
  // in source sets the prototype instead of creating the own property the
  // instance's answer would actually carry, so a literal would test the wrong
  // object.
  const sidecarHalf = () =>
    JSON.parse(`{
      "sys_script_include": { "records": {
        "IncludeA": { "name": "IncludeA", "sys_id": "rec-1", "files": [
          { "name": "${META_FILE_NAME}", "type": "json", "content": "{}" }] },
        "__proto__": { "name": "__proto__", "sys_id": "rec-2", "files": [
          { "name": "${META_FILE_NAME}", "type": "json", "content": "{}" }] },
        "constructor": { "name": "constructor", "sys_id": "rec-3", "files": [
          { "name": "${META_FILE_NAME}", "type": "json", "content": "{}" }] }
      } }
    }`);

  beforeEach(() => {
    pathExists.mockImplementation(async () => true);
    // Only IncludeA is new; the other two already have their script on disk and
    // are missing nothing but the sidecar.
    SNFileExists.mockImplementation(
      (parentPath: string) => async (file: SN.File) =>
        !parentPath.endsWith("/IncludeA") && file.name !== META_FILE_NAME
    );
    getMissingFilesApi.mockImplementation(async () => ({
      data: {
        result: {
          sys_script_include: {
            records: {
              IncludeA: {
                name: "IncludeA",
                sys_id: "rec-1",
                files: [{ name: "script", type: "js", content: "gs.info('a');" }],
              },
            },
          },
        },
      },
    }));
    mockBuildBulkDownloadFromTableAPI.mockImplementation(async () => sidecarHalf());
  });

  it("writes the sidecar of a record the scoped half did not return, whatever it is named", async () => {
    const { processMissingFiles } = await import("../downloadPipeline.js");
    await processMissingFiles(strayManifest());

    expect(
      writtenFiles
        .filter((w) => w.file === META_FILE_NAME)
        .map((w) => w.record)
        .sort()
    ).toEqual(["IncludeA", "__proto__", "constructor"]);
  });

  it("keeps the record's own identity instead of merging it into a prototype member", async () => {
    // The `constructor` half of the same bug fails the other way: the lookup
    // found Object itself, so the merge produced `{ files: [...] }` with no
    // sys_id and no name — a record the writer cannot place and the manifest
    // cannot address.
    const { processMissingFiles } = await import("../downloadPipeline.js");
    await processMissingFiles(strayManifest());

    expect(writtenFiles).toContainEqual({
      table: "sys_script_include",
      record: "constructor",
      file: META_FILE_NAME,
    });
    // …and IncludeA still gets both halves concatenated, which is the merge's
    // actual job.
    expect(
      writtenFiles.filter((w) => w.record === "IncludeA").map((w) => w.file).sort()
    ).toEqual([META_FILE_NAME, "script"]);
  });
});

describe("refresh enriches the scoped manifest", () => {
  it("calls attachMetaFieldsToManifest on the manifest the scoped app returned", async () => {
    const scoped: SN.AppManifest = {
      scope: "x_demo",
      tables: {
        sys_script_include: {
          records: {
            IncludeA: {
              name: "IncludeA",
              sys_id: "rec-1",
              files: [{ name: "script", type: "js" }],
            },
          },
        },
      },
    };
    getManifest.mockImplementation(async () => ({ scope: "x_demo", tables: {} }));
    getManifestApi.mockImplementation(async () => ({ data: { result: scoped } }));
    getMissingFilesApi.mockImplementation(async () => ({
      data: { result: { sys_script_include: { records: {} } } },
    }));

    const { syncManifest } = await import("../downloadPipeline.js");
    await expect(syncManifest()).resolves.toBe(true);

    // The bug: this call did not exist, so every scoped-app user refreshed into
    // a workspace with no metadata at all.
    expect(mockAttachMetaFieldsToManifest).toHaveBeenCalledTimes(1);
    expect(mockAttachMetaFieldsToManifest.mock.calls[0]?.[0]).toBe(scoped);
    // The enrichment runs BEFORE the manifest is written, or the file on disk
    // and the tree beside it would disagree about what a record contains.
    expect(writeManifestFile).toHaveBeenCalledWith(scoped);
  });

  it("does not re-run the dictionary sweep over a Table-API build", async () => {
    getManifest.mockImplementation(async () => ({ scope: "x_demo", tables: {} }));
    getManifestApi.mockImplementation(async () => {
      throw { response: { status: 404 } };
    });
    mockBuildManifestFromTableAPI.mockImplementation(async () => ({
      scope: "x_demo",
      tables: {},
    }));

    const { syncManifest } = await import("../downloadPipeline.js");
    await expect(syncManifest()).resolves.toBe(true);

    // buildManifestFromTableAPI already discovered the columns while it walked
    // each table; enriching again would re-query the dictionary for every table
    // it had just decided has no metadata.
    expect(mockBuildManifestFromTableAPI).toHaveBeenCalledTimes(1);
    expect(mockAttachMetaFieldsToManifest).not.toHaveBeenCalled();
  });
});
