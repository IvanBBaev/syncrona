import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import path from "path";
import { getSyncronaDir } from "./auth";

/**
 * Best-effort "a newer version is available" notifier for the Syncrona CLI.
 *
 * Design goals:
 *  - Never disrupt or slow down the CLI: all failures are swallowed, the
 *    registry is queried at most once per day, and the whole feature is a
 *    no-op in CI / tests / when opted out / when stderr is not a TTY.
 *  - Notice prints once per discovered newer version (no per-run nagging).
 *  - The decision logic is pure and unit-tested; only the thin IO wrappers
 *    (registry fetch, cache file, package.json read) touch the environment.
 */

export const UPDATE_CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000; // once per day
export const PACKAGE_NAME = "@syncrona/core";
export const DISPLAY_NAME = "syncrona";
const REGISTRY_BASE = "https://registry.npmjs.org";
const FETCH_TIMEOUT_MS = 1500;
const CACHE_FILE_NAME = "update-check.json";

export type UpdateCache = {
  lastCheckMs: number;
  latestVersion: string;
  notifiedVersion?: string;
};

export type ParsedSemver = {
  major: number;
  minor: number;
  patch: number;
  pre: string;
};

export type UpdateNotifierDeps = {
  env?: NodeJS.ProcessEnv;
  nowMs?: number;
  currentVersion?: string;
  cacheFile?: string;
  isTTY?: boolean;
  fetchLatest?: (packageName: string) => Promise<string | null>;
  output?: (line: string) => void;
};

// --- pure helpers (unit-tested) -------------------------------------------

export function parseSemver(value: string): ParsedSemver | null {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(value).trim());
  if (!match) {
    return null;
  }
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    pre: match[4] ?? "",
  };
}

function comparePrerelease(a: string, b: string): number {
  const aParts = a.split(".");
  const bParts = b.split(".");
  const length = Math.max(aParts.length, bParts.length);
  for (let index = 0; index < length; index += 1) {
    const x = aParts[index];
    const y = bParts[index];
    if (x === undefined) {
      return -1;
    }
    if (y === undefined) {
      return 1;
    }
    const xIsNumeric = /^\d+$/.test(x);
    const yIsNumeric = /^\d+$/.test(y);
    if (xIsNumeric && yIsNumeric) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) {
        return diff < 0 ? -1 : 1;
      }
    } else if (xIsNumeric) {
      return -1;
    } else if (yIsNumeric) {
      return 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

export function compareSemver(a: string, b: string): number {
  const parsedA = parseSemver(a);
  const parsedB = parseSemver(b);
  if (!parsedA || !parsedB) {
    return 0;
  }
  if (parsedA.major !== parsedB.major) {
    return parsedA.major < parsedB.major ? -1 : 1;
  }
  if (parsedA.minor !== parsedB.minor) {
    return parsedA.minor < parsedB.minor ? -1 : 1;
  }
  if (parsedA.patch !== parsedB.patch) {
    return parsedA.patch < parsedB.patch ? -1 : 1;
  }
  if (parsedA.pre === parsedB.pre) {
    return 0;
  }
  // A release (no prerelease tag) ranks above a prerelease of the same x.y.z.
  if (parsedA.pre === "") {
    return 1;
  }
  if (parsedB.pre === "") {
    return -1;
  }
  return comparePrerelease(parsedA.pre, parsedB.pre);
}

export function isNewerVersion(latest: string, current: string): boolean {
  return compareSemver(latest, current) > 0;
}

export function shouldRefresh(
  lastCheckMs: number,
  nowMs: number,
  intervalMs: number = UPDATE_CHECK_INTERVAL_MS
): boolean {
  if (!Number.isFinite(lastCheckMs) || lastCheckMs <= 0) {
    return true;
  }
  return nowMs - lastCheckMs >= intervalMs;
}

export function buildUpdateNotice(
  current: string,
  latest: string,
  displayName: string = DISPLAY_NAME
): string {
  return `Update available for ${displayName}: ${current} \u2192 ${latest}. Run: npm i -g ${PACKAGE_NAME}`;
}

export function notifierDisabled(env: NodeJS.ProcessEnv): boolean {
  if (env.JEST_WORKER_ID) {
    return true;
  }
  if (env.CI) {
    return true;
  }
  const optOut = (key: string): boolean => env[key] === "1" || env[key] === "true";
  return optOut("SYNCRONA_NO_UPDATE_NOTIFIER") || optOut("NO_UPDATE_NOTIFIER");
}

export function selectNotice(options: {
  current: string;
  cache: UpdateCache | null;
  displayName?: string;
}): string | null {
  const { current, cache, displayName = DISPLAY_NAME } = options;
  if (!cache || !cache.latestVersion) {
    return null;
  }
  if (!isNewerVersion(cache.latestVersion, current)) {
    return null;
  }
  if (cache.notifiedVersion === cache.latestVersion) {
    return null;
  }
  return buildUpdateNotice(current, cache.latestVersion, displayName);
}

// --- thin IO wrappers ------------------------------------------------------

export function readUpdateCache(cacheFile: string): UpdateCache | null {
  try {
    if (!existsSync(cacheFile)) {
      return null;
    }
    const parsed = JSON.parse(readFileSync(cacheFile, "utf-8")) as Partial<UpdateCache>;
    if (typeof parsed.latestVersion !== "string") {
      return null;
    }
    return {
      lastCheckMs: typeof parsed.lastCheckMs === "number" ? parsed.lastCheckMs : 0,
      latestVersion: parsed.latestVersion,
      notifiedVersion:
        typeof parsed.notifiedVersion === "string" ? parsed.notifiedVersion : undefined,
    };
  } catch (_) {
    return null;
  }
}

export function writeUpdateCache(cacheFile: string, cache: UpdateCache): void {
  try {
    mkdirSync(path.dirname(cacheFile), { recursive: true });
    writeFileSync(cacheFile, `${JSON.stringify(cache)}\n`, "utf-8");
  } catch (_) {
    // best-effort cache; ignore write failures
  }
}

export function resolveCurrentVersion(): string {
  try {
    const pkgPath = path.join(__dirname, "..", "package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "";
  } catch (_) {
    return "";
  }
}

export async function fetchLatestVersion(
  packageName: string,
  timeoutMs: number = FETCH_TIMEOUT_MS
): Promise<string | null> {
  if (typeof fetch !== "function") {
    return null;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const url = `${REGISTRY_BASE}/${packageName.replace("/", "%2F")}/latest`;
    const response = await fetch(url, {
      signal: controller.signal,
      headers: { accept: "application/json" },
    });
    if (!response.ok) {
      return null;
    }
    const data = (await response.json()) as { version?: unknown };
    return typeof data.version === "string" ? data.version : null;
  } catch (_) {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

// --- orchestrator (best-effort, never throws) ------------------------------

export async function runUpdateNotifier(deps: UpdateNotifierDeps = {}): Promise<void> {
  try {
    const env = deps.env ?? process.env;
    if (notifierDisabled(env)) {
      return;
    }
    const isTTY = deps.isTTY ?? Boolean(process.stderr.isTTY);
    if (!isTTY) {
      return;
    }

    const current = deps.currentVersion ?? resolveCurrentVersion();
    if (!current) {
      return;
    }
    const cacheFile = deps.cacheFile ?? path.join(getSyncronaDir(), CACHE_FILE_NAME);
    const now = deps.nowMs ?? Date.now();
    const fetchLatest = deps.fetchLatest ?? fetchLatestVersion;
    const output = deps.output ?? ((line: string) => process.stderr.write(`${line}\n`));

    let cache = readUpdateCache(cacheFile);
    if (shouldRefresh(cache?.lastCheckMs ?? 0, now)) {
      const latest = await fetchLatest(PACKAGE_NAME);
      cache = {
        lastCheckMs: now,
        latestVersion: latest ?? cache?.latestVersion ?? "",
        notifiedVersion: cache?.notifiedVersion,
      };
      writeUpdateCache(cacheFile, cache);
    }

    const notice = selectNotice({ current, cache });
    if (notice && cache) {
      output(notice);
      writeUpdateCache(cacheFile, { ...cache, notifiedVersion: cache.latestVersion });
    }
  } catch (_) {
    // best-effort: a version check must never break or block the CLI
  }
}
