// SPDX-License-Identifier: GPL-3.0-or-later
import { randomBytes } from "crypto";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import {
  getStoreKey,
  getStoreKeySource,
  getMachineKey,
  clearStoreKeyCache,
  encrypt,
  saveCredentials,
  loadCredentials,
  loadCredentialsSync,
  getActiveInstanceSync,
  filenameToInstance,
  instanceToFilename,
  getSyncronaDir,
} from "../src/index";

// Exercises the key-material parser, the legacy-key decrypt fallback and the
// sync read fallbacks — all reached only indirectly through the public API, so
// the store directory is pinned to a throwaway temp home and the key source is
// driven by the env precedence.
const STORE_KEY = "SYNCRONA_STORE_KEY";
const USE_KEYCHAIN = "SYNCRONA_USE_KEYCHAIN";
let savedStoreKey: string | undefined;
let savedUseKeychain: string | undefined;
let tmpHome: string;
let homedirSpy: jest.SpyInstance;

beforeAll(() => {
  savedStoreKey = process.env[STORE_KEY];
  savedUseKeychain = process.env[USE_KEYCHAIN];
});

beforeEach(() => {
  clearStoreKeyCache();
  delete process.env[STORE_KEY];
  process.env[USE_KEYCHAIN] = "0"; // keep the keychain out of these tests
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "sync-keymat-"));
  homedirSpy = jest.spyOn(os, "homedir").mockReturnValue(tmpHome);
});

afterEach(() => {
  homedirSpy.mockRestore();
  rmSync(tmpHome, { recursive: true, force: true });
  clearStoreKeyCache();
  if (savedStoreKey === undefined) delete process.env[STORE_KEY];
  else process.env[STORE_KEY] = savedStoreKey;
  if (savedUseKeychain === undefined) delete process.env[USE_KEYCHAIN];
  else process.env[USE_KEYCHAIN] = savedUseKeychain;
});

const credDir = () => path.join(getSyncronaDir(), "credentials");
const writeEncFile = (instance: string, plaintext: string) => {
  mkdirSync(credDir(), { recursive: true });
  writeFileSync(
    path.join(credDir(), instanceToFilename(instance)),
    encrypt(plaintext, getStoreKey())
  );
};

describe("key material parsing (via SYNCRONA_STORE_KEY)", () => {
  it("accepts a 32-byte base64 key", () => {
    const keyBuf = randomBytes(32);
    process.env[STORE_KEY] = keyBuf.toString("base64");
    clearStoreKeyCache();
    expect(getStoreKeySource()).toBe("env");
    expect(getStoreKey().equals(keyBuf)).toBe(true);
  });

  it("rejects a key that is neither 64-hex nor a 32-byte base64 blob", () => {
    process.env[STORE_KEY] = "definitely-too-short";
    clearStoreKeyCache();
    expect(() => getStoreKey()).toThrow(/32-byte key/);
  });
});

describe("getMachineKey", () => {
  it("still derives a 32-byte key when os.userInfo() throws", () => {
    const spy = jest.spyOn(os, "userInfo").mockImplementation(() => {
      throw new Error("no passwd entry");
    });
    expect(getMachineKey()).toHaveLength(32);
    spy.mockRestore();
  });
});

describe("filenameToInstance", () => {
  it("strips only the trailing .enc, not an embedded one", () => {
    expect(filenameToInstance("scope.enc.enc")).toBe("scope.enc");
  });
});

describe("decryptWithFallback (legacy machine-key reads)", () => {
  it("opens a file written with the machine key after switching to an explicit key", async () => {
    const INSTANCE = "legacy.service-now.com";
    // Write while the machine key is active.
    await saveCredentials(INSTANCE, "admin", "legacy-pw");

    // Now provide an explicit (different) key: decrypt must retry the machine key.
    process.env[STORE_KEY] = "f".repeat(64);
    clearStoreKeyCache();
    expect(getStoreKeySource()).toBe("env");

    const loaded = await loadCredentials(INSTANCE);
    expect(loaded).toEqual({
      instance: INSTANCE,
      user: "admin",
      password: "legacy-pw",
    });
  });
});

describe("loadCredentialsSync fallbacks", () => {
  beforeEach(() => {
    process.env[STORE_KEY] = "a".repeat(64);
    clearStoreKeyCache();
  });

  it("fills missing user/password with empty strings", () => {
    writeEncFile("partial.sn.com", JSON.stringify({ instance: "partial.sn.com" }));
    expect(loadCredentialsSync("partial.sn.com")).toEqual({
      instance: "partial.sn.com",
      user: "",
      password: "",
    });
  });

  it("falls back to the requested instance when the stored record omits it", () => {
    writeEncFile("noinst.sn.com", JSON.stringify({ user: "u", password: "p" }));
    expect(loadCredentialsSync("noinst.sn.com")).toEqual({
      instance: "noinst.sn.com",
      user: "u",
      password: "p",
    });
  });

  it("returns null for a corrupt credential file", () => {
    mkdirSync(credDir(), { recursive: true });
    writeFileSync(
      path.join(credDir(), instanceToFilename("corrupt.sn.com")),
      "garbage:data:nothex"
    );
    expect(loadCredentialsSync("corrupt.sn.com")).toBeNull();
  });
});

describe("getActiveInstanceSync", () => {
  const writeConfig = (obj: unknown) => {
    mkdirSync(getSyncronaDir(), { recursive: true });
    writeFileSync(path.join(getSyncronaDir(), "config.json"), JSON.stringify(obj));
  };

  it("returns null when the active instance is blank/whitespace", () => {
    writeConfig({ activeInstance: "   " });
    expect(getActiveInstanceSync()).toBeNull();
  });

  it("returns the trimmed active instance when present", () => {
    writeConfig({ activeInstance: "live.service-now.com" });
    expect(getActiveInstanceSync()).toBe("live.service-now.com");
  });
});
