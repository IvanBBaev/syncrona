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
const actionDoc = path.join("repo", "src", "sys_hub_action_type_definition", "notify.action.json");
const playbookDoc = path.join("repo", "src", "sys_pd_process_definition", "onboard.playbook.json");
const workflowDoc = path.join("repo", "src", "wf_workflow", "approve_change.workflow.json");
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
        "Edit the flow or action in Flow Designer, then run `syncrona refresh` to update the document."
    );
    expect(messages[1]).toContain("1 file(s) are not in the manifest");
    expect(messages[1]).toContain(stray);
    expect(messages[1]).not.toContain(flowDoc);
  });

  it("skips an action document the same way", async () => {
    const result = await getAppFileListWithCandidates([actionDoc], { create: true });
    expect(result).toEqual({ records: [], candidates: [] });
    expect(parseUnmappedPath).not.toHaveBeenCalledWith(actionDoc);
    expect(String(warn.mock.calls[0][0])).toContain(`1 Flow Designer document(s) are read-only and will not be pushed:\n  ${actionDoc}`);
  });

  it("says nothing about flow documents when none are pushed", async () => {
    await getAppFileListWithCandidates([stray], { create: false });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).not.toContain("Flow Designer");
    expect(String(warn.mock.calls[0][0])).not.toContain("playbook");
    expect(String(warn.mock.calls[0][0])).not.toContain("workflow");
  });

  it.each([false, true])("WP2c skips a playbook document with its own warning (create: %s)", async (create) => {
    const result = await getAppFileListWithCandidates([flowDoc, playbookDoc], { create });
    expect(result).toEqual({ records: [], candidates: [] });
    expect(getFileContextFromPath).not.toHaveBeenCalledWith(playbookDoc);
    expect(parseUnmappedPath).not.toHaveBeenCalledWith(playbookDoc);
    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(messages).toHaveLength(2);
    expect(messages[0]).not.toContain(playbookDoc);
    expect(messages[1]).toBe(
      `1 playbook document(s) are read-only and will not be pushed:\n  ${playbookDoc}\n` +
        "Edit the playbook in Process Automation Designer, then run `syncrona refresh` to update the document."
    );
  });

  it.each([false, true])("WP2f skips a workflow document with its own warning (create: %s)", async (create) => {
    const result = await getAppFileListWithCandidates([playbookDoc, workflowDoc], { create });
    expect(result).toEqual({ records: [], candidates: [] });
    expect(getFileContextFromPath).not.toHaveBeenCalledWith(workflowDoc);
    expect(parseUnmappedPath).not.toHaveBeenCalledWith(workflowDoc);
    const messages = warn.mock.calls.map(([message]) => String(message));
    expect(messages).toHaveLength(2);
    expect(messages[0]).not.toContain(workflowDoc);
    expect(messages[1]).toBe(
      `1 workflow document(s) are read-only and will not be pushed:\n  ${workflowDoc}\n` +
        "Edit the workflow in the Workflow Editor, then run `syncrona refresh` to update the document."
    );
  });
});
