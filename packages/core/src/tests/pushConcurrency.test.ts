// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
export {};

// DX24: --push-concurrency overrides sync.config.js pushConcurrency, which
// overrides the default; the result is always clamped to 1–50.

const mockGetConfig = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

// appUtils pulls in many siblings; stub the heavy/IO ones it imports at load.
jest.unstable_mockModule("../snClient.js", () => ({
  isRetryableRequestError: jest.fn(),
  processPushResponse: jest.fn(),
  retryOnErr: jest.fn(),
  SNClient: jest.fn(),
  defaultClient: jest.fn(),
  resolveCredentials: jest.fn(),
  unwrapSNResponse: jest.fn(),
  unwrapTableAPIFirstItem: jest.fn(),
  unwrapTableAPIFirstItemOrEmpty: jest.fn(),
  getErrorResponseStatus: jest.fn(),
}));

// The SUT is imported dynamically AFTER the module mocks are registered:
// jest.unstable_mockModule does not hoist, so a static import would bind the
// real config (whose getConfig throws) before the mock takes effect.
let resolvePushConcurrency: typeof import("../appUtils.js").resolvePushConcurrency;

describe("resolvePushConcurrency (DX24)", () => {
  beforeEach(async () => {
    ({ resolvePushConcurrency } = await import("../appUtils.js"));
  });
  afterEach(() => jest.clearAllMocks());

  it("uses the config value when no override is given", () => {
    mockGetConfig.mockReturnValue({ pushConcurrency: 7 });
    expect(resolvePushConcurrency()).toBe(7);
  });

  it("lets a CLI override win over config", () => {
    mockGetConfig.mockReturnValue({ pushConcurrency: 10 });
    expect(resolvePushConcurrency(3)).toBe(3);
  });

  it("clamps to the 1–50 range (both override and config)", () => {
    mockGetConfig.mockReturnValue({ pushConcurrency: 999 });
    expect(resolvePushConcurrency()).toBe(50);
    expect(resolvePushConcurrency(0)).toBe(1);
    expect(resolvePushConcurrency(123)).toBe(50);
  });

  it("falls back to 10 when neither override nor config is a valid number", () => {
    mockGetConfig.mockReturnValue({});
    expect(resolvePushConcurrency()).toBe(10);
    expect(resolvePushConcurrency(Number.NaN)).toBe(10);
  });
});
