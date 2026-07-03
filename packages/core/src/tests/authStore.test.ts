// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import path from "path";
import os from "os";

// The credential store lives in the compiled `@syncrona/credential-store`
// package, which is CommonJS and reaches `os` through `require("os")`. A
// `jest.unstable_mockModule("os", …)` factory only rewires the ESM import graph
// and never reaches that CJS `require`, so the store would still resolve the
// real home directory. Instead we spy on the shared `os` singleton (the same
// object the CJS dependency requires), pinning `homedir`/`hostname`/`userInfo`
// to deterministic values for the duration of each test.
async function loadAuthWithHome() {
  jest.resetModules();
  return import("../auth.js");
}

describe("auth credential store", () => {
  let tempHome: string;
  let homedirSpy: ReturnType<typeof jest.spyOn>;
  let hostnameSpy: ReturnType<typeof jest.spyOn>;
  let userInfoSpy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-auth-store-"));
    homedirSpy = jest.spyOn(os, "homedir").mockReturnValue(tempHome);
    hostnameSpy = jest.spyOn(os, "hostname").mockReturnValue("syncrona-test-host");
    userInfoSpy = jest
      .spyOn(os, "userInfo")
      .mockReturnValue({ username: "syncrona-test-user" } as ReturnType<typeof os.userInfo>);
  });

  afterEach(async () => {
    homedirSpy.mockRestore();
    hostnameSpy.mockRestore();
    userInfoSpy.mockRestore();
    jest.resetModules();
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  });

  it("saves and loads encrypted credentials", async () => {
    const auth = await loadAuthWithHome();

    await auth.saveCredentials("dev123.service-now.com", "admin", "secret");

    const loaded = await auth.loadCredentials("dev123.service-now.com");
    expect(loaded).toEqual({
      instance: "dev123.service-now.com",
      user: "admin",
      password: "secret",
    });

    const rawPath = path.join(tempHome, ".syncrona", "credentials", "dev123.service-now.com.enc");
    const raw = await fs.promises.readFile(rawPath, "utf8");
    expect(raw.includes("secret")).toBe(false);
  });

  it("lists, removes, and bulk-removes stored instances", async () => {
    const auth = await loadAuthWithHome();

    await auth.saveCredentials("dev.service-now.com", "user", "p1");
    await auth.saveCredentials("prod.service-now.com", "user", "p2");

    const before = await auth.listInstances();
    expect(before.sort()).toEqual(["dev.service-now.com", "prod.service-now.com"]);

    await auth.removeCredentials("dev.service-now.com");
    const afterSingle = await auth.listInstances();
    expect(afterSingle).toEqual(["prod.service-now.com"]);

    const removedCount = await auth.removeAllCredentials();
    expect(removedCount).toBe(1);
    const afterAll = await auth.listInstances();
    expect(afterAll).toEqual([]);
  });

  it("tracks active instance and resolves credentials from store", async () => {
    const auth = await loadAuthWithHome();

    await auth.saveCredentials("dev.service-now.com", "dev_user", "dev_pass");
    await auth.saveCredentials("prod.service-now.com", "prod_user", "prod_pass");

    await auth.setActiveInstance("prod.service-now.com");
    const active = await auth.getActiveInstance();
    expect(active).toBe("prod.service-now.com");

    const activeCreds = await auth.resolveCredentialsFromStore();
    expect(activeCreds).toEqual({
      instance: "prod.service-now.com",
      user: "prod_user",
      password: "prod_pass",
    });

    const devCreds = await auth.resolveCredentialsFromStore("dev.service-now.com");
    expect(devCreds).toEqual({
      instance: "dev.service-now.com",
      user: "dev_user",
      password: "dev_pass",
    });
  });

  it("returns null when resolving credentials with no active instance", async () => {
    const auth = await loadAuthWithHome();

    const creds = await auth.resolveCredentialsFromStore();
    expect(creds).toBeNull();
  });

  it("throws a helpful message for missing credentials", async () => {
    const auth = await loadAuthWithHome();

    await expect(auth.loadCredentials("missing.service-now.com")).rejects.toThrow(
      'No credentials found for "missing.service-now.com". Run: syncrona login missing.service-now.com'
    );
  });

  it("exposes the expected global SyncroNow AI directory", async () => {
    const auth = await loadAuthWithHome();
    expect(auth.getSyncronaDir()).toBe(path.join(tempHome, ".syncrona"));
  });
});
