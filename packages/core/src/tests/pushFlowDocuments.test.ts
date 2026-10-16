// SPDX-License-Identifier: GPL-3.0-or-later
//
// WP2: push never sends a `flow` preset document. It is skipped with a warning
// of its own rather than counted with the files the manifest cannot place.
import { jest } from "@jest/globals";
import path from "path";
import { Sync } from "@syncrona/types";

const getFileContextFromPath = jest.fn<(filePath: string) => Sync.FileContext | undefined>();
const parseUnmappedPath = jest.fn<(filePath: string) => unknown>();
const warn = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getConfig: () => ({ tablePresets: ["flow"] }),
  getSourcePath: () => path.join("repo", "src"),
  getManifest: () => ({ scope: "x_demo", tables: {} }),
}));

jest.unstable_mockModule("../FileUtils.js", () => ({
  writeManifestFile: jest.fn(),
  getFileContextFromPath: (filePath: string) => getFileContextFromPath(filePath),
  parseUnmappedPath: (filePath: string) => parseUnmappedPath(filePath),
  encodedPathsToFilePaths: jest.fn(),
}));

jest.unstable_mockModule("../downloadPipeline.js", () => ({
  findMissingFiles: jest.fn(async () => ({})),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: { warn, info: jest.fn(), error: jest.fn(), debug: jest.fn(), silly: jest.fn() },
}));

jest.unstable_mockModule("../progress.js", () => ({
  getProgTick: () => undefined,
}));

const { getAppFileListWithCandidates } = await import("../pushPipeline.js");

const flowDoc = path.join("repo", "src", "sys_hub_flow", "approve.flow.json");
const stray = path.join("repo", "src", "sys_script", "stray.js");

beforeEach(() => {
  jest.clearAllMocks();
  getFileContextFromPath.mockReturnValue(undefined);
  parseUnmappedPath.mockReturnValue(undefined);
});

describe("push and flow documents", () => {
  it.each([false, true])("skips a flow document with its own warning (create: %s)", async (create) => {
    const result = await getAppFileListWithCandidates([flowDoc, stray], { create });
    expect(result).toEqual({ records: [], candidates: [] });
    expect(getFileContextFromPath).not.toHaveBeenCalledWith(flowDoc);
    expect(parseUnmappedPath).not.toHaveBeenCalledWith(flowDoc);
    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(messages[0]).toBe(
      `1 Flow Designer document(s) are read-only and will not be pushed:\n  ${flowDoc}\n` +
        "Edit the flow in Flow Designer, then run `syncrona refresh` to update the document."
    );
    expect(messages[1]).toContain("1 file(s) are not in the manifest");
    expect(messages[1]).toContain(stray);
    expect(messages[1]).not.toContain(flowDoc);
  });

  it("says nothing about flow documents when none are pushed", async () => {
    await getAppFileListWithCandidates([stray], { create: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain("Flow Designer");
  });
});
