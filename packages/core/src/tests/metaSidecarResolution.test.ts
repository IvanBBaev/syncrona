// SPDX-License-Identifier: GPL-3.0-or-later
//
// DX22, the silent-drop half: a `.meta.json` on disk must resolve to its record
// even when the manifest carries no `.meta` entry for it.
//
// The original wiring resolved the sidecar the same way it resolves a script —
// by looking the field up in `record.files`. That works right up until a refresh
// writes a manifest without a metadata layer, which happens on any dictionary
// read that fails (timeout, 5xx, a read ACL on sys_dictionary). From that point
// getFileContextFromPath answered `undefined`, getAppFileList dropped the path
// with the invalid ones, and the push reported success over a file it never
// sent. Reproduced against a live instance: a stripped manifest built 17/17
// records with ZERO sidecars in the build tree and no error anywhere.
//
// The rule these tests pin: a sidecar belongs to the record whose directory it
// sits in. That is the whole of its identity, and no manifest entry is needed to
// establish it.
import { jest } from "@jest/globals";
import path from "path";

const getManifest = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getManifest,
  getSourcePath: jest.fn(() => "/proj/src"),
  getBuildPath: jest.fn(() => "/proj/build"),
}));

let getFileContextFromPath: typeof import("../FileUtils.js").getFileContextFromPath;
let getBuildExt: typeof import("../FileUtils.js").getBuildExt;

beforeAll(async () => {
  ({ getFileContextFromPath, getBuildExt } = await import("../FileUtils.js"));
});

/** What a refresh writes when the dictionary read failed: scripts, no metadata. */
const degradedManifest = () => ({
  scope: "x_demo",
  tables: {
    sys_script_include: {
      records: {
        IncludeA: { sys_id: "rec-1", files: [{ name: "script", type: "js" }] },
      },
    },
  },
});

/** The healthy shape, for the contrast. */
const healthyManifest = () => ({
  scope: "x_demo",
  tables: {
    sys_script_include: {
      metaFields: ["access", "active"],
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

const NESTED = path.join("/proj/src/sys_script_include/IncludeA", ".meta.json");
const FLAT = path.join("/proj/src/sys_script_include", "IncludeA~.meta.json");

describe("resolving a .meta.json against a manifest that lost its metadata layer", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("resolves the sidecar from the record, not from the record's file list", () => {
    getManifest.mockReturnValue(degradedManifest());

    const ctx = getFileContextFromPath(NESTED);

    expect(ctx).toBeDefined();
    expect(ctx?.targetField).toBe(".meta");
    expect(ctx?.sys_id).toBe("rec-1");
    expect(ctx?.tableName).toBe("sys_script_include");
    expect(ctx?.name).toBe("IncludeA");
  });

  // The flat layout is the one where the sidecar's name is an ordinary file
  // name, so nothing else in the pipeline distinguishes it.
  it("resolves the flat-encoded sidecar the same way", () => {
    getManifest.mockReturnValue(degradedManifest());

    const ctx = getFileContextFromPath(FLAT);

    expect(ctx?.targetField).toBe(".meta");
    expect(ctx?.sys_id).toBe("rec-1");
  });

  it("still resolves it when the manifest carries the .meta entry", () => {
    getManifest.mockReturnValue(healthyManifest());

    expect(getFileContextFromPath(NESTED)?.targetField).toBe(".meta");
  });

  // The record is the limit of the leniency. A path under a table or a record
  // the manifest does not have is still unmapped, and must stay unmapped — that
  // is what stops `repair --prune`'s scan and the push from adopting strays.
  it("refuses a sidecar for a record the manifest does not know", () => {
    getManifest.mockReturnValue(degradedManifest());

    expect(
      getFileContextFromPath("/proj/src/sys_script_include/Ghost/.meta.json")
    ).toBeUndefined();
    expect(
      getFileContextFromPath("/proj/src/sys_ui_page/IncludeA/.meta.json")
    ).toBeUndefined();
  });

  // An ordinary field file gets no such leniency: it names a column, and a
  // column the manifest does not list is a column push must not invent.
  it("leaves an unmapped ordinary field unresolved", () => {
    getManifest.mockReturnValue(degradedManifest());

    expect(
      getFileContextFromPath("/proj/src/sys_script_include/IncludeA/description.txt")
    ).toBeUndefined();
  });
});

describe("getBuildExt for the sidecar", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  // `.meta.json` is a constant of the format, not a property of the record, so
  // the build must not depend on the manifest having recorded it. Without this
  // the file resolved (above) and then failed to build, which is the same loss
  // one step later.
  it("answers json for .meta even with no manifest entry", () => {
    getManifest.mockReturnValue(degradedManifest());

    expect(getBuildExt("sys_script_include", "IncludeA", ".meta")).toBe("json");
  });

  it("still reads the type from the manifest when it is there", () => {
    getManifest.mockReturnValue(healthyManifest());

    expect(getBuildExt("sys_script_include", "IncludeA", ".meta")).toBe("json");
    expect(getBuildExt("sys_script_include", "IncludeA", "script")).toBe("js");
  });

  // The fallback is for the sidecar alone; an unknown ordinary field is still a
  // build error rather than a guess.
  it("throws for an ordinary field the manifest does not list", () => {
    getManifest.mockReturnValue(degradedManifest());

    expect(() => getBuildExt("sys_script_include", "IncludeA", "description")).toThrow(
      /Unable to find file/
    );
  });
});
