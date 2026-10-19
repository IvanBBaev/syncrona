// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import {
  logFilePush,
  logPushResults,
  logBuildResults,
  scopeCheckMessage,
  devModeLog,
} from "../logMessages.js";
import { logger } from "../Logger.js";

// logMessages.ts is pure presentation: every function fans out to logger.* /
// the internal winston logger with chalk-formatted text. We spy on those sinks
// and assert the meaningful substrings (color codes are stripped when chalk
// detects no TTY) plus the branch each function takes (success vs. failure,
// error present vs. absent, all-success early return, single-failure path).
describe("logMessages", () => {
  let infoSpy: jest.SpyInstance;
  let errorSpy: jest.SpyInstance;
  let internalInfo: jest.Mock;
  let internalError: jest.Mock;

  beforeEach(() => {
    infoSpy = jest.spyOn(logger, "info").mockImplementation(() => undefined);
    errorSpy = jest.spyOn(logger, "error").mockImplementation(() => undefined);
    internalInfo = jest.fn();
    internalError = jest.fn();
    jest
      .spyOn(logger, "getInternalLogger")
       
      .mockReturnValue({ info: internalInfo, error: internalError } as any);
  });

  afterEach(() => jest.restoreAllMocks());

  const infoText = (): string =>
    infoSpy.mock.calls.map((c) => String(c[0])).join("\n");
  const errorText = (): string =>
    errorSpy.mock.calls.map((c) => String(c[0])).join("\n");
  const internalErrorText = (): string =>
    internalError.mock.calls.map((c) => String(c[0])).join("\n");

  it("scopeCheckMessage logs an error naming both scopes", () => {
    scopeCheckMessage({
      match: false,
      sessionScope: "x_sess",
      manifestScope: "x_man",
    });
    expect(errorSpy).toHaveBeenCalledTimes(1);
    expect(errorText()).toContain("x_sess");
    expect(errorText()).toContain("x_man");
  });

  it("devModeLog logs the watch banner", () => {
    devModeLog();
    expect(infoSpy).toHaveBeenCalledTimes(1);
    expect(infoText()).toContain("Dev mode started");
  });

  it("logFilePush logs a pushed status on success and no error line", () => {
    logFilePush(
       
      { tableName: "sys_script", name: "rec", targetField: "script" } as any,
       
      { success: true, message: "" } as any
    );
    expect(errorSpy).not.toHaveBeenCalled();
    const out = infoText();
    expect(out).toContain("File Push Summary");
    expect(out).toContain("sys_script");
    expect(out).toContain("Pushed");
    for (const label of ["When:", "Table:", "Record:", "Field:", "Status:"]) {
      expect(out).toContain(label);
    }
    // The summary ends with a blank spacer line.
    expect(infoSpy.mock.calls[infoSpy.mock.calls.length - 1][0]).toBe("");
  });

  it("logFilePush logs a failure status and the error message on failure", () => {
    logFilePush(
       
      { tableName: "t", name: "r", targetField: "f" } as any,
       
      { success: false, message: "boom" } as any
    );
    expect(infoText()).toContain("Failed to push");
    expect(errorSpy).toHaveBeenCalledWith("boom");
  });

  it("logPushResults prints totals and returns early when all pushes succeed", () => {
     
    logPushResults([{ success: true, message: "" }] as any);
    expect(internalInfo).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(internalError).not.toHaveBeenCalled();
  });

  it("logPushResults prints an error summary when a push fails", () => {
    logPushResults([
       
      { success: true, message: "" },
       
      { success: false, message: "nope" },
    ] as never);
    expect(errorSpy).toHaveBeenCalled();
    expect(errorText()).toContain("Error Summary");
    expect(internalErrorText()).toContain("nope");
  });

  it("logPushResults prints a lone failure once, unnumbered", () => {
    logPushResults([{ success: false, message: "only" }] as never);
    expect(internalError.mock.calls.map((c) => c[0])).toEqual(["only"]);
  });

  it("logPushResults numbers each failure once when several fail", () => {
    logPushResults([
      { success: false, message: "first" },
      { success: false, message: "second" },
    ] as never);
    expect(internalError.mock.calls.map((c) => c[0])).toEqual(["1. first", "2. second"]);
  });

  it("logBuildResults prints totals for the Builds operation", () => {
     
    logBuildResults([{ success: false, message: "bad" }] as any);
    expect(internalInfo).toHaveBeenCalled();
    expect(errorText()).toContain("Error Summary");
  });

  it("prints the total, success and failure counts with the operation name", () => {
    logPushResults([
      { success: true, message: "" },
      { success: true, message: "" },
      { success: false, message: "x" },
    ] as never);
    const lines = internalInfo.mock.calls.map((c) => String(c[0]));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toMatch(/Total Records:.*3/);
    expect(lines[1]).toMatch(/Successful Pushes:.*2/);
    expect(lines[2]).toMatch(/Failed Pushes:.*1/);
  });
});
