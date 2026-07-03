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
let checkScopeMock: jest.MockedFunction<typeof AppUtils.checkScope>;

beforeAll(async () => {
  AppUtils = await import("../appUtils.js");
  ({ scopeCheck, resolveInstanceProfile } = await import("../commandHelpers.js"));
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
