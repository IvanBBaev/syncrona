// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from "fs";
import os from "os";
import path from "path";
import {
  saveCredentials,
  loadCredentials,
  listInstances,
  removeCredentials,
  removeAllCredentials,
  setActiveInstance,
  getActiveInstance,
  resolveCredentialsFromStore,
  getActiveInstanceSync,
  loadCredentialsSync,
  getSyncronaDir,
} from "../src/index";

// CRITICAL: the store resolves its directory from os.homedir(), which on macOS
// ignores $HOME. Mock it to a temp dir so these tests NEVER touch the real
// ~/.syncrona. Pin an explicit key so the round-trip is deterministic.
let tmpHome: string;
let homedirSpy: jest.SpyInstance;

beforeAll(() => {
  process.env.SYNCRONA_STORE_KEY = "a".repeat(64); // 32-byte hex key
});

beforeEach(() => {
  tmpHome = mkdtempSync(path.join(os.tmpdir(), "sync-store-"));
  homedirSpy = jest.spyOn(os, "homedir").mockReturnValue(tmpHome);
});

afterEach(() => {
  homedirSpy.mockRestore();
  rmSync(tmpHome, { recursive: true, force: true });
});

const INSTANCE = "dev12345.service-now.com";

test("saveCredentials -> loadCredentials round-trips the stored secret", async () => {
  await saveCredentials(INSTANCE, "admin", "s3cret");
  const loaded = await loadCredentials(INSTANCE);
  expect(loaded).toEqual({ instance: INSTANCE, user: "admin", password: "s3cret" });
});

test("loadCredentials throws a helpful error when the instance is unknown", async () => {
  await expect(loadCredentials("nope.service-now.com")).rejects.toThrow(
    /No credentials found/
  );
});

test("listInstances reflects saved and removed instances", async () => {
  expect(await listInstances()).toEqual([]);
  await saveCredentials(INSTANCE, "admin", "x");
  await saveCredentials("prod.service-now.com", "admin", "y");
  expect((await listInstances()).sort()).toEqual(
    ["dev12345.service-now.com", "prod.service-now.com"].sort()
  );
  await removeCredentials(INSTANCE);
  expect(await listInstances()).toEqual(["prod.service-now.com"]);
});

test("removeAllCredentials clears the store and reports the count", async () => {
  await saveCredentials(INSTANCE, "a", "1");
  await saveCredentials("prod.service-now.com", "b", "2");
  expect(await removeAllCredentials()).toBe(2);
  expect(await listInstances()).toEqual([]);
});

test("listInstances skips an undecodable filename and still lists the valid instances", async () => {
  await saveCredentials(INSTANCE, "admin", "x");
  await saveCredentials("prod.service-now.com", "admin", "y");
  // Seed a deliberately malformed filename: "%zz" is not valid percent-encoding,
  // so filenameToInstance's decodeURIComponent throws on it. A single bad name
  // must not abort the loop and hide the successfully-decoded instances.
  const badFile = path.join(getSyncronaDir(), "credentials", "%zz.enc");
  writeFileSync(badFile, "garbage", "utf8");

  expect((await listInstances()).sort()).toEqual(
    ["dev12345.service-now.com", "prod.service-now.com"].sort()
  );
});

test("removeAllCredentials removes the valid instances despite an undecodable filename", async () => {
  await saveCredentials(INSTANCE, "a", "1");
  await saveCredentials("prod.service-now.com", "b", "2");
  const badFile = path.join(getSyncronaDir(), "credentials", "%zz.enc");
  writeFileSync(badFile, "garbage", "utf8");

  // The bad file used to abort listInstances, making removeAllCredentials a silent
  // no-op; the valid instances must now be removed and reported.
  expect(await removeAllCredentials()).toBe(2);
  expect(await listInstances()).toEqual([]);
});

test("active instance can be set, read, and resolves credentials", async () => {
  await saveCredentials(INSTANCE, "admin", "pw");
  expect(await getActiveInstance()).toBeNull();
  await setActiveInstance(INSTANCE);
  expect(await getActiveInstance()).toBe(INSTANCE);
  // resolveCredentialsFromStore with no arg uses the active instance
  expect(await resolveCredentialsFromStore()).toEqual({
    instance: INSTANCE,
    user: "admin",
    password: "pw",
  });
});

test("setActiveInstance writes config atomically and leaves no temp residue", async () => {
  // Concurrent writers must not corrupt config.json; the temp+rename strategy
  // means the directory never retains a half-written ".tmp" file afterwards.
  await Promise.all([
    setActiveInstance("a.service-now.com"),
    setActiveInstance("b.service-now.com"),
    setActiveInstance("c.service-now.com"),
  ]);

  const active = await getActiveInstance();
  expect(["a.service-now.com", "b.service-now.com", "c.service-now.com"]).toContain(active);

  const leftovers = readdirSync(getSyncronaDir()).filter((name) => name.endsWith(".tmp"));
  expect(leftovers).toEqual([]);
});

test("resolveCredentialsFromStore returns null when nothing matches", async () => {
  expect(await resolveCredentialsFromStore()).toBeNull();
  expect(await resolveCredentialsFromStore("ghost.service-now.com")).toBeNull();
});

test("sync API mirrors the async reads", async () => {
  await saveCredentials(INSTANCE, "admin", "pw");
  await setActiveInstance(INSTANCE);
  expect(getActiveInstanceSync()).toBe(INSTANCE);
  const synced = loadCredentialsSync(INSTANCE);
  expect(synced).toMatchObject({ instance: INSTANCE, user: "admin", password: "pw" });
});

test("loadCredentialsSync returns null for an unknown instance", () => {
  expect(loadCredentialsSync("missing.service-now.com")).toBeNull();
});

test("saveCredentials persists the richer multi-method record and omits blanks", async () => {
  await saveCredentials(INSTANCE, "", "", {
    authMethod: "oauth-jwt-bearer",
    clientId: "cid",
    clientSecret: "csecret",
    jwtKeyPath: "/keys/sn.pem",
    jwtKid: "kid-1",
    clientCertPath: "/certs/client.pem",
  });
  const loaded = await loadCredentials(INSTANCE);
  // Provided fields round-trip; absent optionals (apiKey, jwtIss, …) are omitted
  // so the record stays minimal. Cert/key are stored by PATH only.
  expect(loaded).toEqual({
    instance: INSTANCE,
    user: "",
    password: "",
    authMethod: "oauth-jwt-bearer",
    clientId: "cid",
    clientSecret: "csecret",
    jwtKeyPath: "/keys/sn.pem",
    jwtKid: "kid-1",
    clientCertPath: "/certs/client.pem",
  });
});

test("saveCredentials round-trips an api-key record with a header override", async () => {
  await saveCredentials(INSTANCE, "", "", {
    authMethod: "api-key",
    apiKey: "KEY-123",
    apiKeyHeader: "x-custom-key",
  });
  expect(await loadCredentials(INSTANCE)).toEqual({
    instance: INSTANCE,
    user: "",
    password: "",
    authMethod: "api-key",
    apiKey: "KEY-123",
    apiKeyHeader: "x-custom-key",
  });
});

test("saveCredentials drops an unrecognized authMethod so it can be re-inferred", async () => {
  await saveCredentials(INSTANCE, "admin", "pw", { authMethod: "bogus" as never });
  // A value outside the StoredAuthMethod union is dropped rather than persisted,
  // leaving a clean legacy-shaped record.
  expect(await loadCredentials(INSTANCE)).toEqual({
    instance: INSTANCE,
    user: "admin",
    password: "pw",
  });
});
