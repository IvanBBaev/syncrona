// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

// `syncrona init --new` (R3, WP-3): scope derivation, vendor-prefix resolution,
// the sys_app insert body and the create-then-bind flow. Every instance call
// goes through a fake client, so nothing here touches the network.

const mockLoggerInfo = jest.fn();
const mockLoggerWarn = jest.fn();
const mockLoggerSuccess = jest.fn();
const mockWizardDownloadApp = jest.fn();

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    setLogLevel: jest.fn(),
    isRoutedToStderr: () => false,
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    success: (...args: unknown[]) => mockLoggerSuccess(...args),
    error: jest.fn(),
    debug: jest.fn(),
  },
}));

jest.unstable_mockModule("../wizard.js", () => ({
  downloadApp: (...args: unknown[]) => mockWizardDownloadApp(...args),
  startWizard: jest.fn(),
}));

const {
  SCOPE_MAX_LENGTH,
  AppCreatorError,
  normalizeVendorPrefix,
  snakeCaseName,
  validateScopeName,
  deriveScopeName,
  resolveVendorPrefix,
  buildSysAppBody,
  createScopedApp,
  findExistingApp,
  wantsInitNew,
  initNewApp,
  defaultInitNewDeps,
} = await import("../appCreator.js");
const ConfigManager = await import("../config.js");

type Call = { method: "GET" | "POST"; target: string; body?: unknown };

// Typed as `never` so the fake satisfies the AxiosResponse-returning client signatures.
const ok = (result: unknown) =>
  Promise.resolve({ status: 200, data: { result } }) as Promise<never>;

/**
 * A fake SNClient that records every request as GET or POST, so a test can
 * assert "zero non-GET" directly instead of trusting a flag.
 */
function fakeClient(options: {
  vendorPrefix?: unknown;
  vendorPrefixError?: Error;
  existingApps?: Array<{ sys_id: string }>;
  createdSysId?: string;
} = {}) {
  const calls: Call[] = [];
  const client = {
    getVendorPrefix: jest.fn(() => {
      calls.push({ method: "GET", target: "appcreator/app/vendorprefix" });
      return options.vendorPrefixError
        ? (Promise.reject(options.vendorPrefixError) as Promise<never>)
        : ok(options.vendorPrefix ?? "x_acme_");
    }),
    tableAPIGet: jest.fn((table: string, query: string) => {
      calls.push({ method: "GET", target: `${table}?${query}` });
      return ok(options.existingApps ?? []);
    }),
    createRecord: jest.fn(async (table: string, body: unknown) => {
      calls.push({ method: "POST", target: table, body });
      return { sys_id: options.createdSysId ?? "app-sys-id-1" };
    }),
  };
  return { client, calls };
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("AT-R3-1: name → scope derivation", () => {
  it.each([
    ["simple name", "Asset Tracker", "acme", "x_acme_asset_track"],
    ["already snake", "inv", "acme", "x_acme_inv"],
    ["multiple spaces and punctuation", "  My   App!! v2 ", "acme", "x_acme_my_app_v2"],
    ["accents are folded", "Café Ünïcode", "ab", "x_ab_cafe_unicode"],
    ["mixed scripts keep the Latin part", "Отчети Reports", "ab", "x_ab_reports"],
    ["digits", "2024 Audit", "ab", "x_ab_2024_audit"],
    ["overlong is truncated to 18", "Extremely Long Application Name", "acme", "x_acme_extremely_l"],
    ["truncation never leaves a trailing underscore", "abcdefghij klm", "acme", "x_acme_abcdefghij"],
    ["a long prefix leaves a short name", "Tracker", "abcdefghijklm", "x_abcdefghijklm_tr"],
  ])("%s: %j with prefix %j → %j", (_label, name, prefix, expected) => {
    const scope = deriveScopeName(name, prefix);
    expect(scope).toBe(expected);
    expect(scope.length).toBeLessThanOrEqual(SCOPE_MAX_LENGTH);
    expect(scope).toMatch(/^[a-z0-9_]+$/);
  });

  it.each([
    ["only non-Latin letters", "Моето приложение", "acme", /no Latin letters or digits/],
    ["only punctuation", "!!! ---", "acme", /no Latin letters or digits/],
    ["a prefix with no room for a name", "App", "abcdefghijklmnop", /leaves no room/],
  ])("refuses %s", (_label, name, prefix, error) => {
    expect(() => deriveScopeName(name, prefix)).toThrow(error);
  });

  it.each([
    ["accepted as given", " x_acme_custom ", "x_acme_custom"],
    ["at exactly 18 characters", "x_acme_abcdefghijk", "x_acme_abcdefghijk"],
  ])("an explicit --scope is %s", (_label, scope, expected) => {
    expect(deriveScopeName("ignored", "acme", scope)).toBe(expected);
  });

  it.each([
    ["uppercase", "x_acme_Custom", /only lowercase letters, digits and underscores/],
    ["spaces", "x_acme_my app", /only lowercase letters/],
    ["unicode", "x_acme_café", /only lowercase letters/],
    ["overlong (19)", "x_acme_abcdefghijkl", /19 characters long; ServiceNow allows at most 18/],
    ["another vendor's prefix", "x_other_app", /must start with "x_acme_"/],
    ["the bare prefix", "x_acme_", /must start with "x_acme_" \(the vendor prefix\) followed by a name/],
    ["a trailing underscore", "x_acme_app_", /must not end with an underscore/],
  ])("an explicit --scope with %s fails early", (_label, scope, error) => {
    expect(() => deriveScopeName("ignored", "acme", scope)).toThrow(error);
    expect(() => validateScopeName(scope, "acme")).toThrow(AppCreatorError);
  });

  it("snakeCaseName folds, lowercases and collapses separators", () => {
    expect(snakeCaseName("__Hello--World__")).toBe("hello_world");
    expect(snakeCaseName("日本語")).toBe("");
  });
});

describe("vendor prefix", () => {
  it.each([
    ["acme", "acme"],
    ["x_acme_", "acme"],
    ["x_acme", "acme"],
    [" X_ACME_ ", "acme"],
    ["nuvo", "nuvo"],
  ])("normalizes %j to %j", (raw, expected) => {
    expect(normalizeVendorPrefix(raw)).toBe(expected);
  });

  it.each([[""], ["x_"], ["ac me"], ["ac-me"], [42], [null]])("rejects %j", (raw) => {
    expect(normalizeVendorPrefix(raw)).toBeUndefined();
  });

  it("the flag wins and the instance is not asked", async () => {
    const { client, calls } = fakeClient();
    await expect(resolveVendorPrefix(client, { vendorPrefix: "x_flag_" })).resolves.toEqual({
      prefix: "flag",
      source: "flag",
    });
    expect(calls).toEqual([]);
  });

  it("an invalid flag is refused", async () => {
    const { client } = fakeClient();
    await expect(resolveVendorPrefix(client, { vendorPrefix: "a-b" })).rejects.toThrow(
      /--vendor-prefix "a-b" is not a valid vendor prefix/
    );
  });

  it("reads the instance's App Creator prefix (WP-0 shape: x_nuvo_)", async () => {
    const { client } = fakeClient({ vendorPrefix: "x_nuvo_" });
    await expect(resolveVendorPrefix(client)).resolves.toEqual({ prefix: "nuvo", source: "instance" });
  });

  it("falls back to the prefix inside an explicit --scope when the lookup fails", async () => {
    const { client } = fakeClient({ vendorPrefixError: new Error("Request failed with status code 400") });
    await expect(resolveVendorPrefix(client, { scope: "x_acme_app" })).resolves.toEqual({
      prefix: "acme",
      source: "scope",
    });
    expect(mockLoggerWarn).toHaveBeenCalledWith(expect.stringContaining('using "acme" from --scope'));
  });

  it("an unusable instance answer without --scope is an actionable error", async () => {
    const { client } = fakeClient({ vendorPrefix: "" });
    await expect(resolveVendorPrefix(client, { scope: "not-a-scope" })).rejects.toThrow(
      /the instance returned ""\)\. Pass it explicitly with --vendor-prefix/
    );
  });

  it("a non-Error rejection is still reported", async () => {
    const { client } = fakeClient();
    client.getVendorPrefix.mockImplementationOnce(() => Promise.reject("boom"));
    await expect(resolveVendorPrefix(client)).rejects.toThrow(/failed \(boom\)/);
  });

  it("a null instance answer is reported as null", async () => {
    const { client } = fakeClient();
    client.getVendorPrefix.mockImplementationOnce(() => ok(null));
    await expect(resolveVendorPrefix(client)).rejects.toThrow(/the instance returned null/);
  });
});

describe("sys_app helpers", () => {
  it("createScopedApp POSTs the body to sys_app and returns the sys_id", async () => {
    const { client, calls } = fakeClient({ createdSysId: "abc" });
    const body = buildSysAppBody("App", "x_acme_app", "acme");
    await expect(createScopedApp(client, body)).resolves.toBe("abc");
    expect(calls).toEqual([{ method: "POST", target: "sys_app", body }]);
  });

  it("findExistingApp returns the sys_id of a matching scope, or undefined", async () => {
    const { client: hit } = fakeClient({ existingApps: [{ sys_id: "s1" }] });
    await expect(findExistingApp(hit, "x_acme_app")).resolves.toBe("s1");
    // sys_scope, not sys_app: a scope installed from the store lives in
    // sys_store_app, and only their common parent sees both.
    expect(hit.tableAPIGet).toHaveBeenCalledWith("sys_scope", "scope=x_acme_app", "sys_id", 1);
    const { client: miss } = fakeClient({ existingApps: [] });
    await expect(findExistingApp(miss, "x_acme_app")).resolves.toBeUndefined();
    const { client: odd } = fakeClient();
    odd.tableAPIGet.mockImplementationOnce(() => ok({ not: "an array" }));
    await expect(findExistingApp(odd, "x_acme_app")).resolves.toBeUndefined();
  });

  it.each([
    [{ new: true }, true],
    [{ name: "x" }, true],
    [{ scope: "x_a_b" }, true],
    [{ vendorPrefix: "a" }, true],
    [{}, false],
    [{ new: false }, false],
  ])("wantsInitNew(%j) is %s", (args, expected) => {
    expect(wantsInitNew({ logLevel: "info", ...args } as never)).toBe(expected);
  });
});

describe("initNewApp", () => {
  const MANIFEST = { scope: "x_acme_asset_track", tables: {}, scopeId: "app-sys-id-1" };

  function deps(client: ReturnType<typeof fakeClient>["client"], extra: Record<string, unknown> = {}) {
    return {
      getClient: () => client as never,
      resolveInstance: () => "dev1.service-now.com",
      downloadApp: jest.fn(async () => MANIFEST),
      prepareWorkspace: jest.fn(async () => undefined),
      currentManifest: () => undefined,
      ...extra,
    };
  }

  it("AT-R3-2: POSTs the exact sys_app body, then binds with the new scopeId", async () => {
    const { client, calls } = fakeClient();
    const d = deps(client);
    await expect(
      initNewApp({ logLevel: "info", new: true, name: "Asset Tracker" } as never, d)
    ).resolves.toBe(true);

    const posts = calls.filter((c) => c.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]).toEqual({
      method: "POST",
      target: "sys_app",
      body: {
        name: "Asset Tracker",
        scope: "x_acme_asset_track",
        version: "1.0.0",
        vendor_prefix: "acme",
        active: true,
      },
    });
    expect(d.prepareWorkspace).toHaveBeenCalledTimes(1);
    expect(d.downloadApp).toHaveBeenCalledWith("x_acme_asset_track", client, {
      scopeId: "app-sys-id-1",
      justCreated: true,
    });
    expect(mockLoggerSuccess).toHaveBeenCalledWith(expect.stringContaining("sys_id app-sys-id-1"));
  });

  it("uses --scope and --vendor-prefix as given", async () => {
    const { client, calls } = fakeClient();
    await initNewApp(
      { logLevel: "info", new: true, name: "X", scope: "x_mine_tool", vendorPrefix: "mine" } as never,
      deps(client)
    );
    expect(client.getVendorPrefix).not.toHaveBeenCalled();
    expect(calls.find((c) => c.method === "POST")?.body).toMatchObject({
      scope: "x_mine_tool",
      vendor_prefix: "mine",
    });
  });

  it("names the prefix source when it came from --scope", async () => {
    const { client } = fakeClient({ vendorPrefixError: new Error("400") });
    await initNewApp({ logLevel: "info", new: true, name: "X", scope: "x_mine_tool" } as never, deps(client));
    expect(mockLoggerInfo).toHaveBeenCalledWith(expect.stringContaining("(from --scope)"));
  });

  it("AT-R3-3: a failed vendor-prefix lookup is an actionable error and nothing is POSTed", async () => {
    const { client, calls } = fakeClient({
      vendorPrefixError: new Error("Request failed with status code 403"),
    });
    const d = deps(client);
    await expect(
      initNewApp({ logLevel: "info", new: true, name: "Asset Tracker" } as never, d)
    ).rejects.toThrow(/vendor prefix.*403.*--vendor-prefix/s);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
    expect(d.prepareWorkspace).not.toHaveBeenCalled();
  });

  it("AT-R3-4: --dry-run prints the body, exits cleanly and sends zero non-GET requests", async () => {
    const { client, calls } = fakeClient();
    const d = deps(client);
    await expect(
      initNewApp({ logLevel: "info", new: true, name: "Asset Tracker", dryRun: true } as never, d)
    ).resolves.toBe(false);
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every((c) => c.method === "GET")).toBe(true);
    expect(d.prepareWorkspace).not.toHaveBeenCalled();
    expect(d.downloadApp).not.toHaveBeenCalled();
    expect(mockLoggerInfo).toHaveBeenCalledWith(
      'POST /api/now/table/sys_app {"name":"Asset Tracker","scope":"x_acme_asset_track","version":"1.0.0","vendor_prefix":"acme","active":true}'
    );
    expect(mockLoggerInfo).toHaveBeenCalledWith("Nothing was created.");
  });

  it.each([
    ["flags without --new", { name: "X" }, /only apply to `syncrona init --new`/],
    ["--new without --name", { new: true }, /needs the application name/],
    ["--new with a blank --name", { new: true, name: "   " }, /needs the application name/],
    ["an invalid --scope", { new: true, name: "X", scope: "X_ACME_A" }, /only lowercase/],
  ])("refuses %s before any request", async (_label, args, error) => {
    const { client, calls } = fakeClient();
    await expect(initNewApp({ logLevel: "info", ...args } as never, deps(client))).rejects.toThrow(error);
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });

  it("refuses a directory that is already bound", async () => {
    const { client, calls } = fakeClient();
    await expect(
      initNewApp(
        { logLevel: "info", new: true, name: "X" } as never,
        deps(client, { currentManifest: () => ({ scope: "x_old_app", tables: {} }) })
      )
    ).rejects.toThrow(/already bound to scope "x_old_app"/);
    expect(calls).toEqual([]);
  });

  it("refuses when no instance is configured", async () => {
    const { client, calls } = fakeClient();
    await expect(
      initNewApp({ logLevel: "info", new: true, name: "X" } as never, deps(client, { resolveInstance: () => "" }))
    ).rejects.toThrow(/No ServiceNow instance is configured/);
    expect(calls).toEqual([]);
  });

  it("refuses an existing scope and points at the binding commands", async () => {
    const { client, calls } = fakeClient({ existingApps: [{ sys_id: "old-1" }] });
    await expect(
      initNewApp({ logLevel: "info", new: true, name: "Asset Tracker" } as never, deps(client))
    ).rejects.toThrow(/already exists on dev1\.service-now\.com \(sys_id old-1\).*syncrona download x_acme_asset_track/);
    expect(calls.filter((c) => c.method === "POST")).toEqual([]);
  });

  it.each([
    ["an Error", new Error("disk full")],
    ["a non-Error", "disk full"],
  ])("a failed bind (%s) reports the created sys_id and the recovery command", async (_label, failure) => {
    const { client } = fakeClient();
    await expect(
      initNewApp(
        { logLevel: "info", new: true, name: "Asset Tracker" } as never,
        deps(client, { downloadApp: jest.fn(async () => Promise.reject(failure)) })
      )
    ).rejects.toThrow(
      /created \(sys_id app-sys-id-1\), but binding this directory failed: disk full Do not re-run init --new/
    );
  });

  it("the failed-bind recovery spells out the manifest instead of recommending `download`", async () => {
    // `syncrona download <scope>` refuses a scope that owns no records, which a
    // just-created one usually is, so it cannot be THE recovery.
    const { client } = fakeClient();
    const error = await initNewApp(
      { logLevel: "info", new: true, name: "Asset Tracker" } as never,
      deps(client, { downloadApp: jest.fn(async () => Promise.reject(new Error("disk full"))) })
    ).catch((e: unknown) => e as Error);
    expect(error).toBeInstanceOf(AppCreatorError);
    expect((error as Error).message).toContain(
      'Bind this directory by writing sync.manifest.json with {"scope":"x_acme_asset_track","scopeId":"app-sys-id-1","tables":{}}'
    );
    expect((error as Error).message).not.toMatch(/Re-run the binding with `syncrona download/);
    expect((error as Error).message).toContain(
      "`syncrona download x_acme_asset_track` only works once the scope owns records."
    );
  });
});

describe("defaultInitNewDeps (real adapters)", () => {
  const originalCwd = process.cwd();
  const originalInstance = process.env.SN_INSTANCE;
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-init-new-"));
    process.chdir(tmp);
    ConfigManager.resetConfigState();
  });

  afterEach(() => {
    process.chdir(originalCwd);
    ConfigManager.resetConfigState();
    fs.rmSync(tmp, { recursive: true, force: true });
    if (originalInstance === undefined) delete process.env.SN_INSTANCE;
    else process.env.SN_INSTANCE = originalInstance;
  });

  it("prepareWorkspace writes sync.config.js and the source directory once", async () => {
    await ConfigManager.loadConfigs();
    const d = defaultInitNewDeps();
    expect(d.currentManifest()).toBeUndefined();
    await d.prepareWorkspace();
    expect(fs.existsSync(path.join(tmp, "sync.config.js"))).toBe(true);
    expect(fs.statSync(path.join(tmp, "src")).isDirectory()).toBe(true);
    fs.writeFileSync(path.join(tmp, "sync.config.js"), "module.exports = { sourceDirectory: 'custom' };\n");
    await d.prepareWorkspace();
    expect(fs.readFileSync(path.join(tmp, "sync.config.js"), "utf8")).toContain("custom");
    expect(fs.statSync(path.join(tmp, "custom")).isDirectory()).toBe(true);
  });

  it("delegates the instance, client and download to the real modules", async () => {
    process.env.SN_INSTANCE = "dev2.service-now.com";
    const d = defaultInitNewDeps();
    expect(typeof d.resolveInstance()).toBe("string");
    const client = d.getClient();
    expect(typeof client.getVendorPrefix).toBe("function");
    mockWizardDownloadApp.mockResolvedValueOnce({ scope: "x_a_b", tables: {} } as never);
    await expect(d.downloadApp("x_a_b", client, { scopeId: "s" })).resolves.toEqual({
      scope: "x_a_b",
      tables: {},
    });
    expect(mockWizardDownloadApp).toHaveBeenCalledWith("x_a_b", client, { scopeId: "s" });
  });
});
