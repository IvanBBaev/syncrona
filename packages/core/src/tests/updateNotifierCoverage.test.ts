// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

import {
  compareSemver,
  fetchLatestVersion,
  readUpdateCache,
  resolveCurrentVersion,
  runUpdateNotifier,
} from "../updateNotifier.js";

// This suite closes the coverage gaps the base updateNotifier.test.ts leaves:
//  - the prerelease-ordering branches inside comparePrerelease (reached only
//    through compareSemver): shorter-vs-longer identifier lists and the
//    numeric-vs-alphanumeric tie-breaks,
//  - the compareSemver minor-difference and "release outranks prerelease" arms,
//  - readUpdateCache rejecting a cache whose latestVersion is not a string,
//  - resolveCurrentVersion reading the package's real package.json,
//  - fetchLatestVersion against a fully mocked global fetch (NO real network),
//  - runUpdateNotifier's early return when no current version can be resolved.

describe("compareSemver prerelease and version branches", () => {
  it("orders a shorter prerelease identifier list below a longer prefix-equal one", () => {
    // aParts runs out first (x === undefined) → a < b.
    expect(compareSemver("1.0.0-alpha", "1.0.0-alpha.1")).toBe(-1);
    // bParts runs out first (y === undefined) → a > b.
    expect(compareSemver("1.0.0-alpha.1", "1.0.0-alpha")).toBe(1);
  });

  it("ranks a numeric prerelease identifier below an alphanumeric one at the same position", () => {
    // xIsNumeric && !yIsNumeric → a < b.
    expect(compareSemver("1.0.0-1", "1.0.0-alpha")).toBe(-1);
    // !xIsNumeric && yIsNumeric → a > b.
    expect(compareSemver("1.0.0-alpha", "1.0.0-1")).toBe(1);
  });

  it("orders by minor version when major matches", () => {
    expect(compareSemver("1.2.0", "1.5.0")).toBe(-1);
    expect(compareSemver("1.5.0", "1.2.0")).toBe(1);
  });

  it("ranks a prerelease below the matching release from either argument position", () => {
    // parsedA is the release (pre === "") → a > b.
    expect(compareSemver("1.0.0", "1.0.0-beta")).toBe(1);
    // parsedB is the release (pre === "") → a < b.
    expect(compareSemver("1.0.0-beta", "1.0.0")).toBe(-1);
  });
});

describe("readUpdateCache rejects a non-string latestVersion", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-upd-cov-"));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("returns null when latestVersion is present but not a string", () => {
    const cacheFile = path.join(tempDir, "cache.json");
    fs.writeFileSync(cacheFile, JSON.stringify({ lastCheckMs: 1, latestVersion: 42 }), "utf-8");
    expect(readUpdateCache(cacheFile)).toBeNull();
  });
});

describe("resolveCurrentVersion", () => {
  it("reads the package's real version string from package.json", () => {
    const version = resolveCurrentVersion();
    // The core package always carries a semver-shaped version; the function must
    // surface it as a string (empty only if the read/parse fails, which it does
    // not for the real, adjacent package.json).
    expect(typeof version).toBe("string");
    expect(version).toMatch(/^\d+\.\d+\.\d+/);
  });
});

describe("fetchLatestVersion with a mocked global fetch", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it("returns the version from a successful registry response", async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ version: "9.9.9" }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    await expect(fetchLatestVersion("syncrona")).resolves.toBe("9.9.9");

    // The unscoped package name sits directly in the registry path (no scope
    // slash to URL-encode).
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const requestedUrl = String(fetchMock.mock.calls[0][0]);
    expect(requestedUrl).toBe("https://registry.npmjs.org/syncrona/latest");
  });

  it("returns null when the response is not ok", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: false, json: async () => ({}) }) as unknown as typeof fetch;
    await expect(fetchLatestVersion("syncrona")).resolves.toBeNull();
  });

  it("returns null when the payload has no string version", async () => {
    global.fetch = jest
      .fn()
      .mockResolvedValue({ ok: true, json: async () => ({ version: 123 }) }) as unknown as typeof fetch;
    await expect(fetchLatestVersion("syncrona")).resolves.toBeNull();
  });

  it("returns null (swallows) when fetch rejects", async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error("network down")) as unknown as typeof fetch;
    await expect(fetchLatestVersion("syncrona")).resolves.toBeNull();
  });

  it("returns null when the global fetch is unavailable", async () => {
    // typeof fetch !== "function" short-circuits before any network attempt.
    (global as { fetch?: unknown }).fetch = undefined;
    await expect(fetchLatestVersion("syncrona")).resolves.toBeNull();
  });
});

describe("runUpdateNotifier no-current-version guard", () => {
  it("returns early and never fetches when the current version cannot be resolved", async () => {
    const fetchLatest = jest.fn();
    const output = jest.fn();

    await runUpdateNotifier({
      env: {} as NodeJS.ProcessEnv,
      isTTY: true,
      // An empty resolved version aborts before touching the cache or registry.
      currentVersion: "",
      fetchLatest,
      output,
    });

    expect(fetchLatest).not.toHaveBeenCalled();
    expect(output).not.toHaveBeenCalled();
  });
});
