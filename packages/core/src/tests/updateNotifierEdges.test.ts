// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
export {};

// Branches the other updateNotifier suites leave open: the "a > b" arms of the
// version comparison, a cache file with mistyped optional fields, a package.json
// without a string version, a registry fetch that fails with and without a
// previous cache, and runUpdateNotifier with every dependency left at its
// production default. The default cache path comes from getSyncronaDir(), which
// is mocked to a temp dir so nothing touches the real ~/.syncrona, and the
// global fetch is stubbed so no request leaves the machine.

let syncronaDir = "";
let packageJsonOverride: string | null = null;

jest.unstable_mockModule("../auth.js", () => ({
  getSyncronaDir: () => syncronaDir,
}));

jest.unstable_mockModule("fs", () => {
  const actual = jest.requireActual("fs") as typeof import("fs");
  const readFileSync = ((file: fs.PathOrFileDescriptor, options?: unknown) => {
    if (packageJsonOverride !== null && String(file).endsWith(`${path.sep}package.json`)) {
      return packageJsonOverride;
    }
    return (actual.readFileSync as (f: unknown, o?: unknown) => unknown)(file, options);
  }) as typeof actual.readFileSync;
  return { ...actual, readFileSync, default: { ...actual, readFileSync } };
});

const {
  compareSemver,
  readUpdateCache,
  resolveCurrentVersion,
  runUpdateNotifier,
  UPDATE_CHECK_INTERVAL_MS,
} = await import("../updateNotifier.js");

const NOW = 10 * UPDATE_CHECK_INTERVAL_MS;
let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-upd-edges-"));
  syncronaDir = tempDir;
  packageJsonOverride = null;
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("compareSemver greater-than arms", () => {
  it("ranks a higher patch above a lower one", () => {
    expect(compareSemver("1.0.5", "1.0.2")).toBe(1);
  });

  it("ranks a higher numeric prerelease identifier above a lower one", () => {
    expect(compareSemver("1.0.0-rc.10", "1.0.0-rc.2")).toBe(1);
  });

  it("moves past an equal numeric identifier and ties numerically equal prereleases", () => {
    expect(compareSemver("1.0.0-1.beta", "1.0.0-1.alpha")).toBe(1);
    // "01" and "1" are numerically equal, so the prereleases compare equal.
    expect(compareSemver("1.0.0-rc.01", "1.0.0-rc.1")).toBe(0);
  });

  it("orders alphanumeric prerelease identifiers lexically", () => {
    expect(compareSemver("1.0.0-beta", "1.0.0-alpha")).toBe(1);
    expect(compareSemver("1.0.0-alpha", "1.0.0-beta")).toBe(-1);
  });
});

describe("readUpdateCache field coercion", () => {
  it("defaults a mistyped lastCheckMs to 0 and drops a mistyped notifiedVersion", () => {
    const file = path.join(tempDir, "update-check.json");
    fs.writeFileSync(
      file,
      JSON.stringify({ lastCheckMs: "yesterday", latestVersion: "2.0.0", notifiedVersion: 2 })
    );

    expect(readUpdateCache(file)).toEqual({
      lastCheckMs: 0,
      latestVersion: "2.0.0",
      notifiedVersion: undefined,
    });
  });
});

describe("resolveCurrentVersion", () => {
  it("returns an empty version when package.json has no string version", () => {
    packageJsonOverride = JSON.stringify({ name: "syncrona", version: 3 });
    expect(resolveCurrentVersion()).toBe("");
  });

  it("returns an empty version when package.json is not valid JSON", () => {
    packageJsonOverride = "{ not json";
    expect(resolveCurrentVersion()).toBe("");
  });
});

describe("runUpdateNotifier registry failure", () => {
  it("keeps the previously cached latest version when the registry fetch fails", async () => {
    const cacheFile = path.join(tempDir, "cache.json");
    fs.writeFileSync(cacheFile, JSON.stringify({ lastCheckMs: 1, latestVersion: "2.0.0" }));
    const lines: string[] = [];

    await runUpdateNotifier({
      env: {},
      isTTY: true,
      nowMs: NOW,
      currentVersion: "1.0.0",
      cacheFile,
      fetchLatest: async () => null,
      output: (line) => lines.push(line),
    });

    expect(lines).toEqual([expect.stringContaining("1.0.0 → 2.0.0")]);
    expect(JSON.parse(fs.readFileSync(cacheFile, "utf-8"))).toEqual({
      lastCheckMs: NOW,
      latestVersion: "2.0.0",
      notifiedVersion: "2.0.0",
    });
  });

  it("records an empty latest version when the first-ever fetch fails", async () => {
    const cacheFile = path.join(tempDir, "cache.json");
    const lines: string[] = [];

    await runUpdateNotifier({
      env: {},
      isTTY: true,
      nowMs: NOW,
      currentVersion: "1.0.0",
      cacheFile,
      fetchLatest: async () => null,
      output: (line) => lines.push(line),
    });

    expect(lines).toEqual([]);
    expect(JSON.parse(fs.readFileSync(cacheFile, "utf-8"))).toEqual({
      lastCheckMs: NOW,
      latestVersion: "",
    });
  });
});

describe("runUpdateNotifier production defaults", () => {
  const savedEnv = { ...process.env };
  const savedFetch = globalThis.fetch;
  const savedIsTTY = process.stderr.isTTY;

  afterEach(() => {
    process.env = { ...savedEnv };
    globalThis.fetch = savedFetch;
    process.stderr.isTTY = savedIsTTY;
    jest.restoreAllMocks();
  });

  it("does nothing under jest when called without dependencies", async () => {
    const fetchStub = jest.fn(async () => {
      throw new Error("must not fetch");
    });
    globalThis.fetch = fetchStub as unknown as typeof fetch;

    await runUpdateNotifier();

    expect(fetchStub).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(tempDir, "update-check.json"))).toBe(false);
  });

  it("stays silent when stderr is not a terminal", async () => {
    const env = { ...savedEnv };
    delete env.JEST_WORKER_ID;
    delete env.CI;
    delete env.SYNCRONA_NO_UPDATE_NOTIFIER;
    delete env.NO_UPDATE_NOTIFIER;
    process.stderr.isTTY = false;
    const fetchLatest = jest.fn(async () => "999.0.0");

    await runUpdateNotifier({ env, fetchLatest });

    expect(fetchLatest).not.toHaveBeenCalled();
  });

  it("uses the package version, the syncrona dir cache, fetch and stderr by default", async () => {
    delete process.env.JEST_WORKER_ID;
    delete process.env.CI;
    delete process.env.SYNCRONA_NO_UPDATE_NOTIFIER;
    delete process.env.NO_UPDATE_NOTIFIER;
    process.stderr.isTTY = true;
    const fetchStub = jest.fn(async (url: string) => {
      expect(url).toBe("https://registry.npmjs.org/syncrona/latest");
      return { ok: true, json: async () => ({ version: "999.0.0" }) };
    });
    globalThis.fetch = fetchStub as unknown as typeof fetch;
    const written: string[] = [];
    jest.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      written.push(String(chunk));
      return true;
    });
    const current = resolveCurrentVersion();

    await runUpdateNotifier();

    expect(fetchStub).toHaveBeenCalledTimes(1);
    expect(written).toEqual([
      `Update available for syncrona: ${current} → 999.0.0. Run: npm i -g syncrona\n`,
    ]);
    const cache = JSON.parse(fs.readFileSync(path.join(tempDir, "update-check.json"), "utf-8"));
    expect(cache).toMatchObject({ latestVersion: "999.0.0", notifiedVersion: "999.0.0" });
    expect(cache.lastCheckMs).toBeGreaterThan(0);
  });
});
