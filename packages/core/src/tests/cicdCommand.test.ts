// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
export {};

// WP-5 (R6): `syncrona cicd <action>`. The instance is a scripted fake of the
// two sn_cicd calls the command makes (dispatch POST, progress/result GETs), and
// the clock is jest's fake one — the command's real `sleep`/`now` run against
// it, so the poll loop and its timeout are exercised without waiting. What the
// suite pins down:
//
// - the exact path and query each action dispatches (the now-sdk contract);
// - the exit-code contract shared with `mirror`: 0 success, 1 could not finish
//   (usage, HTTP, timeout, no progress id), 2 the instance reported failure;
// - both error envelopes sn_cicd answers with, and the 403 missing-role hint.

let cicdCommand: typeof import("../cicdCommand.js").cicdCommand;
let buildCicdRequest: typeof import("../cicdCommand.js").buildCicdRequest;
let extractCicdErrorMessage: typeof import("../cicdCommand.js").extractCicdErrorMessage;
let atfSuiteVerdict: typeof import("../cicdCommand.js").atfSuiteVerdict;
let logger: typeof import("../Logger.js").logger;

type Deps = NonNullable<Parameters<typeof cicdCommand>[1]>;

interface Call {
  method: "POST" | "GET";
  path: string;
  params?: Record<string, string>;
}

/** An axios-shaped HTTP error, as the real client rejects with. */
const httpError = (status: number, url: string, data: unknown): Error =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data },
    config: { url },
  });

const ok = (result: unknown) => ({ data: { result } }) as never;

const dispatched = (progressId = "prog-1") =>
  ok({
    links: { progress: { id: progressId, url: `https://x/api/sn_cicd/progress/${progressId}` } },
    status: "0",
    status_label: "Pending",
  });

const progress = (status: string, extra: Record<string, unknown> = {}) =>
  ok({ status, percent_complete: status === "2" ? 100 : 50, ...extra });

interface Script {
  post?: () => unknown;
  /** Successive answers to `progress/{id}`; the last one repeats. */
  progress?: Array<() => unknown>;
  /** The answer to the ATF result GET. */
  results?: () => unknown;
}

function harness(script: Script = {}) {
  const calls: Call[] = [];
  const written: string[] = [];
  const progressQueue = [...(script.progress ?? [() => progress("2")])];
  const answer = async (fn: (() => unknown) | undefined, fallback: unknown) => {
    const value = fn ? fn() : fallback;
    if (value instanceof Error) throw value;
    return value as never;
  };
  const client = {
    cicdPost: jest.fn(async (path: string, params?: Record<string, string>) => {
      calls.push({ method: "POST", path, params });
      return answer(script.post, dispatched());
    }),
    cicdGet: jest.fn(async (path: string) => {
      calls.push({ method: "GET", path });
      if (path.startsWith("progress/")) {
        const next = progressQueue.length > 1 ? progressQueue.shift() : progressQueue[0];
        return answer(next, progress("2"));
      }
      return answer(script.results, ok({}));
    }),
  };
  const deps: Partial<Deps> = {
    createClient: jest.fn(() => client),
    write: (line: string) => {
      written.push(line);
    },
  };
  return { calls, written, deps, client };
}

type Harness = ReturnType<typeof harness>;

/** Runs the command to completion, advancing the fake clock as it polls. */
const run = async (
  h: Harness,
  action: string,
  flags: Record<string, unknown> = {},
  advanceMs = 10_000
): Promise<number> => {
  const done = cicdCommand(
    { _: ["cicd"], $0: "syncrona", logLevel: "error", action, ...flags } as never,
    h.deps
  );
  await jest.advanceTimersByTimeAsync(advanceMs);
  await done;
  return typeof process.exitCode === "number" ? process.exitCode : 0;
};

beforeAll(async () => {
  ({ cicdCommand, buildCicdRequest, extractCicdErrorMessage, atfSuiteVerdict } = await import("../cicdCommand.js"));
  ({ logger } = await import("../Logger.js"));
});

let infos: string[];
let warnings: string[];
let errors: string[];

beforeEach(() => {
  jest.useFakeTimers();
  process.exitCode = undefined;
  infos = [];
  warnings = [];
  errors = [];
  jest.spyOn(logger, "info").mockImplementation((message: unknown) => {
    infos.push(String(message));
  });
  jest.spyOn(logger, "success").mockImplementation(() => {});
  jest.spyOn(logger, "debug").mockImplementation(() => {});
  jest.spyOn(logger, "warn").mockImplementation((message: unknown) => {
    warnings.push(String(message));
  });
  jest.spyOn(logger, "error").mockImplementation((message: unknown) => {
    errors.push(String(message));
  });
});

afterEach(() => {
  jest.useRealTimers();
  jest.restoreAllMocks();
  process.exitCode = undefined;
});

describe("buildCicdRequest (dispatch contract)", () => {
  it.each([
    [
      "run-suite",
      { suiteId: "s1", browserName: "chrome", osName: "Windows", runInCloud: true, performance: false },
      "testsuite/run",
      { test_suite_sys_id: "s1", browser_name: "chrome", os_name: "Windows", run_in_cloud: "true", is_performance_run: "false" },
    ],
    ["run-suite", { suiteName: " Smoke " }, "testsuite/run", { test_suite_name: "Smoke" }],
    [
      "run-test",
      { testId: "t1", captureNodeLogs: true },
      "tests/run_test",
      { test_sys_id: "t1", capture_node_logs: "true" },
    ],
    [
      "install",
      { scope: "x_app", appVersion: "1.2.0", baseAppVersion: "1.0.0", autoUpgradeBaseApp: false },
      "app_repo/install",
      { scope: "x_app", version: "1.2.0", base_app_version: "1.0.0", auto_upgrade_base_app: "false" },
    ],
    [
      "publish",
      { appSysId: "abc", appVersion: "1.3.0", devNotes: "notes" },
      "app_repo/publish",
      { sys_id: "abc", version: "1.3.0", dev_notes: "notes" },
    ],
    ["rollback", { scope: "x_app", appVersion: "1.1.0" }, "app_repo/rollback", { scope: "x_app", version: "1.1.0" }],
  ])("%s %j -> %s", (action, args, path, params) => {
    expect(buildCicdRequest(action as never, args as never)).toEqual({ path, params });
  });

  it.each([
    ["run-suite", {}, /--suite-id or --suite-name \(got neither\)/],
    ["run-suite", { suiteId: "a", suiteName: "b" }, /got both/],
    ["run-test", { testId: "  " }, /needs --test-id/],
    ["install", {}, /--scope or --app-sys-id \(got neither\)/],
    ["publish", { scope: "x", appSysId: "y" }, /got both/],
    ["rollback", { scope: "x_app" }, /needs --app-version/],
  ])("rejects %s %j", (action, args, message) => {
    expect(() => buildCicdRequest(action as never, args as never)).toThrow(message);
  });
});

describe("extractCicdErrorMessage", () => {
  it("reads the Table API envelope, with detail when it adds something", () => {
    expect(extractCicdErrorMessage({ error: { message: "No such app", detail: "scope x" } })).toBe(
      "No such app: scope x"
    );
    expect(extractCicdErrorMessage({ error: { message: "Same", detail: "Same" } })).toBe("Same");
  });

  it("reads the sn_cicd envelope, falling back to status_message", () => {
    expect(
      extractCicdErrorMessage({ result: { status: "3", status_label: "Failed", error: "Suite not found" } })
    ).toBe("Suite not found");
    expect(extractCicdErrorMessage({ result: { error: "", status_message: "Rolled back" } })).toBe("Rolled back");
  });

  it("returns undefined for bodies without a message", () => {
    expect(extractCicdErrorMessage(undefined)).toBeUndefined();
    expect(extractCicdErrorMessage("<html>")).toBeUndefined();
    expect(extractCicdErrorMessage({ error: { message: " " }, result: [] })).toBeUndefined();
  });
});

describe("cicd run-suite", () => {
  it("dispatches, polls to SUCCESSFUL, reads the suite result and exits 0", async () => {
    const h = harness({
      progress: [
        () => progress("1"),
        () => progress("1"),
        () => progress("2", { links: { results: { id: "res-1", url: "https://x/res-1" } } }),
      ],
      results: () =>
        ok({
          test_suite_status: "success",
          rolledup_test_success_count: 4,
          rolledup_test_failure_count: 0,
          rolledup_test_error_count: 0,
          rolledup_test_skip_count: 1,
        }),
    });

    const code = await run(h, "run-suite", { suiteName: "Smoke" });

    expect(code).toBe(0);
    expect(h.calls).toEqual([
      { method: "POST", path: "testsuite/run", params: { test_suite_name: "Smoke" } },
      { method: "GET", path: "progress/prog-1" },
      { method: "GET", path: "progress/prog-1" },
      { method: "GET", path: "progress/prog-1" },
      { method: "GET", path: "testsuite/results/res-1" },
    ]);
    expect(infos).toEqual(
      expect.arrayContaining([
        "Progress prog-1: Running (50%)",
        "Progress prog-1: Successful (100%)",
        "Suite success: 4 passed, 0 failed, 0 errored, 1 skipped",
        "Details: https://x/res-1",
      ])
    );
    // A repeated status is not re-logged.
    expect(infos.filter((line) => line.includes("Running"))).toHaveLength(1);
    expect(errors).toEqual([]);
  });

  it("exits 2 when the tracker succeeds but the suite has failing tests", async () => {
    const h = harness({
      progress: [() => progress("2", { links: { results: { id: "res-1" } } })],
      results: () =>
        ok({ rolledup_test_success_count: 3, rolledup_test_failure_count: 1, rolledup_test_error_count: 0 }),
    });

    expect(await run(h, "run-suite", { suiteId: "s1" })).toBe(2);
    expect(warnings).toEqual(["3 passed, 1 failed, 0 errored, 0 skipped"]);
    expect(errors).toEqual(["cicd run-suite finished with failures: ATF reported failing tests"]);
  });

  it("exits 2 when the suite status alone says failure", async () => {
    const h = harness({
      progress: [() => progress("2", { links: { results: { id: "r" } } })],
      results: () => ok({ test_suite_status: "failure" }),
    });
    expect(await run(h, "run-suite", { suiteId: "s1" })).toBe(2);
  });

  // Batch 4 item 5: a successful tracker without a readable result is not a pass.
  it("exits 1 with the progress id when the result fetch fails", async () => {
    const h = harness({
      progress: [() => progress("2", { links: { results: { id: "r", url: "https://x/r" } } })],
      results: () => httpError(500, "api/sn_cicd/testsuite/results/r", { error: { message: "boom" } }),
    });
    expect(await run(h, "run-suite", { suiteId: "s1", json: true })).toBe(1);
    expect(errors[0]).toMatch(/progress prog-1 finished, but ATF result r could not be read: boom/);
    expect(errors[0]).toMatch(/--progress-id prog-1/);
    expect(JSON.parse(h.written.join("\n"))).toMatchObject({ exitCode: 1, progressId: "prog-1" });
  });

  it("exits 1 when a successful ATF tracker links no result record", async () => {
    const h = harness({ progress: [() => progress("2")] });
    expect(await run(h, "run-test", { testId: "t1" })).toBe(1);
    expect(errors[0]).toMatch(/links no ATF result record/);
  });

  it("keeps exit 2 for a failed ATF tracker whose result cannot be read", async () => {
    const h = harness({
      progress: [() => progress("3", { links: { results: { id: "r" } } })],
      results: () => httpError(500, "api/sn_cicd/testsuite/results/r", {}),
    });
    expect(await run(h, "run-suite", { suiteId: "s1" })).toBe(2);
  });

  it("rejects a --timeout that is not a positive number before any request", async () => {
    const h = harness();
    expect(await run(h, "install", { scope: "x_app", timeout: "soon" })).toBe(1);
    expect(errors[0]).toMatch(/--timeout must be a positive number of seconds/);
    expect(h.deps.createClient).not.toHaveBeenCalled();
  });

  it("emits the machine result with --json", async () => {
    const h = harness({
      progress: [() => progress("2", { links: { results: { id: "r" } } })],
      results: () => ok({ rolledup_test_failure_count: 2, links: { results: { url: "https://x/r" } } }),
    });

    const code = await run(h, "run-suite", { suiteId: "s1", json: true });

    expect(code).toBe(2);
    const parsed = JSON.parse(h.written.join("\n")) as Record<string, unknown>;
    expect(parsed).toMatchObject({
      command: "cicd",
      action: "run-suite",
      exitCode: 2,
      progressId: "prog-1",
      results: { rolledup_test_failure_count: 2 },
      resultsUrl: "https://x/r",
    });
    expect(errors).toEqual([]);
  });
});

describe("cicd run-test", () => {
  it("reads the test result and exits 2 on a failed test", async () => {
    const h = harness({
      progress: [() => progress("2", { links: { results: { id: "tr" } } })],
      results: () => ok({ test_status: "failure", output: "Step 3 failed" }),
    });

    expect(await run(h, "run-test", { testId: "t1" })).toBe(2);
    expect(h.calls.at(-1)).toEqual({ method: "GET", path: "tests/test/results/tr" });
    expect(warnings).toEqual(["Test failure: Step 3 failed"]);
  });

  it("exits 0 on a passed test", async () => {
    const h = harness({
      progress: [() => progress("2", { links: { results: { id: "tr" } } })],
      results: () => ok({ test_status: "success" }),
    });
    expect(await run(h, "run-test", { testId: "t1" })).toBe(0);
    expect(infos).toContain("Test success");
  });
});

describe("cicd app-repo actions", () => {
  it.each(["install", "publish"])("%s exits 0 on SUCCESSFUL without fetching ATF results", async (action) => {
    const h = harness({ progress: [() => progress("2", { links: { results: { id: "ignored" } } })] });
    expect(await run(h, action, { scope: "x_app", appVersion: "1.0.0" })).toBe(0);
    expect(h.calls.filter((c) => c.method === "GET").map((c) => c.path)).toEqual(["progress/prog-1"]);
  });

  it("exits 2 when the tracker ends in ERROR, with the instance's reason", async () => {
    const h = harness({
      progress: [() => progress("3", { status_label: "Failed", error: "Version 1.1.0 is not installed" })],
    });
    expect(await run(h, "rollback", { scope: "x_app", appVersion: "1.1.0" })).toBe(2);
    expect(errors).toEqual(["cicd rollback finished with failures: Version 1.1.0 is not installed"]);
  });

  it("exits 2 when the tracker is CANCELED", async () => {
    const h = harness({ progress: [() => progress("4")] });
    expect(await run(h, "install", { scope: "x_app" })).toBe(2);
    expect(errors).toEqual(["cicd install finished with failures: Canceled"]);
  });
});

describe("cicd could-not-finish paths (exit 1)", () => {
  it("times out after --timeout seconds of non-terminal progress", async () => {
    const h = harness({ progress: [() => progress("1")] });

    const code = await run(h, "install", { scope: "x_app", timeout: 5, pollMs: 1000 }, 10_000);

    expect(code).toBe(1);
    expect(errors[0]).toMatch(/Timed out after 5s waiting for progress prog-1 \(last status: Running\)/);
    expect(errors[0]).toContain("resume waiting with --progress-id prog-1 (and a longer --timeout)");
    const polls = h.calls.filter((c) => c.path.startsWith("progress/")).length;
    expect(polls).toBe(6);
  });

  it("a 403 from sn_cicd exits 1 with the missing-role hint", async () => {
    const h = harness({
      post: () =>
        httpError(403, "api/sn_cicd/testsuite/run", {
          error: { message: "User Not Authorized", detail: "Missing role" },
        }),
    });

    expect(await run(h, "run-suite", { suiteId: "s1" })).toBe(1);
    expect(errors).toEqual([
      "cicd run-suite failed: Request failed with status code 403 — User Not Authorized: Missing role",
    ]);
    expect(infos.some((line) => line.includes("sn_cicd.sys_ci_automation"))).toBe(true);
  });

  it("an HTTP error carrying the sn_cicd envelope surfaces its message", async () => {
    const h = harness({
      post: () =>
        httpError(400, "api/sn_cicd/app_repo/install", {
          result: { status: "3", status_label: "Failed", error: "Invalid scope" },
        }),
    });
    expect(await run(h, "install", { scope: "x_bad" })).toBe(1);
    expect(errors[0]).toContain("Invalid scope");
  });

  it("a 200 dispatch rejected in the sn_cicd envelope exits 1", async () => {
    const h = harness({ post: () => ok({ status: "3", status_label: "Failed", error: "Suite not found" }) });
    expect(await run(h, "run-suite", { suiteId: "nope" })).toBe(1);
    expect(errors[0]).toContain("The instance rejected cicd run-suite: Suite not found");
  });

  it("a dispatch without a progress id or reason exits 1", async () => {
    const h = harness({ post: () => ok({ status: "0" }) });
    expect(await run(h, "publish", { scope: "x_app" })).toBe(1);
    expect(errors[0]).toContain("returned no progress id");
  });

  it("a non-JSON answer exits 1", async () => {
    const h = harness({ post: () => ({ data: "<html>login</html>" }) });
    expect(await run(h, "publish", { scope: "x_app" })).toBe(1);
    expect(errors[0]).toContain("without a JSON `result`");
  });

  it("a usage error exits 1 before any request", async () => {
    const h = harness();
    expect(await run(h, "rollback", { scope: "x_app" })).toBe(1);
    expect(h.calls).toEqual([]);
  });

  it("an unknown action exits 1", async () => {
    const h = harness();
    expect(await run(h, "deploy-everything")).toBe(1);
    expect(errors[0]).toMatch(/Unknown cicd subcommand "deploy-everything"/);
    expect(h.deps.createClient).not.toHaveBeenCalled();
  });
});

describe("cicd --json on the could-not-finish paths", () => {
  it("a timeout after dispatch writes a failure document with the progress id", async () => {
    const h = harness({ progress: [() => progress("1")] });

    const code = await run(h, "install", { scope: "x_app", timeout: 5, pollMs: 1000, json: true }, 10_000);

    expect(code).toBe(1);
    const parsed = JSON.parse(h.written.join("\n")) as Record<string, unknown>;
    expect(parsed).toEqual({
      command: "cicd",
      action: "install",
      exitCode: 1,
      progressId: "prog-1",
      error: expect.stringMatching(/^cicd install failed: Timed out after 5s/),
    });
  });

  it("a failed dispatch writes a failure document without a progress id", async () => {
    const h = harness({
      post: () => httpError(403, "api/sn_cicd/testsuite/run", { error: { message: "User Not Authorized" } }),
    });

    expect(await run(h, "run-suite", { suiteId: "s1", json: true })).toBe(1);
    const parsed = JSON.parse(h.written.join("\n")) as Record<string, unknown>;
    expect(parsed).toEqual({
      command: "cicd",
      action: "run-suite",
      exitCode: 1,
      error: "cicd run-suite failed: Request failed with status code 403 — User Not Authorized",
    });
  });

  it("an unknown action writes a failure document", async () => {
    const h = harness();
    expect(await run(h, "deploy-everything", { json: true })).toBe(1);
    expect(JSON.parse(h.written.join("\n"))).toMatchObject({
      action: "deploy-everything",
      exitCode: 1,
      error: expect.stringContaining('Unknown cicd subcommand "deploy-everything"'),
    });
  });

  it("writes nothing to stdout without --json", async () => {
    const h = harness({ post: () => ok({ status: "0" }) });
    expect(await run(h, "publish", { scope: "x_app" })).toBe(1);
    expect(h.written).toEqual([]);
  });
});

describe("cicd --poll-ms floor", () => {
  it("clamps a tiny --poll-ms to 250ms between polls", async () => {
    const h = harness({ progress: [() => progress("1")] });

    expect(await run(h, "install", { scope: "x_app", timeout: 1, pollMs: 1 }, 5_000)).toBe(1);

    const polls = h.calls.filter((c) => c.path.startsWith("progress/")).length;
    expect(polls).toBeLessThanOrEqual(6);
  });
});

describe("cicd --progress-id (resume, SDK-F7)", () => {
  const RESUME_ID = "d".repeat(32);

  it("polls the given tracker without dispatching and exits 0 on SUCCESSFUL", async () => {
    const h = harness({ progress: [() => progress("1"), () => progress("2")] });

    // The original dispatch flags ride along and are ignored, not validated.
    const code = await run(h, "install", { progressId: ` ${RESUME_ID} `, scope: "x_app", appSysId: "both" });

    expect(code).toBe(0);
    expect(h.client.cicdPost).not.toHaveBeenCalled();
    expect(h.calls).toEqual([
      { method: "GET", path: `progress/${RESUME_ID}` },
      { method: "GET", path: `progress/${RESUME_ID}` },
    ]);
    expect(infos.some((line) => line.includes(`Resuming cicd install from progress ${RESUME_ID}`))).toBe(true);
  });

  it("reads the ATF result of a resumed run-suite and exits 2 on failing tests", async () => {
    const h = harness({
      progress: [() => progress("2", { links: { results: { id: "r" } } })],
      results: () => ok({ rolledup_test_failure_count: 1 }),
    });

    const code = await run(h, "run-suite", { progressId: RESUME_ID, json: true });

    expect(code).toBe(2);
    expect(h.calls.map((c) => c.path)).toEqual([`progress/${RESUME_ID}`, "testsuite/results/r"]);
    expect(JSON.parse(h.written.join("\n"))).toMatchObject({
      action: "run-suite",
      exitCode: 2,
      resumed: true,
      progressId: RESUME_ID,
    });
  });

  // Batch 4 item 6: the resume action is the caller's word; a tracker that
  // links an ATF result is a test run, so it is not reported as an install.
  it("exits 1 when a tracker resumed as install links an ATF result", async () => {
    const h = harness({ progress: [() => progress("2", { links: { results: { id: "r" } } })] });
    expect(await run(h, "install", { progressId: RESUME_ID })).toBe(1);
    expect(errors[0]).toMatch(/looks like a test run rather than install/);
    expect(h.calls.map((c) => c.path)).toEqual([`progress/${RESUME_ID}`]);
  });

  it("times out like a dispatched run, exiting 1", async () => {
    const h = harness({ progress: [() => progress("1")] });
    expect(await run(h, "publish", { progressId: RESUME_ID, timeout: 2, pollMs: 1000 }, 5_000)).toBe(1);
    expect(errors[0]).toMatch(new RegExp(`waiting for progress ${RESUME_ID}`));
  });

  it("rejects a malformed id before creating a client", async () => {
    const h = harness();
    expect(await run(h, "install", { progressId: "../table/sys_user" })).toBe(1);
    expect(errors[0]).toMatch(/--progress-id must be the 32-character hexadecimal sys_id/);
    expect(h.deps.createClient).not.toHaveBeenCalled();
  });
});

describe("cicd poll retry", () => {
  const networkError = () => Object.assign(new Error("socket hang up"), { code: "ECONNRESET" });

  it("rides out transient poll failures and finishes", async () => {
    const h = harness({
      progress: [
        () => networkError(),
        () => httpError(502, "api/sn_cicd/progress/prog-1", "Bad Gateway"),
        () => progress("1"),
        () => httpError(429, "api/sn_cicd/progress/prog-1", {}),
        () => progress("2"),
      ],
    });

    expect(await run(h, "install", { scope: "x_app", pollMs: 1000 })).toBe(0);
    expect(warnings.filter((w) => /poll failed \(\d\/3\), retrying/.test(w))).toHaveLength(3);
  });

  it.each([
    ["a 500", () => httpError(500, "api/sn_cicd/progress/prog-1", "")],
    ["a 502", () => httpError(502, "api/sn_cicd/progress/prog-1", "Bad Gateway")],
    ["a 503", () => httpError(503, "api/sn_cicd/progress/prog-1", "")],
    ["a 429", () => httpError(429, "api/sn_cicd/progress/prog-1", {})],
    ["a 408", () => httpError(408, "api/sn_cicd/progress/prog-1", {})],
    ["a connection reset", () => networkError()],
  ])("retries %s one --poll-ms apart and finishes when the poll recovers", async (_label, failure) => {
    const h = harness({ progress: [failure, failure, () => progress("2")] });
    const sleeps: number[] = [];
    const sleep = jest.fn(async (ms: number) => {
      sleeps.push(ms);
    });

    expect(await run({ ...h, deps: { ...h.deps, sleep } }, "install", { scope: "x_app", pollMs: 1000 })).toBe(0);
    expect(h.calls.filter((c) => c.path.startsWith("progress/"))).toHaveLength(3);
    expect(sleeps).toEqual([1000, 1000]);
    expect(errors).toEqual([]);
  });

  it("gives up after three consecutive transient failures, naming the request", async () => {
    const h = harness({ progress: [() => httpError(503, "api/sn_cicd/progress/prog-1", "")] });

    expect(await run(h, "install", { scope: "x_app", pollMs: 1000 })).toBe(1);
    expect(h.calls.filter((c) => c.path.startsWith("progress/"))).toHaveLength(3);
    expect(errors).toEqual([
      "cicd install failed: GET api/sn_cicd/progress/prog-1 failed 3 times in a row (last: HTTP 503). Request failed with status code 503",
    ]);
    // The resume id is a warning, so a --log-level warn run still sees it.
    expect(warnings).toContain("The work was dispatched as progress prog-1; resume with --progress-id prog-1.");
  });

  it("counts a network failure without a response as no response", async () => {
    const h = harness({ progress: [() => networkError()] });

    expect(await run(h, "install", { scope: "x_app", pollMs: 1000 })).toBe(1);
    expect(errors[0]).toContain("failed 3 times in a row (last: no response). socket hang up");
  });

  it.each([
    [400, "the instance rejected the request as malformed"],
    [401, "the instance rejected the credentials"],
    [403, "the user may not read CI/CD progress"],
    [404, "the instance has no such progress tracker (check the id and the instance profile)"],
    [409, undefined],
  ])("fails fast on HTTP %i: one poll, no retry, the status and the request named", async (status, hint) => {
    const h = harness({ progress: [() => httpError(status, "api/sn_cicd/progress/prog-1", {})] });

    expect(await run(h, "install", { scope: "x_app", pollMs: 1000 }, 0)).toBe(1);
    expect(h.calls.filter((c) => c.path.startsWith("progress/"))).toHaveLength(1);
    expect(warnings.some((w) => /retrying/.test(w))).toBe(false);
    expect(errors).toEqual([
      `cicd install failed: GET api/sn_cicd/progress/prog-1 answered HTTP ${status}${hint ? ` (${hint})` : ""}; a client error is not retried. Request failed with status code ${status}`,
    ]);
  });

  it.each([301, 302, 307])(
    "reports HTTP %i as an unexpected redirect, not as a client error, and does not retry it",
    async (status) => {
      const redirect = Object.assign(httpError(status, "api/sn_cicd/progress/prog-1", ""), {
        response: { status, data: "", headers: { location: "https://login.example/sso" } },
      });
      const h = harness({ progress: [() => redirect] });

      expect(await run(h, "install", { scope: "x_app", pollMs: 1000 }, 0)).toBe(1);
      expect(h.calls.filter((c) => c.path.startsWith("progress/"))).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain(
        `GET api/sn_cicd/progress/prog-1 answered HTTP ${status}, an unexpected redirect to https://login.example/sso`
      );
      expect(errors[0]).not.toMatch(/client error/);
    }
  );

  it("reports a redirect without a Location header as an unexpected redirect too", async () => {
    const h = harness({ progress: [() => httpError(302, "api/sn_cicd/progress/prog-1", "")] });

    expect(await run(h, "install", { scope: "x_app", pollMs: 1000 }, 0)).toBe(1);
    expect(errors[0]).toContain("answered HTTP 302, an unexpected redirect (");
  });

  it("keeps the instance's error envelope and the sn_cicd role hint on a permanent poll failure", async () => {
    const h = harness({
      progress: [
        () =>
          httpError(403, "api/sn_cicd/progress/prog-1", {
            error: { message: "User Not Authorized", detail: "Missing role" },
          }),
      ],
    });

    expect(await run(h, "install", { scope: "x_app", pollMs: 1000, json: true })).toBe(1);
    expect(errors[0]).toMatch(/answered HTTP 403 .* — User Not Authorized: Missing role$/);
    expect(infos.some((line) => line.includes("sn_cicd.sys_ci_automation"))).toBe(true);
    const doc = JSON.parse(h.written[0]) as Record<string, unknown>;
    expect(doc).toMatchObject({ exitCode: 1, progressId: "prog-1" });
    expect(String(doc.error)).toContain("GET api/sn_cicd/progress/prog-1 answered HTTP 403");
  });

  it("ends a poll that keeps failing transiently with the timeout error, not the transport error", async () => {
    const h = harness({ progress: [() => progress("1"), () => networkError()] });

    expect(await run(h, "install", { scope: "x_app", timeout: 1, pollMs: 1000 }, 10_000)).toBe(1);
    expect(h.calls.filter((c) => c.path.startsWith("progress/"))).toHaveLength(2);
    expect(errors).toEqual([
      "cicd install failed: Timed out after 1s waiting for progress prog-1 (last status: Running; last poll error: socket hang up). " +
        "The work may still be running on the instance; check it at https://x/api/sn_cicd/progress/prog-1 and resume waiting with --progress-id prog-1 (and a longer --timeout).",
    ]);
  });

  it("reports a timeout before any poll answered as never read", async () => {
    const h = harness({ progress: [() => httpError(502, "api/sn_cicd/progress/prog-1", "")] });

    expect(await run(h, "install", { scope: "x_app", timeout: 1, pollMs: 1000 }, 10_000)).toBe(1);
    expect(h.calls.filter((c) => c.path.startsWith("progress/"))).toHaveLength(2);
    expect(errors[0]).toContain("(last status: never read; last poll error: Request failed with status code 502)");
  });

  it("points a timed-out run at the tracker URL the instance reported", async () => {
    const h = harness({
      progress: [() => progress("1", { links: { progress: { id: "prog-1", url: "https://inst/progress/prog-1" } } })],
    });

    expect(await run(h, "install", { scope: "x_app", timeout: 2, pollMs: 1000 }, 5_000)).toBe(1);
    expect(errors[0]).toContain("check it at https://inst/progress/prog-1 and resume waiting with --progress-id prog-1");
  });

  it("points a timed-out resume without any tracker URL at the progress API path", async () => {
    const id = "0123456789abcdef0123456789abcdef";
    const h = harness({ progress: [() => progress("1")] });

    expect(await run(h, "publish", { progressId: id, timeout: 2, pollMs: 1000 }, 5_000)).toBe(1);
    expect(errors[0]).toContain(`check it at GET api/sn_cicd/progress/${id} on the instance`);
    expect(process.exitCode).toBe(1);
  });
});

// Review finding 4: the ATF verdict is an allow-list, identical to the
// mcp-server's sync_cicd_run. Only a passing status with failure and error
// counts stated as 0 is a pass; a clear failure is exit 2; anything else over a
// successful tracker is exit 1 (the answer is unknown).
describe("cicd ATF verdict allow-list", () => {
  const suiteRun = async (result: Record<string, unknown>): Promise<number> => {
    const h = harness({
      progress: [() => progress("2", { links: { results: { id: "r" } } })],
      results: () => ok(result),
    });
    return run(h, "run-suite", { suiteId: "s1" });
  };
  const testRun = async (result: Record<string, unknown>): Promise<number> => {
    const h = harness({
      progress: [() => progress("2", { links: { results: { id: "tr" } } })],
      results: () => ok(result),
    });
    return run(h, "run-test", { testId: "t1" });
  };
  // Zero failures and errors over a suite that did run tests (a stated success count).
  const zero = { rolledup_test_success_count: 1, rolledup_test_failure_count: 0, rolledup_test_error_count: 0 };

  it.each([
    ["success", { test_suite_status: "success", ...zero }],
    ["SUCCESS with whitespace", { test_suite_status: "  SUCCESS ", ...zero }],
    ["success_with_warnings", { test_suite_status: "success_with_warnings", ...zero }],
    ["digit-string counts", { test_suite_status: "success", rolledup_test_success_count: "3", rolledup_test_failure_count: "0", rolledup_test_error_count: " 0 " }],
  ])("suite %s exits 0", async (_label, result) => {
    expect(await suiteRun(result)).toBe(0);
  });

  it.each([
    ["status failure with a trailing space", { test_suite_status: "failure ", ...zero }],
    ["status ERROR", { test_suite_status: "ERROR", ...zero }],
    ["a positive failure count under a passing status", { test_suite_status: "success", rolledup_test_failure_count: 1, rolledup_test_error_count: 0 }],
    ["a positive error count as a string", { test_suite_status: "success", rolledup_test_failure_count: 0, rolledup_test_error_count: "2" }],
    ["a positive count with no status", { rolledup_test_error_count: 1 }],
    ["a failing status with unreadable counts", { test_suite_status: "failure", rolledup_test_failure_count: "n/a" }],
  ])("suite with %s exits 2", async (_label, result) => {
    expect(await suiteRun(result)).toBe(2);
  });

  it.each([
    ["an empty result", {}],
    ["status canceled", { test_suite_status: "canceled", ...zero }],
    ["status running", { test_suite_status: "running", ...zero }],
    ["status skipped", { test_suite_status: "skipped", ...zero }],
    ['status "failed" (not a ServiceNow value)', { test_suite_status: "failed", ...zero }],
    ["zero counts and no status", { ...zero }],
    ["a passing status and no counts", { test_suite_status: "success" }],
    ["a passing status and a missing error count", { test_suite_status: "success", rolledup_test_failure_count: 0 }],
    ['a passing status and a count of "n/a"', { test_suite_status: "success", rolledup_test_failure_count: "n/a", rolledup_test_error_count: 0 }],
    ["a passing status and an empty-string count", { test_suite_status: "success", rolledup_test_failure_count: "", rolledup_test_error_count: 0 }],
    ["a passing status and a fractional count", { test_suite_status: "success", rolledup_test_failure_count: 0.5, rolledup_test_error_count: 0 }],
    ["a passing status and a negative count", { test_suite_status: "success", rolledup_test_failure_count: -1, rolledup_test_error_count: 0 }],
    ["a non-string status", { test_suite_status: 1, ...zero }],
    ["a passing status and no success count", { test_suite_status: "success", rolledup_test_failure_count: 0, rolledup_test_error_count: 0 }],
    ['a passing status and a success count of "n/a"', { test_suite_status: "success", ...zero, rolledup_test_success_count: "n/a" }],
    ["zero tests under a non-ServiceNow status", { test_suite_status: "canceled", ...zero, rolledup_test_success_count: 0 }],
  ])("suite with %s exits 1 (unknown, not a pass)", async (_label, result) => {
    expect(await suiteRun(result)).toBe(1);
    expect(errors[0]).toMatch(/does not clearly report a pass or a failure/);
    expect(errors[0]).toMatch(/--progress-id prog-1/);
  });

  it.each([
    ["success", "success"],
    ["success_with_warnings", "success_with_warnings"],
    ["every test skipped", "success"],
  ])("a passing suite that ran zero tests (%s) exits 2, not 0", async (label, status) => {
    const h = harness({
      progress: [() => progress("2", { links: { results: { id: "r" } } })],
      results: () =>
        ok({
          test_suite_status: status,
          rolledup_test_success_count: 0,
          rolledup_test_failure_count: 0,
          rolledup_test_error_count: 0,
          ...(label === "every test skipped" ? { rolledup_test_skip_count: 3 } : {}),
        }),
    });
    expect(await run(h, "run-suite", { suiteId: "s1" })).toBe(2);
    expect(warnings).toEqual([
      `Suite ${status}: 0 passed, 0 failed, 0 errored, ${label === "every test skipped" ? 3 : 0} skipped`,
    ]);
    expect(errors).toEqual(["cicd run-suite finished with failures: the suite ran no tests, which is not a pass"]);
  });

  it("verdict functions agree with the run on the zero-tests shape", () => {
    expect(atfSuiteVerdict({ test_suite_status: "success", ...zero, rolledup_test_success_count: 0 })).toBe("no_tests");
    expect(atfSuiteVerdict({ test_suite_status: "failure", ...zero, rolledup_test_success_count: 0 })).toBe("failed");
    expect(atfSuiteVerdict({ test_suite_status: "success", ...zero })).toBe("passed");
  });

  it.each([
    ["success", 0],
    [" Success ", 0],
    ["success_with_warnings", 0],
    ["failure", 2],
    ["failure ", 2],
    ["Error", 2],
    ["failed", 1],
    ["canceled", 1],
    ["running", 1],
    ["skipped", 1],
    ["", 1],
  ])('single test with status "%s" exits %i', async (status, expected) => {
    expect(await testRun({ test_status: status })).toBe(expected);
  });

  it("a single test with no status exits 1", async () => {
    expect(await testRun({})).toBe(1);
    expect(errors[0]).toMatch(/does not clearly report a pass or a failure/);
  });

  it("keeps exit 2 for a failed tracker whose readable result is unknown", async () => {
    const h = harness({
      progress: [() => progress("3", { links: { results: { id: "r" } } })],
      results: () => ok({}),
    });
    expect(await run(h, "run-suite", { suiteId: "s1" })).toBe(2);
  });

  it("emits a --json failure with the progress id for an unknown verdict", async () => {
    const h = harness({
      progress: [() => progress("2", { links: { results: { id: "r" } } })],
      results: () => ok({ test_suite_status: "canceled" }),
    });
    expect(await run(h, "run-suite", { suiteId: "s1", json: true })).toBe(1);
    expect(JSON.parse(h.written.join("\n"))).toMatchObject({ exitCode: 1, progressId: "prog-1" });
  });
});

// Review finding 5: the resumed action is bound to the tracker kind both ways.
describe("cicd --progress-id tracker-kind binding", () => {
  const RESUME_ID = "e".repeat(32);

  it.each(["install", "publish", "rollback"])(
    "refuses an ATF tracker resumed as %s, whatever its status",
    async (action) => {
      for (const status of ["2", "3", "4"]) {
        errors.length = 0;
        const h = harness({ progress: [() => progress(status, { links: { results: { id: "r" } } })] });
        expect(await run(h, action, { progressId: RESUME_ID })).toBe(1);
        expect(errors[0]).toMatch(new RegExp(`looks like a test run rather than ${action}`));
        expect(h.calls.map((c) => c.path)).toEqual([`progress/${RESUME_ID}`]);
      }
    }
  );

  it("treats a results link without an id as ATF evidence too", async () => {
    const h = harness({ progress: [() => progress("2", { links: { results: { url: "https://x/r" } } })] });
    expect(await run(h, "install", { progressId: RESUME_ID })).toBe(1);
    expect(errors[0]).toMatch(/looks like a test run rather than install/);
  });

  it.each(["run-suite", "run-test"])(
    "refuses a successful tracker without a result link resumed as %s",
    async (action) => {
      const h = harness({ progress: [() => progress("2")] });
      // Exit 1 (could not finish), never 0 (a pass) nor 2 (failing tests).
      expect(await run(h, action, { progressId: RESUME_ID })).toBe(1);
      expect(errors[0]).toMatch(
        new RegExp(`progress ${RESUME_ID} links no ATF result record, so it looks like an app-repo run rather than ${action} \\(it ended Successful\\)`)
      );
      expect(h.calls.map((c) => c.path)).toEqual([`progress/${RESUME_ID}`]);
    }
  );

  // Review round 7, finding 1: an ATF run cancelled or failed before it linked a
  // result exits 2 when dispatched, so resuming the same tracker must exit 2 too,
  // with a message that neither claims failing tests nor sends the caller to an
  // app-repo action as if that were certain.
  it.each([
    ["run-suite", "3", "Failed"],
    ["run-suite", "4", "Canceled"],
    ["run-test", "3", "Failed"],
    ["run-test", "4", "Canceled"],
  ])("gives a resumed %s over a tracker that ended %s without a result the fresh run's verdict", async (action, status, label) => {
    const flags = action === "run-suite" ? { suiteId: "s1" } : { testId: "t1" };
    const fresh = harness({ progress: [() => progress(status)] });
    const freshCode = await run(fresh, action, flags);
    const freshError = errors[0];
    errors.length = 0;

    const resumed = harness({ progress: [() => progress(status)] });
    const resumedCode = await run(resumed, action, { progressId: RESUME_ID });

    expect(freshCode).toBe(2);
    expect(resumedCode).toBe(freshCode);
    expect(resumed.calls.map((c) => c.path)).toEqual([`progress/${RESUME_ID}`]);
    const expected = `cicd ${action} finished with failures: the tracker ended ${label} before linking an ATF result record, so no test results were reported`;
    expect(freshError).toBe(expected);
    expect(errors[0]).toMatch(new RegExp(`^${expected.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
    expect(errors[0]).toMatch(/if progress e+ is an install, publish or rollback run rather than an ATF run/);
    expect(errors[0]).not.toMatch(/failing tests/);
  });

  it("quotes the instance's reason for a resumed ATF tracker that failed before linking a result", async () => {
    const h = harness({ progress: [() => progress("3", { status_message: "Suite not found" })] });
    expect(await run(h, "run-suite", { progressId: RESUME_ID, json: true })).toBe(2);
    expect(JSON.parse(h.written.join("\n"))).toMatchObject({ exitCode: 2, resumed: true, progressId: RESUME_ID });
  });

  it("keeps exit 2 for a dispatched ATF run whose tracker failed before linking a result", async () => {
    const h = harness({ progress: [() => progress("3")] });
    expect(await run(h, "run-suite", { suiteId: "s1" })).toBe(2);
  });

  // Review round 7, finding 2: a suite tracker resumed as run-test reads
  // tests/test/results/<suite result id>, which 404s. Re-reading it can never
  // succeed, so the message names the kind mismatch and the other action.
  it.each([
    ["run-test", "tests/test/results/r", "a suite run rather than a single test", "run-suite"],
    ["run-suite", "testsuite/results/r", "a single-test run rather than a suite", "run-test"],
  ])("names the kind mismatch when a result resumed as %s is not found (404)", async (action, path, kind, other) => {
    const h = harness({
      progress: [() => progress("2", { links: { results: { id: "r" } } })],
      results: () => httpError(404, `api/sn_cicd/${path}`, { error: { message: "No Record found" } }),
    });

    expect(await run(h, action, { progressId: RESUME_ID, json: true })).toBe(1);
    expect(h.calls.map((c) => c.path)).toEqual([`progress/${RESUME_ID}`, path]);
    expect(errors[0]).toContain(`progress ${RESUME_ID} finished, but ATF result r could not be read: No Record found`);
    expect(errors[0]).toContain(
      `progress ${RESUME_ID} may belong to ${kind} (${action} reads ${path.replace(/\/r$/, "/<id>")}); resume it with --progress-id ${RESUME_ID} and the ${other} action instead.`
    );
    expect(errors[0]).not.toMatch(/to read the result again/);
    expect(JSON.parse(h.written.join("\n"))).toMatchObject({ exitCode: 1, progressId: RESUME_ID });
  });

  it("keeps the re-read hint for a resumed result that fails with something other than 404", async () => {
    const h = harness({
      progress: [() => progress("2", { links: { results: { id: "r" } } })],
      results: () => httpError(500, "api/sn_cicd/tests/test/results/r", {}),
    });
    expect(await run(h, "run-test", { progressId: RESUME_ID })).toBe(1);
    expect(errors[0]).toMatch(new RegExp(`Re-run with --progress-id ${RESUME_ID} to read the result again`));
    expect(errors[0]).not.toMatch(/may belong to/);
  });

  it("keeps the re-read hint for a dispatched run whose result is not found", async () => {
    const h = harness({
      progress: [() => progress("2", { links: { results: { id: "r" } } })],
      results: () => httpError(404, "api/sn_cicd/tests/test/results/r", {}),
    });
    expect(await run(h, "run-test", { testId: "t1" })).toBe(1);
    expect(errors[0]).toMatch(/Re-run with --progress-id prog-1 to read the result again/);
  });

  it("warns that a resumed app-repo action is taken on the caller's word", async () => {
    const h = harness({ progress: [() => progress("2")] });
    expect(await run(h, "rollback", { progressId: RESUME_ID })).toBe(0);
    expect(warnings).toEqual([
      `progress ${RESUME_ID} does not record which app-repo action started it; reporting it as rollback on the caller's word.`,
    ]);
  });

  it("does not warn for a dispatched app-repo action", async () => {
    const h = harness({ progress: [() => progress("2")] });
    expect(await run(h, "install", { scope: "x_app" })).toBe(0);
    expect(warnings).toEqual([]);
  });
});
