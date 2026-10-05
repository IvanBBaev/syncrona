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
  ({ cicdCommand, buildCicdRequest, extractCicdErrorMessage } = await import("../cicdCommand.js"));
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

  it("falls back to the tracker verdict when the result fetch fails", async () => {
    const h = harness({
      progress: [() => progress("2", { links: { results: { id: "r", url: "https://x/r" } } })],
      results: () => httpError(500, "api/sn_cicd/testsuite/results/r", { error: { message: "boom" } }),
    });
    expect(await run(h, "run-suite", { suiteId: "s1" })).toBe(0);
    expect(infos).toContain("Details: https://x/r");
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
