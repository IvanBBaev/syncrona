// SPDX-License-Identifier: GPL-3.0-or-later
import { mkdtempSync, readdirSync, rmSync } from "fs";
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
