export {};

// full-review C1 QA: lock the shared DX20b helper used by status + push.
const mockGetActiveInstance = jest.fn();
const mockLoadCredentials = jest.fn();

jest.mock("../auth", () => ({
  getActiveInstance: (...a: unknown[]) => mockGetActiveInstance(...a),
  loadCredentials: (...a: unknown[]) => mockLoadCredentials(...a),
}));

import { getActiveStoreDecryptWarning, activeStoreHealth } from "../commandHelpers";

describe("getActiveStoreDecryptWarning / activeStoreHealth (DX20b)", () => {
  afterEach(() => jest.clearAllMocks());

  it("returns null when there is no active stored instance", async () => {
    mockGetActiveInstance.mockResolvedValue(null);
    expect(await getActiveStoreDecryptWarning()).toBeNull();
    expect(await activeStoreHealth()).toEqual({ active: null, decrypts: false });
  });

  it("returns null when the active instance decrypts", async () => {
    mockGetActiveInstance.mockResolvedValue("dev.service-now.com");
    mockLoadCredentials.mockResolvedValue({ instance: "dev.service-now.com", user: "u", password: "p" });
    expect(await getActiveStoreDecryptWarning()).toBeNull();
    expect(await activeStoreHealth()).toEqual({ active: "dev.service-now.com", decrypts: true });
  });

  it("warns with the instance + error when the active instance fails to decrypt", async () => {
    mockGetActiveInstance.mockResolvedValue("ven03019.service-now.com");
    mockLoadCredentials.mockRejectedValue(new Error("unable to authenticate data"));
    const warning = await getActiveStoreDecryptWarning();
    expect(warning).toContain("ven03019.service-now.com");
    expect(warning).toContain("failed to decrypt");
    expect(warning).toContain("unable to authenticate data");
    expect(warning).toContain("syncro-now-ai login");
  });

  it("treats an unreadable store as no warning (best-effort)", async () => {
    mockGetActiveInstance.mockRejectedValue(new Error("store unreadable"));
    expect(await getActiveStoreDecryptWarning()).toBeNull();
  });
});
