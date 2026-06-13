export {};

// DX24: --push-concurrency overrides sync.config.js pushConcurrency, which
// overrides the default; the result is always clamped to 1–50.

const mockGetConfig = jest.fn();

jest.mock("../config", () => ({
  getConfig: (...args: unknown[]) => mockGetConfig(...args),
}));

// appUtils pulls in many siblings; stub the heavy/IO ones it imports at load.
jest.mock("../snClient", () => ({
  defaultClient: jest.fn(),
  resolveCredentials: jest.fn(),
  unwrapSNResponse: jest.fn(),
  unwrapTableAPIFirstItem: jest.fn(),
  unwrapTableAPIFirstItemOrEmpty: jest.fn(),
  getErrorResponseStatus: jest.fn(),
}));

import { resolvePushConcurrency } from "../appUtils";

describe("resolvePushConcurrency (DX24)", () => {
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
