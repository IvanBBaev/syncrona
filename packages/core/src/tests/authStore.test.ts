import fs from "fs";
import path from "path";
import os from "os";

async function loadAuthWithHome(tempHome: string) {
  jest.resetModules();
  jest.doMock("os", () => {
    const actual = jest.requireActual("os");
    return {
      ...actual,
      homedir: () => tempHome,
      hostname: () => "syncrona-test-host",
      userInfo: () => ({ username: "syncrona-test-user" }),
    };
  });

  return import("../auth");
}

describe("auth credential store", () => {
  let tempHome: string;

  beforeEach(() => {
    tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-auth-store-"));
  });

  afterEach(async () => {
    jest.dontMock("os");
    jest.resetModules();
    await fs.promises.rm(tempHome, { recursive: true, force: true });
  });

  it("saves and loads encrypted credentials", async () => {
    const auth = await loadAuthWithHome(tempHome);

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
    const auth = await loadAuthWithHome(tempHome);

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
    const auth = await loadAuthWithHome(tempHome);

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
    const auth = await loadAuthWithHome(tempHome);

    const creds = await auth.resolveCredentialsFromStore();
    expect(creds).toBeNull();
  });

  it("throws a helpful message for missing credentials", async () => {
    const auth = await loadAuthWithHome(tempHome);

    await expect(auth.loadCredentials("missing.service-now.com")).rejects.toThrow(
      'No credentials found for "missing.service-now.com". Run: syncrona login missing.service-now.com'
    );
  });

  it("exposes the expected global syncrona directory", async () => {
    const auth = await loadAuthWithHome(tempHome);
    expect(auth.getSyncronaDir()).toBe(path.join(tempHome, ".syncrona"));
  });
});
