// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Cross-process keychain key-provisioning race (seventh-wave re-examination of
 * the refuted finding at src/index.ts:236).
 *
 * keyFromKeychain() provisions the master key with get-then-generate-then-set.
 * Within one process that sequence is synchronous and cannot interleave, but the
 * CLI and the MCP server are SEPARATE processes sharing one OS keychain: both
 * can read "empty", each writes its own random key, and the overwritten key is
 * gone forever — every credential file already encrypted with it becomes
 * permanently undecryptable (decryptWithFallback only retries the deterministic
 * machine key, never a lost random one).
 *
 * Harness: the optional @napi-rs/keyring native module is replaced with a
 * virtual mock backed by a shared cell (the OS keychain), and each "process" is
 * a fresh module registry via jest.isolateModules — its own cachedStoreKey,
 * exactly like a separate OS process. A queued "stale read" models the loser's
 * getPassword() that was serviced by the OS before the winner's setPassword()
 * landed. These tests drive the real implementation end to end (getStoreKey,
 * saveCredentials, loadCredentials/loadCredentialsSync) and fail on the
 * unfixed get-then-set code.
 */
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "fs";
import os from "os";
import path from "path";

type StoreModule = typeof import("../src/index");

/** The mocked OS keychain: one cell shared by every "process". */
const keychain: { value: string | null } = { value: null };
/**
 * Queued snapshots for getPassword(). When non-empty, the next read returns the
 * queued value instead of the live cell — modelling a read the OS serviced
 * before a concurrent writer's setPassword() landed (the TOCTOU window).
 */
const staleReads: (string | null)[] = [];

const mockGetPassword = jest.fn((): string | null =>
  staleReads.length > 0 ? (staleReads.shift() as string | null) : keychain.value
);
const mockSetPassword = jest.fn((pw: string): void => {
  keychain.value = pw;
});

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

/** Load a fresh module instance — its own cachedStoreKey, like a separate process. */
function loadStoreInstance(): StoreModule {
  let mod: StoreModule | undefined;
  jest.isolateModules(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    mod = require("../src/index") as StoreModule;
  });
  if (!mod) throw new Error("failed to load an isolated store instance");
  return mod;
}

const STORE_KEY = "SYNCRONA_STORE_KEY";
const USE_KEYCHAIN = "SYNCRONA_USE_KEYCHAIN";
const INSTANCE = "dev12345.service-now.com";

let savedStoreKey: string | undefined;
let savedUseKeychain: string | undefined;
let tmpHome: string;
let homedirSpy: jest.SpyInstance;

beforeAll(() => {
  savedStoreKey = process.env[STORE_KEY];
  savedUseKeychain = process.env[USE_KEYCHAIN];
});

beforeEach(() => {
  jest.clearAllMocks();
  keychain.value = null;
  staleReads.length = 0;
  // No explicit key; keychain default-on (no opt-out flag).
  delete process.env[STORE_KEY];
  delete process.env[USE_KEYCHAIN];
  // Never touch the real ~/.syncrona — os.homedir() ignores $HOME on macOS.
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "sync-keyrace-"));
  homedirSpy = jest.spyOn(os, "homedir").mockReturnValue(tmpHome);
});

afterEach(() => {
  homedirSpy.mockRestore();
  rmSync(tmpHome, { recursive: true, force: true });
  if (savedStoreKey === undefined) delete process.env[STORE_KEY];
  else process.env[STORE_KEY] = savedStoreKey;
  if (savedUseKeychain === undefined) delete process.env[USE_KEYCHAIN];
  else process.env[USE_KEYCHAIN] = savedUseKeychain;
});

function provisionLockPath(): string {
  return path.join(tmpHome, ".syncrona", "store-key.lock");
}

describe("cross-process keychain provisioning race", () => {
  it("a provisioner that lost the race adopts the winner's key instead of clobbering it", async () => {
    // Process A (CLI login): provisions the first master key and saves creds.
    const a = loadStoreInstance();
    const keyA = a.getStoreKey();
    expect(a.getStoreKeySource()).toBe("keychain");
    expect(keychain.value).toBe(keyA.toString("hex"));
    await a.saveCredentials(INSTANCE, "admin", "s3cret");

    // Process B raced A: its first getPassword() was serviced before A's
    // setPassword() landed, so it saw an empty keychain.
    staleReads.push(null);
    const b = loadStoreInstance();
    const keyB = b.getStoreKey();
    expect(b.getStoreKeySource()).toBe("keychain");

    // The loser must converge on the winner's key — a second fresh key would
    // overwrite keyA in the keychain and orphan everything A encrypted.
    expect(keyB.toString("hex")).toBe(keyA.toString("hex"));
    expect(keychain.value).toBe(keyA.toString("hex"));
    expect(mockSetPassword).toHaveBeenCalledTimes(1);

    // Any later process (honest keychain read) can still open A's credentials.
    const c = loadStoreInstance();
    await expect(c.loadCredentials(INSTANCE)).resolves.toMatchObject({
      user: "admin",
      password: "s3cret",
    });
  });

  it("an MCP-style sync reader that raced the CLI's provisioning does not destroy the CLI's key", async () => {
    const cli = loadStoreInstance();
    const cliKey = cli.getStoreKey();
    await cli.saveCredentials(INSTANCE, "admin", "s3cret");

    // The MCP server starts concurrently; its keychain read raced the CLI's
    // write. Merely RESOLVING credentials must not overwrite the master key.
    staleReads.push(null);
    const mcp = loadStoreInstance();
    const creds = mcp.loadCredentialsSync(INSTANCE);

    expect(creds?.password).toBe("s3cret");
    expect(keychain.value).toBe(cliKey.toString("hex"));
  });

  it("steals a stale provisioning lock left behind by a crashed process", () => {
    mkdirSync(provisionLockPath(), { recursive: true });
    const past = (Date.now() - 60_000) / 1000;
    utimesSync(provisionLockPath(), past, past);

    const store = loadStoreInstance();
    expect(store.getStoreKeySource()).toBe("keychain");
    expect(mockSetPassword).toHaveBeenCalledTimes(1);
  });

  it("never writes an unserialized random key: a held lock falls back to the recoverable machine key", () => {
    // A live holder (fresh mtime) keeps the lock for the whole wait window. The
    // machine key is deterministic, so anything encrypted with it stays
    // recoverable via decryptWithFallback; an unlocked random write would not be.
    mkdirSync(provisionLockPath(), { recursive: true });

    const store = loadStoreInstance();
    expect(store.getStoreKeySource()).toBe("machine");
    expect(mockSetPassword).not.toHaveBeenCalled();
  });
});
