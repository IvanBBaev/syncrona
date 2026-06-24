// SPDX-License-Identifier: GPL-3.0-or-later
import {
  logFilePush,
  logDeploy,
  logPushResults,
  logBuildResults,
  scopeCheckMessage,
  devModeLog,
} from "../logMessages";
import { logger } from "../Logger";

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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
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
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { tableName: "sys_script", name: "rec", targetField: "script" } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { success: true, message: "" } as any
    );
    expect(errorSpy).not.toHaveBeenCalled();
    const out = infoText();
    expect(out).toContain("File Push Summary");
    expect(out).toContain("sys_script");
    expect(out).toContain("Pushed");
  });

  it("logFilePush logs a failure status and the error message on failure", () => {
    logFilePush(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { tableName: "t", name: "r", targetField: "f" } as any,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { success: false, message: "boom" } as any
    );
    expect(infoText()).toContain("Failed to push");
    expect(errorSpy).toHaveBeenCalledWith("boom");
  });

  it("logDeploy logs the count of deployed files on success", () => {
    logDeploy([], true, [true, false, true]);
    const out = infoText();
    expect(out).toContain("2 files");
    expect(out).toContain("successfully deployed");
    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("logDeploy logs the error message and the parsed error on failure", () => {
    logDeploy([], false, [], new Error("kaboom"));
    const out = errorText();
    expect(out).toContain("Failed to deploy files");
    expect(out).toContain("kaboom");
  });

  it("logDeploy falls back to 'none' when the Error has no stack", () => {
    const err = new Error("stackless");
    err.stack = undefined;
    logDeploy([], false, [], err);
    const out = errorText();
    expect(out).toContain("stackless");
    expect(out).toContain("none");
  });

  it("logDeploy logs only the error message when no Error object is given", () => {
    logDeploy([], false, []);
    const out = errorText();
    expect(out).toContain("Failed to deploy files");
    expect(out).not.toContain("Stack Trace");
  });

  it("logPushResults prints totals and returns early when all pushes succeed", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logPushResults([{ success: true, message: "" }] as any);
    expect(internalInfo).toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalled();
    expect(internalError).not.toHaveBeenCalled();
  });

  it("logPushResults prints an error summary when a push fails", () => {
    logPushResults([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { success: true, message: "" },
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      { success: false, message: "nope" },
    ] as never);
    expect(errorSpy).toHaveBeenCalled();
    expect(errorText()).toContain("Error Summary");
    expect(internalErrorText()).toContain("nope");
  });

  it("logBuildResults prints totals for the Builds operation", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    logBuildResults([{ success: false, message: "bad" }] as any);
    expect(internalInfo).toHaveBeenCalled();
    expect(errorText()).toContain("Error Summary");
  });
});
