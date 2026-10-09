// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";

// R5: the bare `jest.unstable_mockModule("../appUtils.js")` automock has no
// factory under ESM. Provide one; graph-complete fills in the exact named
// exports the commandHelpers graph hard-links from appUtils.
jest.unstable_mockModule("../appUtils.js", () => ({
  checkScope: jest.fn(),
}));
jest.unstable_mockModule("../logMessages.js", () => ({
  scopeCheckMessage: jest.fn(),
}));

// R1: the mock does not hoist, so both the mocked appUtils namespace and the SUT
// are imported dynamically after the mock registers.
let AppUtils: typeof import("../appUtils.js");
let scopeCheck: typeof import("../commandHelpers.js").scopeCheck;
let resolveInstanceProfile: typeof import("../commandHelpers.js").resolveInstanceProfile;
let setLogLevel: typeof import("../commandHelpers.js").setLogLevel;
let logger: typeof import("../Logger.js").logger;
let checkScopeMock: jest.MockedFunction<typeof AppUtils.checkScope>;

beforeAll(async () => {
  AppUtils = await import("../appUtils.js");
  ({ scopeCheck, resolveInstanceProfile, setLogLevel } = await import("../commandHelpers.js"));
  ({ logger } = await import("../Logger.js"));
  checkScopeMock = AppUtils.checkScope as jest.MockedFunction<
    typeof AppUtils.checkScope
  >;
});

describe("scopeCheck", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.exitCode = undefined;
  });

  it("runs the success function when the scope matches", async () => {
    checkScopeMock.mockResolvedValue({ match: true } as Awaited<
      ReturnType<typeof AppUtils.checkScope>
    >);
    const success = jest.fn();
    await scopeCheck(success);
    expect(success).toHaveBeenCalledTimes(1);
    expect(process.exitCode).toBeUndefined();
  });

  it("sets a failure exit code and skips the body when the scope mismatches", async () => {
    checkScopeMock.mockResolvedValue({ match: false } as Awaited<
      ReturnType<typeof AppUtils.checkScope>
    >);
    const success = jest.fn();
    await scopeCheck(success);
    expect(success).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("reports a scope-check failure (not a body failure) when checkScope throws", async () => {
    checkScopeMock.mockRejectedValue(new Error("network down"));
    const success = jest.fn();
    await scopeCheck(success);
    expect(success).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
  });

  it("sets a failure exit code when the body itself throws", async () => {
    checkScopeMock.mockResolvedValue({ match: true } as Awaited<
      ReturnType<typeof AppUtils.checkScope>
    >);
    await scopeCheck(() => {
      throw new Error("body boom");
    });
    expect(process.exitCode).toBe(1);
  });

  // Ctrl-C at a prompt inside the command body reaches this sink before
  // commander.ts can classify it, so every scope-checked command used to print
  // a bogus "force closed the prompt" error banner and exit 1. A cancellation
  // is not a failure: 130 (SIGINT), no error banner.
  it("treats a prompt abort in the body as a cancellation, not a failure", async () => {
    checkScopeMock.mockResolvedValue({ match: true } as Awaited<
      ReturnType<typeof AppUtils.checkScope>
    >);
    const { logger } = await import("../Logger.js");
    const errorSpy = jest.spyOn(logger, "error").mockImplementation(() => {});

    await scopeCheck(() => {
      const abort = new Error("User force closed the prompt with 0 null");
      abort.name = "ExitPromptError";
      throw abort;
    });

    expect(process.exitCode).toBe(130);
    expect(errorSpy).not.toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it("passes the swapScopes flag through to checkScope", async () => {
    checkScopeMock.mockResolvedValue({ match: true } as Awaited<
      ReturnType<typeof AppUtils.checkScope>
    >);
    await scopeCheck(jest.fn(), true);
    expect(checkScopeMock).toHaveBeenCalledWith(true);
  });
});

describe("resolveInstanceProfile", () => {
  it("prefers an explicit --instance-profile", () => {
    expect(resolveInstanceProfile({ instanceProfile: "dev" })).toBe("dev");
  });

  it("returns undefined when no explicit flag and no local config exist", () => {
    // cwd here is the package root, which has no .syncrona-local.
    expect(resolveInstanceProfile({})).toBeUndefined();
  });
});

describe("setLogLevel", () => {
  let originalLevel: string;

  beforeAll(() => {
    originalLevel = logger.getLogLevel();
  });

  afterAll(() => {
    logger.setLogLevel(originalLevel);
  });

  it("applies the requested --log-level", () => {
    setLogLevel({ logLevel: "debug" } as Parameters<typeof setLogLevel>[0]);
    expect(logger.getLogLevel()).toBe("debug");
  });

  // login, logout, instances and use are registered without the shared options,
  // so they reach setLogLevel with no logLevel at all. That used to print
  // 'Unknown log level "undefined"' on every run.
  it("uses info without warning when the command has no --log-level option", () => {
    logger.setLogLevel("error");
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    try {
      setLogLevel({} as Parameters<typeof setLogLevel>[0]);
      expect(logger.getLogLevel()).toBe("info");
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
});
