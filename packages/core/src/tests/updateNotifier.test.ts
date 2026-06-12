import fs from "fs";
import os from "os";
import path from "path";

import {
  buildUpdateNotice,
  compareSemver,
  isNewerVersion,
  notifierDisabled,
  parseSemver,
  readUpdateCache,
  runUpdateNotifier,
  selectNotice,
  shouldRefresh,
  UPDATE_CHECK_INTERVAL_MS,
  writeUpdateCache,
  type UpdateCache,
} from "../updateNotifier";

describe("updateNotifier pure helpers", () => {
  describe("parseSemver", () => {
    it("parses release and prerelease versions", () => {
      expect(parseSemver("1.2.3")).toEqual({ major: 1, minor: 2, patch: 3, pre: "" });
      expect(parseSemver("v0.4.2-alpha.8")).toEqual({
        major: 0,
        minor: 4,
        patch: 2,
        pre: "alpha.8",
      });
    });

    it("returns null for unparseable input", () => {
      expect(parseSemver("not-a-version")).toBeNull();
      expect(parseSemver("")).toBeNull();
    });
  });

  describe("compareSemver / isNewerVersion", () => {
    it("orders by major, minor, patch", () => {
      expect(compareSemver("1.0.0", "0.9.9")).toBe(1);
      expect(compareSemver("0.4.1", "0.4.2")).toBe(-1);
      expect(compareSemver("0.4.2", "0.4.2")).toBe(0);
    });

    it("ranks a release above a prerelease of the same version", () => {
      expect(compareSemver("0.4.2", "0.4.2-alpha.8")).toBe(1);
      expect(isNewerVersion("0.4.2", "0.4.2-alpha.8")).toBe(true);
    });

    it("orders prerelease identifiers numerically and lexically", () => {
      expect(compareSemver("0.4.2-alpha.9", "0.4.2-alpha.8")).toBe(1);
      expect(compareSemver("0.4.2-alpha.8", "0.4.2-beta.1")).toBe(-1);
      expect(isNewerVersion("0.4.2-alpha.8", "0.4.2-alpha.9")).toBe(false);
    });

    it("treats unparseable versions as equal (safe no-op)", () => {
      expect(compareSemver("garbage", "1.0.0")).toBe(0);
      expect(isNewerVersion("garbage", "1.0.0")).toBe(false);
    });
  });

  describe("shouldRefresh", () => {
    const now = 1_000_000_000_000;

    it("refreshes when there is no prior check", () => {
      expect(shouldRefresh(0, now)).toBe(true);
      expect(shouldRefresh(Number.NaN, now)).toBe(true);
    });

    it("does not refresh within the interval", () => {
      expect(shouldRefresh(now - 1000, now)).toBe(false);
    });

    it("refreshes once the interval has elapsed", () => {
      expect(shouldRefresh(now - UPDATE_CHECK_INTERVAL_MS, now)).toBe(true);
    });
  });

  describe("buildUpdateNotice", () => {
    it("includes both versions and the install command", () => {
      const notice = buildUpdateNotice("0.4.2-alpha.8", "0.5.0");
      expect(notice).toContain("0.4.2-alpha.8");
      expect(notice).toContain("0.5.0");
      expect(notice).toContain("npm i -g @syncrona/core");
    });
  });

  describe("notifierDisabled", () => {
    it("is disabled in CI and under jest", () => {
      expect(notifierDisabled({ CI: "true" })).toBe(true);
      expect(notifierDisabled({ JEST_WORKER_ID: "1" })).toBe(true);
    });

    it("honours opt-out environment variables", () => {
      expect(notifierDisabled({ SYNCRONA_NO_UPDATE_NOTIFIER: "1" })).toBe(true);
      expect(notifierDisabled({ NO_UPDATE_NOTIFIER: "true" })).toBe(true);
    });

    it("is enabled for a clean environment", () => {
      expect(notifierDisabled({})).toBe(false);
    });
  });

  describe("selectNotice", () => {
    it("returns null without a cache or newer version", () => {
      expect(selectNotice({ current: "1.0.0", cache: null })).toBeNull();
      const olderCache: UpdateCache = { lastCheckMs: 1, latestVersion: "0.9.0" };
      expect(selectNotice({ current: "1.0.0", cache: olderCache })).toBeNull();
    });

    it("returns a notice for a newer, not-yet-notified version", () => {
      const cache: UpdateCache = { lastCheckMs: 1, latestVersion: "2.0.0" };
      expect(selectNotice({ current: "1.0.0", cache })).toContain("2.0.0");
    });

    it("suppresses repeat notices for an already-notified version", () => {
      const cache: UpdateCache = {
        lastCheckMs: 1,
        latestVersion: "2.0.0",
        notifiedVersion: "2.0.0",
      };
      expect(selectNotice({ current: "1.0.0", cache })).toBeNull();
    });
  });
});

describe("updateNotifier cache IO", () => {
  let tempDir: string;
  let cacheFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-upd-"));
    cacheFile = path.join(tempDir, "nested", "update-check.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("round-trips a cache entry, creating directories as needed", () => {
    const cache: UpdateCache = { lastCheckMs: 123, latestVersion: "1.2.3", notifiedVersion: "1.2.3" };
    writeUpdateCache(cacheFile, cache);
    expect(readUpdateCache(cacheFile)).toEqual(cache);
  });

  it("returns null for a missing or malformed cache file", () => {
    expect(readUpdateCache(path.join(tempDir, "missing.json"))).toBeNull();
    fs.writeFileSync(path.join(tempDir, "bad.json"), "{ not json");
    expect(readUpdateCache(path.join(tempDir, "bad.json"))).toBeNull();
  });
});

describe("runUpdateNotifier orchestration", () => {
  let tempDir: string;
  let cacheFile: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-upd-run-"));
    cacheFile = path.join(tempDir, "update-check.json");
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("fetches, caches, and prints a notice once per newer version", async () => {
    const lines: string[] = [];
    const baseDeps = {
      env: {} as NodeJS.ProcessEnv,
      isTTY: true,
      currentVersion: "1.0.0",
      cacheFile,
      nowMs: 1_000,
      fetchLatest: jest.fn().mockResolvedValue("2.0.0"),
      output: (line: string) => lines.push(line),
    };

    await runUpdateNotifier(baseDeps);

    expect(baseDeps.fetchLatest).toHaveBeenCalledTimes(1);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("2.0.0");

    const cached = readUpdateCache(cacheFile);
    expect(cached?.latestVersion).toBe("2.0.0");
    expect(cached?.notifiedVersion).toBe("2.0.0");

    // Second run within the interval: no fetch, no repeat notice.
    const secondLines: string[] = [];
    await runUpdateNotifier({
      ...baseDeps,
      nowMs: 2_000,
      fetchLatest: jest.fn().mockResolvedValue("2.0.0"),
      output: (line: string) => secondLines.push(line),
    });
    expect(secondLines).toHaveLength(0);
  });

  it("does nothing when disabled or not a TTY", async () => {
    const fetchLatest = jest.fn().mockResolvedValue("2.0.0");
    const lines: string[] = [];

    await runUpdateNotifier({
      env: { CI: "true" },
      isTTY: true,
      currentVersion: "1.0.0",
      cacheFile,
      fetchLatest,
      output: (line: string) => lines.push(line),
    });
    await runUpdateNotifier({
      env: {},
      isTTY: false,
      currentVersion: "1.0.0",
      cacheFile,
      fetchLatest,
      output: (line: string) => lines.push(line),
    });

    expect(fetchLatest).not.toHaveBeenCalled();
    expect(lines).toHaveLength(0);
  });

  it("never throws when the registry fetch fails", async () => {
    const lines: string[] = [];
    await expect(
      runUpdateNotifier({
        env: {},
        isTTY: true,
        currentVersion: "1.0.0",
        cacheFile,
        nowMs: 5_000,
        fetchLatest: jest.fn().mockRejectedValue(new Error("network down")),
        output: (line: string) => lines.push(line),
      })
    ).resolves.toBeUndefined();
    expect(lines).toHaveLength(0);
  });
});
