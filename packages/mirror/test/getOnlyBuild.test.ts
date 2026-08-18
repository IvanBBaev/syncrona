// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * INV-2 — `@syncrona/mirror` performs GET requests only (Phases 0–3).
 *
 * This is the invariant that makes the mirror safe to point at production: a
 * read-only tool cannot corrupt the instance it is mirroring, and that promise
 * is worth exactly as much as the enforcement behind it. A code review can be
 * skipped and a comment can be stale, so the invariant is checked mechanically
 * against the BUILT output (§12): the JavaScript that would actually ship.
 *
 * How this test fails when someone adds a write
 * ---------------------------------------------
 * Say a future work package adds `await this.fetchImpl(url, { method: "POST" })`
 * to `client.ts`, or reaches for `axios.patch(...)`. `tsc` emits that literal
 * into `http/client.js`; {@link findStateChangingVerbs} matches it; the test
 * names the file, the line and the verb. There is no passing configuration for
 * it short of removing the write, granting the module an explicit exemption
 * here (a visible, reviewable edit to this file), or deleting this test.
 *
 * Why the build happens inside the test
 * -------------------------------------
 * Scanning a committed `dist/` would prove only that the invariant held whenever
 * that directory was last written. A developer who adds a write and runs the
 * suite without rebuilding would get a green run against a stale artifact — the
 * exact moment the check is supposed to fire. So the test compiles the current
 * `src/` into a scratch directory and scans that. `--removeComments` is passed
 * for a second reason: this very docblock contains the words POST, PUT, PATCH
 * and DELETE, and a scanner that matched prose would be satisfied by prose.
 *
 * Why it cannot pass vacuously
 * ----------------------------
 * A grep that finds nothing looks identical whether the code is clean or the
 * directory is empty. Three separate assertions close that gap: the emitted file
 * set must equal the source file set (nothing excluded from the build, nothing
 * missed by the walk), the scan must have read a non-trivial amount of code, and
 * the detector itself is unit-tested against writes it must catch and reads it
 * must not flag. If `dist` came back empty, the first assertion fails long
 * before the grep gets a chance to be trivially true.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative, sep } from "node:path";

const PACKAGE_ROOT = join(__dirname, "..");
const SRC_ROOT = join(PACKAGE_ROOT, "src");
const TSCONFIG = join(PACKAGE_ROOT, "tsconfig.json");

/** Verbs that change state on the far side of an HTTP request. */
const STATE_CHANGING = ["POST", "PUT", "PATCH", "DELETE"] as const;

interface Finding {
  file: string;
  line: number;
  text: string;
}

/**
 * Find HTTP writes in emitted JavaScript.
 *
 * Two rule families, because a write can be spelled two ways:
 *
 *  1. A quoted verb — `{ method: "POST" }`, `request("DELETE", url)`. Matched on
 *     the quoted uppercase token, which is how every HTTP client on earth names
 *     a method and is not how anything else in this package names anything.
 *  2. A verb-shaped method call — `axios.post(...)`, `client.put(...)`. `.delete(`
 *     is the awkward one: `Map.prototype.delete` and `Set.prototype.delete` are
 *     ordinary local operations, so it counts only on a receiver that looks like
 *     an HTTP client. That narrowing is deliberate and is why rule 1 exists — a
 *     real HTTP delete through a helper still names the verb somewhere.
 */
export const findStateChangingVerbs = (source: string, file = "<memory>"): Finding[] => {
  const quoted = new RegExp(`["'\`](${STATE_CHANGING.join("|")})["'\`]`);
  const called = /\.(post|put|patch)\s*\(/i;
  const deleted = /\b(axios|http|https|client|request|fetch|api|transport|conn|session|agent)\w*\s*\.\s*delete\s*\(/i;

  const findings: Finding[] = [];
  source.split("\n").forEach((line, index) => {
    if (quoted.test(line) || called.test(line) || deleted.test(line)) {
      findings.push({ file, line: index + 1, text: line.trim() });
    }
  });
  return findings;
};

const walk = (root: string): string[] => {
  const out: string[] = [];
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) {
      out.push(...walk(full));
    } else {
      out.push(full);
    }
  }
  return out.sort();
};

const posix = (path: string): string => path.split(sep).join("/");

describe("the state-changing-verb detector", () => {
  // The scanner is the load-bearing part of INV-2's enforcement, so it is tested
  // before it is trusted. A detector that silently matched nothing would make
  // the invariant check below a very confident no-op.
  it.each([
    ['fetch(url, { method: "POST" })'],
    ["fetch(url, { method: 'PATCH' })"],
    ["const init = { method: `PUT` };"],
    ['xhr.open("DELETE", url);'],
    ["axios.post(url, body);"],
    ["this.http.put(url, payload);"],
    ["await client.patch(`${base}/x`, {});"],
    ["return apiClient.delete(url);"],
  ])("flags %s", (line) => {
    expect(findStateChangingVerbs(line)).toHaveLength(1);
  });

  it.each([
    ['fetch(url, { method: "GET" });'],
    ["const seen = new Map(); seen.delete(key);"],
    ["visited.delete(sysId);"],
    ['const params = { sysparm_query: "active=true" };'],
    ["// the caller may not post anything here"],
    ['const status = "posted";'],
  ])("does not flag %s", (line) => {
    expect(findStateChangingVerbs(line)).toEqual([]);
  });

  it("reports where the write is, not merely that there is one", () => {
    const findings = findStateChangingVerbs('const a = 1;\nfetch(u, { method: "POST" });', "x.js");
    expect(findings).toEqual([{ file: "x.js", line: 2, text: 'fetch(u, { method: "POST" });' }]);
  });
});

describe("INV-2: the built package performs GET requests only", () => {
  let outDir: string;
  let emitted: string[];

  beforeAll(() => {
    outDir = mkdtempSync(join(tmpdir(), "syncrona-mirror-inv2-"));
    // A real compile of the current sources, not a reuse of whatever `dist/`
    // happens to hold. Declarations are off (they carry no request code) and
    // comments are stripped so no docblock can satisfy or trip the scan.
    execFileSync(
      process.execPath,
      [
        require.resolve("typescript/bin/tsc"),
        "-p",
        TSCONFIG,
        "--outDir",
        outDir,
        "--removeComments",
        "--declaration",
        "false",
      ],
      { cwd: PACKAGE_ROOT, stdio: "pipe" }
    );
    emitted = walk(outDir);
  }, 180_000);

  afterAll(() => {
    rmSync(outDir, { recursive: true, force: true });
  });

  it("emitted exactly the modules the source tree contains", () => {
    // The anti-vacuity assertion. If the build silently produced nothing, or the
    // walk looked in the wrong place, or a module were quietly excluded from
    // compilation, the grep below would pass by scanning an empty set. This is
    // what stops that.
    const sources = walk(SRC_ROOT).map((file) =>
      posix(relative(SRC_ROOT, file)).replace(/\.ts$/, ".js")
    );
    const built = emitted.map((file) => posix(relative(outDir, file)));

    expect(built).toEqual(sources);
    expect(built).toEqual(
      expect.arrayContaining([
        "index.js",
        "constants.js",
        "contracts.js",
        "config/loadConfig.js",
        "http/client.js",
        "serialize/serializer.js",
      ])
    );
  });

  it("scanned real compiled code, not empty files", () => {
    const bytes = emitted.map((file) => statSync(file).size);
    expect(bytes.every((size) => size > 0)).toBe(true);
    // The client is the only module that speaks HTTP; if it ever compiled down
    // to a stub, the invariant check would be scanning nothing that matters.
    const clientSource = readFileSync(join(outDir, "http", "client.js"), "utf8");
    expect(clientSource.length).toBeGreaterThan(5_000);
    // Positive control: the scan looks at code that really does issue requests,
    // and those requests really are reads.
    expect(clientSource).toContain('method: "GET"');
    expect(clientSource).toContain("fetch");
  });

  it("contains no state-changing HTTP verb anywhere in the built output", () => {
    const findings = emitted.flatMap((file) =>
      findStateChangingVerbs(readFileSync(file, "utf8"), posix(relative(outDir, file)))
    );

    // Reported as a list rather than a count so a failure says which module and
    // which line broke the invariant.
    expect(
      findings.map((finding) => `${finding.file}:${finding.line}: ${finding.text}`)
    ).toEqual([]);
  });

  it("would catch a write added to any of these modules", () => {
    // The detector is proven above on synthetic lines; this proves it against
    // the real emitted files, by injecting a write into each one and confirming
    // the scan turns red. Without it, a scanner that happened not to work on
    // this package's actual output would still look healthy.
    for (const file of emitted) {
      const tampered = `${readFileSync(file, "utf8")}\nawait this.fetchImpl(url, { method: "DELETE" });\n`;
      expect(findStateChangingVerbs(tampered, file).length).toBeGreaterThan(0);
    }
  });
});
