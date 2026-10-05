// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

// `init --new` against a brand-new scope that owns no sys_metadata rows yet.
// The real initNewApp -> wizard.downloadApp -> buildManifestFromTableAPI chain
// runs; only the SNClient is faked, so nothing touches the network.

const { initNewApp } = await import("../appCreator.js");
const ConfigManager = await import("../config.js");
const { logger } = await import("../Logger.js");

const SCOPE_ID = "a".repeat(32);

const ok = (result: unknown) =>
  Promise.resolve({ status: 200, data: { result } }) as Promise<never>;

const http = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: {} },
  });

function emptyScopeClient(manifestEndpoint: "missing" | "empty") {
  let created = false;
  return {
    getVendorPrefix: jest.fn(() => ok("x_acme_")),
    createRecord: jest.fn(async () => {
      created = true;
      return { sys_id: SCOPE_ID };
    }),
    getManifest: jest.fn((scope: string) =>
      manifestEndpoint === "missing"
        ? (Promise.reject(http(404)) as Promise<never>)
        : ok({ scope, tables: {} })
    ),
    tableAPIGet: jest.fn((table: string, query: string) => {
      if ((table === "sys_app" || table === "sys_scope") && /^scope=/.test(query)) {
        return ok(created ? [{ sys_id: SCOPE_ID }] : []);
      }
      return ok([]);
    }),
  };
}

describe.each(["missing", "empty"] as const)(
  "init --new on a brand-new empty scope (scoped endpoint %s)",
  (endpoint) => {
    const originalCwd = process.cwd();
    let tmp: string;

    beforeEach(() => {
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-init-new-empty-"));
      process.chdir(tmp);
      ConfigManager.resetConfigState();
      for (const level of ["error", "success", "info", "warn"] as const) {
        jest.spyOn(logger, level).mockImplementation((() => undefined) as never);
      }
    });

    afterEach(() => {
      jest.restoreAllMocks();
      process.chdir(originalCwd);
      ConfigManager.resetConfigState();
      fs.rmSync(tmp, { recursive: true, force: true });
    });

    it("creates the application and binds the directory with an empty manifest carrying the scopeId", async () => {
      await ConfigManager.loadConfigs();
      const client = emptyScopeClient(endpoint);

      await expect(
        initNewApp({ logLevel: "info", new: true, name: "Asset Tracker" } as never, {
          getClient: () => client as never,
          resolveInstance: () => "dev1.service-now.com",
        })
      ).resolves.toBe(true);

      expect(client.createRecord).toHaveBeenCalledTimes(1);
      expect(fs.existsSync(path.join(tmp, "sync.config.js"))).toBe(true);
      const manifest = JSON.parse(fs.readFileSync(path.join(tmp, "sync.manifest.json"), "utf8"));
      expect(manifest).toEqual({ scope: "x_acme_asset_track", scopeId: SCOPE_ID, tables: {} });
    });
  }
);

describe("the empty-manifest refusal outside a just-created scope", () => {
  const originalCwd = process.cwd();
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-empty-refusal-"));
    process.chdir(tmp);
    ConfigManager.resetConfigState();
    for (const level of ["error", "success", "info", "warn"] as const) {
      jest.spyOn(logger, level).mockImplementation((() => undefined) as never);
    }
  });

  afterEach(() => {
    jest.restoreAllMocks();
    process.chdir(originalCwd);
    ConfigManager.resetConfigState();
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  const existingEmptyScope = () => ({
    getManifest: jest.fn(() => Promise.reject(http(404)) as Promise<never>),
    tableAPIGet: jest.fn((table: string, query: string) =>
      table === "sys_app" && /^scope=/.test(query) ? ok([{ sys_id: SCOPE_ID }]) : ok([])
    ),
  });

  it("buildManifestFromTableAPI still refuses an empty scope without allowEmpty", async () => {
    const { buildManifestFromTableAPI } = await import("../manifestBuilder.js");
    await expect(
      buildManifestFromTableAPI("x_acme_empty", existingEmptyScope() as never, {})
    ).rejects.toThrow(/No tables discovered for scope "x_acme_empty"\. Refusing to build an empty manifest/);
  });

  it("buildManifestFromTableAPI with allowEmpty returns an empty manifest carrying the scopeId", async () => {
    const { buildManifestFromTableAPI } = await import("../manifestBuilder.js");
    const manifest = await buildManifestFromTableAPI("x_acme_empty", existingEmptyScope() as never, {}, {
      allowEmpty: true,
    });
    expect(manifest.scope).toBe("x_acme_empty");
    expect(manifest.scopeId).toBe(SCOPE_ID);
    expect(Object.keys(manifest.tables)).toEqual([]);
  });

  it("allowEmpty does not paper over a scope that does not exist", async () => {
    const { buildManifestFromTableAPI } = await import("../manifestBuilder.js");
    const client = { tableAPIGet: jest.fn(() => ok([])) };
    await expect(
      buildManifestFromTableAPI("x_acme_missing", client as never, {}, { allowEmpty: true })
    ).rejects.toThrow(/Scope "x_acme_missing" not found/);
  });

  it.each([
    ["no options", {}],
    ["justCreated without a scopeId", { justCreated: true }],
    ["a scopeId without justCreated", { scopeId: SCOPE_ID }],
  ])("downloadApp with %s keeps the refusal and writes no manifest", async (_label, options) => {
    await ConfigManager.loadConfigs();
    const { downloadApp } = await import("../wizard.js");
    await expect(
      downloadApp("x_acme_empty", existingEmptyScope() as never, options)
    ).rejects.toThrow("Failed to download files!");
    expect(logger.error).toHaveBeenCalledWith(
      expect.stringMatching(/Refusing to build an empty manifest/)
    );
    expect(fs.existsSync(path.join(tmp, "sync.manifest.json"))).toBe(false);
  });
});
