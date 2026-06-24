// SPDX-License-Identifier: GPL-3.0-or-later
import { getStoreKey, getStoreKeySource, clearStoreKeyCache } from "../src/index";

// D5 keychain backend. The optional @napi-rs/keyring native module is replaced
// with a virtual mock so the keychain branch (default-on) runs deterministically
// here, in this package's own mutation run, instead of only in the core suite.
const mockGetPassword = jest.fn();
const mockSetPassword = jest.fn();

jest.mock(
  "@napi-rs/keyring",
  () => ({
    Entry: jest.fn().mockImplementation(() => ({
      getPassword: mockGetPassword,
      setPassword: mockSetPassword,
    })),
  }),
  { virtual: true }
);

const STORE_KEY = "SYNCRONA_STORE_KEY";
const USE_KEYCHAIN = "SYNCRONA_USE_KEYCHAIN";
let savedStoreKey: string | undefined;
let savedUseKeychain: string | undefined;

beforeAll(() => {
  savedStoreKey = process.env[STORE_KEY];
  savedUseKeychain = process.env[USE_KEYCHAIN];
});

beforeEach(() => {
  jest.clearAllMocks();
  clearStoreKeyCache();
  // No explicit key; keychain default-on (no opt-out flag).
  delete process.env[STORE_KEY];
  delete process.env[USE_KEYCHAIN];
});

afterEach(() => {
  clearStoreKeyCache();
  if (savedStoreKey === undefined) delete process.env[STORE_KEY];
  else process.env[STORE_KEY] = savedStoreKey;
  if (savedUseKeychain === undefined) delete process.env[USE_KEYCHAIN];
  else process.env[USE_KEYCHAIN] = savedUseKeychain;
});

describe("keychain backend (mocked @napi-rs/keyring)", () => {
  it("reuses an existing valid master key from the keychain", () => {
    const stored = "ab".repeat(32); // 64 hex chars = 32 bytes
    mockGetPassword.mockReturnValue(stored);

    expect(getStoreKeySource()).toBe("keychain");
    expect(getStoreKey().toString("hex")).toBe(stored);
    expect(mockSetPassword).not.toHaveBeenCalled();
  });

  it("generates and persists a new master key when the keychain is empty", () => {
    mockGetPassword.mockReturnValue(null);

    const key = getStoreKey();
    expect(getStoreKeySource()).toBe("keychain");
    expect(key).toHaveLength(32);
    // The generated key is written back to the keychain as hex.
    expect(mockSetPassword).toHaveBeenCalledTimes(1);
    expect(mockSetPassword).toHaveBeenCalledWith(key.toString("hex"));
  });

  it("regenerates when the stored value is not valid key material", () => {
    mockGetPassword.mockReturnValue("this-is-not-a-key");

    expect(getStoreKeySource()).toBe("keychain");
    expect(mockSetPassword).toHaveBeenCalledTimes(1);
  });

  it("falls back to the machine key when the keychain read throws", () => {
    mockGetPassword.mockImplementation(() => {
      throw new Error("keychain locked");
    });

    expect(getStoreKeySource()).toBe("machine");
    expect(mockSetPassword).not.toHaveBeenCalled();
  });

  it("honours the opt-out flag and skips the keychain entirely", () => {
    process.env[USE_KEYCHAIN] = "0";
    expect(getStoreKeySource()).toBe("machine");
    expect(mockGetPassword).not.toHaveBeenCalled();
  });
});
