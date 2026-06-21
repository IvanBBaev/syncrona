import fs from "fs";
import path from "path";
import os from "os";

// AR2 + D5: the at-rest encryption key is resolved from SYNCRONA_STORE_KEY (CI /
// secrets manager) or the OS keychain (the DEFAULT backend as of D5; opt out
// with SYNCRONA_USE_KEYCHAIN=0), falling back to the legacy machine-derived key
// so pre-AR2 credential files keep decrypting.

const KEY_A = "a".repeat(64); // 32 bytes of 0xaa
const KEY_B = "b".repeat(64); // 32 bytes of 0xbb

function mockHomeOs(tempHome: string) {
  jest.doMock("os", () => {
    const actual = jest.requireActual("os");
    return {
      ...actual,
      homedir: () => tempHome,
      hostname: () => "syncrona-test-host",
      userInfo: () => ({ username: "syncrona-test-user" }),
    };
  });
}

async function loadAuthWithHome(tempHome: string) {
  jest.resetModules();
  mockHomeOs(tempHome);
  return import("../auth");
}

// A fake @napi-rs/keyring backed by an in-memory map keyed on service+account,
// so a generated key persists across Entry instances (mirrors the real OS
// keychain) without ever touching the host's credential store.
type FakeKeyringControls = { store: Map<string, string>; throwOnAccess?: boolean };

async function loadAuthWithKeychain(tempHome: string, controls: FakeKeyringControls) {
  jest.resetModules();
  mockHomeOs(tempHome);
  jest.doMock(
    "@napi-rs/keyring",
    () => ({
      Entry: class {
        constructor(private readonly service: string, private readonly account: string) {}
        private key() {
          return `${this.service}:${this.account}`;
        }
        getPassword(): string | null {
          if (controls.throwOnAccess) throw new Error("keychain locked");
          return controls.store.get(this.key()) ?? null;
        }
        setPassword(pw: string): void {
          if (controls.throwOnAccess) throw new Error("keychain locked");
          controls.store.set(this.key(), pw);
        }
      },
    }),
    { virtual: true }
  );
  return import("../auth");
}

describe("at-rest key resolution (AR2)", () => {
  let tempHome: string;
  let savedStoreKey: string | undefined;
  let savedUseKeychain: string | undefined;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-store-key-"));
    savedStoreKey = process.env.SYNCRONA_STORE_KEY;
    savedUseKeychain = process.env.SYNCRONA_USE_KEYCHAIN;
    // D5: the keychain is now the DEFAULT backend, so absence of the flag means
    // "on". Tests must explicitly opt OUT (="0") to stay hermetic and never
    // touch the real OS keychain; the keychain cases below opt back in ("1")
    // with a mocked @napi-rs/keyring.
    process.env.SYNCRONA_USE_KEYCHAIN = "0";
    delete process.env.SYNCRONA_STORE_KEY;
  });

  afterEach(async () => {
    jest.dontMock("os");
    jest.resetModules();
    if (savedStoreKey === undefined) delete process.env.SYNCRONA_STORE_KEY;
    else process.env.SYNCRONA_STORE_KEY = savedStoreKey;
    if (savedUseKeychain === undefined) delete process.env.SYNCRONA_USE_KEYCHAIN;
    else process.env.SYNCRONA_USE_KEYCHAIN = savedUseKeychain;
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  });

  it("encrypts with the explicit SYNCRONA_STORE_KEY when set", async () => {
    process.env.SYNCRONA_STORE_KEY = KEY_A;
    const auth = await loadAuthWithHome(tempHome);

    await auth.saveCredentials("dev.service-now.com", "admin", "secret");
    const loaded = await auth.loadCredentials("dev.service-now.com");

    expect(loaded).toEqual({
      instance: "dev.service-now.com",
      user: "admin",
      password: "secret",
    });
    expect(auth.getStoreKeySource()).toBe("env");
  });

  it("rejects a malformed SYNCRONA_STORE_KEY", async () => {
    process.env.SYNCRONA_STORE_KEY = "not-a-valid-key";
    const auth = await loadAuthWithHome(tempHome);

    await expect(
      auth.saveCredentials("dev.service-now.com", "admin", "secret")
    ).rejects.toThrow(/SYNCRONA_STORE_KEY/);
  });

  it("falls back to the machine key for files written before AR2", async () => {
    // 1. Write with the legacy machine-derived key (no explicit key set).
    const legacy = await loadAuthWithHome(tempHome);
    await legacy.saveCredentials("dev.service-now.com", "admin", "secret");
    expect(legacy.getStoreKeySource()).toBe("machine");

    // 2. Now an explicit key is configured; the new key can't decrypt the old
    //    file, so the reader must fall back to the machine key.
    process.env.SYNCRONA_STORE_KEY = KEY_B;
    const upgraded = await loadAuthWithHome(tempHome);
    const loaded = await upgraded.loadCredentials("dev.service-now.com");

    expect(loaded).toEqual({
      instance: "dev.service-now.com",
      user: "admin",
      password: "secret",
    });
    expect(upgraded.getStoreKeySource()).toBe("env");
  });

  it("generates and persists a key in the OS keychain when opted in", async () => {
    process.env.SYNCRONA_USE_KEYCHAIN = "1";
    const store = new Map<string, string>();

    // First run generates a fresh master key and stores it in the keychain.
    const first = await loadAuthWithKeychain(tempHome, { store });
    await first.saveCredentials("dev.service-now.com", "admin", "secret");
    expect(first.getStoreKeySource()).toBe("keychain");
    expect(store.size).toBe(1);

    // A second process reuses the persisted keychain key and decrypts the file.
    const second = await loadAuthWithKeychain(tempHome, { store });
    const loaded = await second.loadCredentials("dev.service-now.com");
    expect(loaded).toEqual({
      instance: "dev.service-now.com",
      user: "admin",
      password: "secret",
    });
    expect(second.getStoreKeySource()).toBe("keychain");
  });

  it("falls back to the machine key when the keychain is unavailable", async () => {
    process.env.SYNCRONA_USE_KEYCHAIN = "1";
    const auth = await loadAuthWithKeychain(tempHome, {
      store: new Map(),
      throwOnAccess: true,
    });

    await auth.saveCredentials("dev.service-now.com", "admin", "secret");
    const loaded = await auth.loadCredentials("dev.service-now.com");
    expect(loaded).toEqual({
      instance: "dev.service-now.com",
      user: "admin",
      password: "secret",
    });
    expect(auth.getStoreKeySource()).toBe("machine");
  });
});
