// SPDX-License-Identifier: GPL-3.0-or-later
import { writeFileSync } from "node:fs";
import path from "node:path";
import type { SN } from "@syncrona/types";
import {
  applySetCookies,
  flowIds,
  InstallResponse,
  InstanceSession,
  nativeInstall,
  NativeInstallOptions,
  nativeInstallStatus,
} from "../src/install";
import { readNativeProject } from "../src/pack";
import { FakeInstance, INSTANCE, probeProject, removeProbeProjects, res, THROWS } from "./helpers/fakeInstance";

const SCOPE_ID = "db22ea00d7ff49d9b5d64061202ea510";
const FLOW_ID = "0123456789abcdef0123456789abcdef";
const ACTION_ID = "fedcba9876543210fedcba9876543210";

afterAll(removeProbeProjects);

function withFlows(dir: string): string {
  writeFileSync(path.join(dir, "dist", "app", "update", `sys_hub_flow_${FLOW_ID}.xml`), "<x/>");
  writeFileSync(path.join(dir, "dist", "app", "update", `sys_hub_action_type_definition_${ACTION_ID}.xml`), "<x/>");
  return dir;
}

const basicAuth: SN.FluentAuthResolver = async () => ({ type: "basic", token: "tok", cookie: "JSESSIONID=s1; glide_user=u" });

function logger() {
  return { info: jest.fn(), warn: jest.fn(), debug: jest.fn() };
}

async function install(
  dir: string,
  fake: FakeInstance,
  options: NativeInstallOptions = {},
  auth: SN.FluentAuthResolver = basicAuth,
) {
  const log = logger();
  const sleep = jest.fn(async () => undefined);
  const run = nativeInstall(dir, options, { instanceUrl: INSTANCE, auth, logger: log, fetch: fake.fetch, sleep });
  return { run, log, sleep };
}

describe("applySetCookies", () => {
  it("sets, replaces and deletes cookies and skips nameless headers", () => {
    const jar = new Map([["old", "1"], ["gone", "x"], ["past", "y"]]);
    applySetCookies(jar, [
      "a=1; Path=/; HttpOnly",
      "old=2",
      "gone=; Max-Age=0",
      "past=v; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
      "keep=v; Max-Age=60; Expires=Thu, 01 Jan 2099 00:00:00 GMT",
      "=nameless",
      "novalue",
    ]);
    expect([...jar]).toEqual([["old", "2"], ["a", "1"], ["keep", "v"]]);
  });
});

describe("InstanceSession", () => {
  it("sends the UI session, keeps response cookies under the session's own, and re-resolves after a 401", async () => {
    const fake = new FakeInstance().on(
      "GET",
      "base/api/now/table/t",
      res({}, { status: 401, setCookie: ["glide_user=stale", "BIGip=b"] }),
      res({ result: [{ a: 1 }, "scalar"] }, { legacyHeaders: true, headers: { "set-cookie": "late=1" } }),
      res({ result: "none" }, { legacyHeaders: true }),
    );
    let logins = 0;
    const auth: SN.FluentAuthResolver = async () => ({ type: "basic", token: logins++ ? "" : "tok", cookie: "JSESSIONID=s1; glide_user=u; bad" });
    const session = new InstanceSession(`${INSTANCE}/base`, auth, fake.fetch);
    expect(await session.table("t", { q: "1" })).toEqual([{ a: 1 }, {}]);
    expect(await session.table("t", {})).toEqual([]);
    const [first, retry, third] = fake.calls;
    expect(first.url.href).toBe(`${INSTANCE}/base/api/now/table/t?q=1`);
    expect(first.init.headers).toEqual({ Accept: "application/json", "X-UserToken": "tok", Cookie: "JSESSIONID=s1; glide_user=u" });
    expect(retry.init.headers).toEqual({ Accept: "application/json", Cookie: "glide_user=u; BIGip=b; JSESSIONID=s1" });
    expect(third.init.headers.Cookie).toBe("glide_user=u; BIGip=b; late=1; JSESSIONID=s1");
    expect(logins).toBe(2);
    expect(session.origin).toBe(INSTANCE);
  });

  it("uses the default fetch when none is injected", () => {
    expect(new InstanceSession(`${INSTANCE}/`, basicAuth).origin).toBe(INSTANCE);
  });

  it("reports Table API and tracker failures", async () => {
    const fake = new FakeInstance()
      .on("GET", "api/now/table/t", res({}, { status: 500, statusText: "Server Error" }))
      .on("GET", "api/sn_cicd/progress/p", res({}, { status: 404, statusText: "Not Found" }))
      .on("GET", "api/sn_cicd/progress/q", res(THROWS));
    const session = new InstanceSession(INSTANCE, basicAuth, fake.fetch);
    await expect(session.table("t", {})).rejects.toThrow("Table API request to t failed: 500 Server Error");
    await expect(session.progress("p")).rejects.toThrow("Failed to fetch progress status: Not Found");
    expect(await session.progress("q")).toEqual({ status: undefined, status_message: undefined, percent_complete: NaN });
  });

  describe("sysparmCk", () => {
    const oauth: SN.FluentAuthResolver = async () => ({ type: "oauth", token: "bearer" });

    it("is the session token of a Basic profile", async () => {
      const session = new InstanceSession(INSTANCE, basicAuth, new FakeInstance().fetch);
      expect(await session.sysparmCk()).toBe("tok");
    });

    it("looks up the CSRF token of the OAuth session by its session cookie", async () => {
      const fake = new FakeInstance()
        .on("GET", "api/now/ui/user/current_user", res({ result: { user_name: "admin" } }, { setCookie: ["glide_session_store=S1"] }))
        .on("GET", "api/now/table/sys_user_session", res({ result: [{ csrf_token: "ck", id: "S1" }] }));
      const session = new InstanceSession(INSTANCE, oauth, fake.fetch);
      expect(await session.sysparmCk()).toBe("ck");
      expect(await session.sysparmCk()).toBe("ck");
      const [user, lookup] = fake.calls;
      expect(user.init.headers).toEqual({ Accept: "application/json", Authorization: "Bearer bearer" });
      expect(lookup.init.headers.Cookie).toBe("glide_session_store=S1");
      expect(lookup.url.searchParams.get("sysparm_query")).toBe("id=S1");
      expect(fake.calls).toHaveLength(2);
    });

    it("falls back to the user's latest session, and to empty", async () => {
      const byUser = new FakeInstance()
        .on("GET", "api/now/ui/user/current_user", res({ result: { user_name: "admin" } }))
        .on("GET", "api/now/table/sys_user_session", res({ result: [] }));
      expect(await new InstanceSession(INSTANCE, oauth, byUser.fetch).sysparmCk()).toBe("");
      expect(byUser.calls[1].url.searchParams.get("sysparm_query")).toBe("name=admin^ORDERBYDESClast_accessed");

      const anonymous = new FakeInstance().on("GET", "api/now/ui/user/current_user", res(THROWS));
      expect(await new InstanceSession(INSTANCE, oauth, anonymous.fetch).sysparmCk()).toBe("");
      expect(anonymous.calls).toHaveLength(1);

      const noToken: SN.FluentAuthResolver = async () => ({ type: "basic", token: "", cookie: "" });
      const failing = new FakeInstance().on("GET", "api/now/ui/user/current_user", () => {
        throw new Error("offline");
      });
      expect(await new InstanceSession(INSTANCE, noToken, failing.fetch).sysparmCk()).toBe("");
    });
  });
});

describe("flowIds", () => {
  it("finds flows and actions by their build file names", () => {
    const dir = withFlows(probeProject());
    writeFileSync(path.join(dir, "dist", "app", "update", "sys_hub_flow_short.xml"), "<x/>");
    expect(flowIds(readNativeProject(dir))).toEqual({ flows: [FLOW_ID], actions: [ACTION_ID] });
  });
});

describe("nativeInstall", () => {
  it("packs, uploads and tracks a first install, then activates the build's flows", async () => {
    const dir = withFlows(probeProject());
    const pending = Array.from({ length: 15 }, () => res({ result: { status: "1", percent_complete: "40" } }));
    const fake = new FakeInstance().on(
      "GET",
      "api/sn_cicd/progress/t1",
      ...pending,
      res({ result: { status: "1", percent_complete: 50, status_message: "Loading" } }),
      res({ result: { status: "2", percent_complete: 100 } }),
    );
    const { run, log, sleep } = await install(dir, fake);
    await expect(run).resolves.toEqual({ trackerId: "t1", rollbackId: "r1" });

    const [upload] = fake.to("sn_appclient_upload_processor.do");
    expect(Object.fromEntries(upload.url.searchParams)).toEqual({
      sysparm_track_fluent_install: "true",
      sysparm_async_fluent_install: "true",
      sysparm_fluent_scope_id: SCOPE_ID,
      sysparm_fluent_scope_name: "x_snc_bprobe",
      sysparm_fluent_app_version: "0.0.1",
      sysparm_request_type: "custom_app",
    });
    expect(upload.init.redirect).toBe("manual");
    const form = upload.init.body as FormData;
    expect(form.get("upload_type")).toBe("file");
    expect(form.get("load_demo")).toBe("true");
    expect(form.get("sysparm_ck")).toBe("tok");
    expect((form.get("attachFile") as File).name).toBe("syncrona_build_probe_0_0_1.zip");

    expect(fake.to("api/now/table/sys_scope")[0].url.searchParams.get("sysparm_query")).toBe(
      `scope=x_snc_bprobe^sys_id=${SCOPE_ID}`,
    );
    expect(log.info).toHaveBeenCalledWith("App install pending: 40% complete, ");
    expect(log.info).toHaveBeenCalledWith(`Rollback (undo installation): ${INSTANCE}/sys_rollback_context.do?sys_id=r1`);
    expect(sleep).toHaveBeenCalledTimes(16);

    const [activate] = fake.to("api/now/wfa_fluent/activate_flows");
    expect(activate.url.searchParams.get("sysparm_transaction_scope")).toBe(SCOPE_ID);
    expect(JSON.parse(activate.init.body as string)).toEqual({
      flows: [{ sys_id: FLOW_ID, active: "", state: "" }],
      actions: [{ sys_id: ACTION_ID, active: "", state: "" }],
    });
    expect(log.info).toHaveBeenCalledWith("Flow activation complete: 2/2 succeeded");
  });

  it("waits between tracker polls with a real timer by default", async () => {
    jest.useFakeTimers({ doNotFake: ["setImmediate", "nextTick", "queueMicrotask"] });
    try {
      const fake = new FakeInstance().on(
        "GET",
        "api/sn_cicd/progress/t1",
        res({ result: { status: "1" } }),
        res({ result: { status: "2" } }),
      );
      const run = nativeInstall(probeProject(), {}, { instanceUrl: INSTANCE, auth: basicAuth, logger: logger(), fetch: fake.fetch });
      while (fake.to("api/sn_cicd/progress/t1").length < 1) await new Promise((r) => setImmediate(r));
      await jest.advanceTimersByTimeAsync(2_000);
      await expect(run).resolves.toEqual({ trackerId: "t1", rollbackId: "r1" });
      expect(fake.to("api/sn_cicd/progress/t1")).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("passes the store-app, demo-data and sync choices, and skips flow activation on request", async () => {
    const dir = withFlows(probeProject({ hostedPlugins: ["p"] }));
    const fake = new FakeInstance().on("POST", "sn_appclient_upload_processor.do", res({ executionTracker: "t1" }));
    const { run, log } = await install(dir, fake, { demoData: false, installAsync: false, skipFlowActivation: true });
    await expect(run).resolves.toEqual({ trackerId: "t1", rollbackId: undefined });
    const [upload] = fake.to("sn_appclient_upload_processor.do");
    expect(upload.url.searchParams.get("sysparm_async_fluent_install")).toBe("false");
    expect(upload.url.searchParams.has("sysparm_request_type")).toBe(false);
    expect((upload.init.body as FormData).get("load_demo")).toBe("false");
    expect(log.warn).toHaveBeenCalledWith("Hosted content will not be reloaded if the application version is unchanged.");
    expect(fake.to("api/now/wfa_fluent/activate_flows")).toHaveLength(0);
  });

  it("reports a failed install with the tracker link", async () => {
    const fake = new FakeInstance().on(
      "GET",
      "api/sn_cicd/progress/t1",
      res({ result: { status: "3", status_message: "Bad package" } }),
      res({ result: { status: "3" } }),
    );
    await expect((await install(probeProject(), fake)).run).rejects.toThrow(
      `Bad package. See execution details at ${INSTANCE}/sys_execution_tracker.do?sys_id=t1`,
    );
    await expect((await install(probeProject(), fake)).run).rejects.toThrow(/^App install failed\. See execution details/);
  });

  it("reports a tracker it cannot reach", async () => {
    const fake = new FakeInstance().on("GET", "api/sn_cicd/progress/t1", res({}, { status: 500, statusText: "Down" }));
    await expect((await install(probeProject(), fake)).run).rejects.toThrow(
      "Unable to track app install status due to a connection error. Monitor progress and verify the outcome at " +
        `${INSTANCE}/sys_execution_tracker.do?sys_id=t1 (Failed to fetch progress status: Down)`,
    );
    const failing = new FakeInstance().on("GET", "api/sn_cicd/progress/t1", () => Promise.reject("socket"));
    await expect((await install(probeProject(), failing)).run).rejects.toThrow(/\(socket\)$/);
  });

  describe("without an execution tracker", () => {
    it.each([
      ["a non-JSON answer", res("", { headers: { "content-type": "text/html" } })],
      ["no content type", res({}, { headers: { "content-type": undefined } })],
      ["an error status", res({}, { status: 500 })],
      ["JSON without a tracker", res({ ok: true })],
      ["a 400 without a tracker", res(THROWS, { status: 400 })],
    ])("waits for a new finished install after %s", async (_label, answer) => {
      const fake = new FakeInstance()
        .on("POST", "sn_appclient_upload_processor.do", answer)
        .on(
          "GET",
          "api/now/table/sys_upgrade_history",
          res({ result: [{ sys_id: "old", upgrade_finished: "2026-01-01" }] }),
          res({ result: [{ sys_id: "old", upgrade_finished: "2026-01-01" }] }),
          res({ result: [{ sys_id: "new", upgrade_finished: "" }] }),
          res({ result: [{ sys_id: "new", upgrade_finished: "2026-10-15" }] }),
        );
      const { run, sleep } = await install(probeProject(), fake);
      await expect(run).resolves.toEqual({});
      expect(sleep).toHaveBeenCalledTimes(2);
    });

    it("gives up after 30 polls", async () => {
      const fake = new FakeInstance().on("POST", "sn_appclient_upload_processor.do", res({}, { status: 500 }));
      const { run, sleep } = await install(probeProject(), fake);
      await expect(run).rejects.toThrow("Could not determine app installation status. Check instance to verify installation.");
      expect(sleep).toHaveBeenCalledTimes(29);
    });

    it("accepts the tracker of a 400 answer", async () => {
      const fake = new FakeInstance().on("POST", "sn_appclient_upload_processor.do", res({ executionTracker: "t1" }, { status: 400 }));
      await expect((await install(probeProject(), fake)).run).resolves.toEqual({ trackerId: "t1", rollbackId: undefined });
    });
  });

  it.each([
    ["an opaque redirect", res({}, { status: 0, type: "opaqueredirect" }), /redirected away from the upload endpoint/],
    ["a 302", res({}, { status: 302 }), /redirected away from the upload endpoint/],
    ["a 401", res({}, { status: 401 }), /^Insufficient permissions to install the app/],
  ])("refuses %s from the upload processor", async (_label, answer, message) => {
    const fake = new FakeInstance().on("POST", "sn_appclient_upload_processor.do", answer);
    await expect((await install(probeProject(), fake)).run).rejects.toThrow(message);
  });

  it("reports an upload that timed out and passes other failures through", async () => {
    const timeout = new FakeInstance().on("POST", "sn_appclient_upload_processor.do", () => {
      throw Object.assign(new Error("aborted"), { name: "TimeoutError" });
    });
    await expect((await install(probeProject(), timeout)).run).rejects.toThrow(
      "The deployment request timed out waiting for a response.",
    );
    const reset = new FakeInstance().on("POST", "sn_appclient_upload_processor.do", () => Promise.reject(null));
    await expect((await install(probeProject(), reset)).run).rejects.toBeNull();
  });

  describe("an app already on the instance", () => {
    const scope = (sysClassName: string, extra: Record<string, unknown> = {}) =>
      res({ result: [{ sys_id: SCOPE_ID, sys_class_name: sysClassName, active: "true", ...extra }] });

    it("refuses a second scope with the same name", async () => {
      const fake = new FakeInstance().on("GET", "api/now/table/sys_scope", res({ result: [{}, {}] }));
      await expect((await install(probeProject(), fake)).run).rejects.toThrow(
        "Multiple scopes detected with the scope name x_snc_bprobe! Please resolve the multiple application installations and try again.",
      );
    });

    it.each([
      [{ installAs: "store" }, {}, "sys_app", /^Attempting to install app with hosted_plugin content/],
      [{}, { installAsStoreApp: true }, "sys_app", /^Attempting to install a store app record but there is already a sys_app record/],
      [{}, {}, "sys_store_app", /^Attempting to install an app record but there is already a sys_store_app record/],
    ])("refuses config %j with options %j over a %s", async (config, options, sysClassName, message) => {
      const fake = new FakeInstance().on("GET", "api/now/table/sys_scope", scope(sysClassName));
      await expect((await install(probeProject(config), fake, options)).run).rejects.toThrow(message);
      expect(fake.to("sn_appclient_upload_processor.do")).toHaveLength(0);
    });

    it("installs over the same class, and hosted content over a class it cannot name", async () => {
      const same = new FakeInstance().on("GET", "api/now/table/sys_scope", scope("sys_store_app"));
      await expect((await install(probeProject({ installAs: "store" }), same)).run).resolves.toBeDefined();
      const other = new FakeInstance().on("GET", "api/now/table/sys_scope", res({ result: [{ active: false }] }));
      await expect((await install(probeProject({ hostedPlugins: ["p"] }), other)).run).resolves.toBeDefined();
      expect(other.to("sn_appclient_upload_processor.do")).toHaveLength(1);
    });

    describe("with --reinstall", () => {
      function reinstalling(sysClassName = "sys_app"): FakeInstance {
        return new FakeInstance()
          .on("GET", "api/now/table/sys_scope", scope(sysClassName), res({ result: [] }))
          .on(
            "POST",
            "xmlhttp.do",
            res({}),
            res({}, { text: '<?xml version="1.0"?><xml sysparm_max="15" answer="p1"/>' }),
          )
          .on("GET", "api/sn_cicd/progress/p1", res({ result: { status: "2", percent_complete: 100, status_message: "Deleted" } }))
          .on("GET", "api/now/table/sys_mutex", res({ result: [{ sys_id: "m" }] }), res({ result: [] }));
      }

      it("deletes the app, waits for the uninstall and the update mutex, then installs", async () => {
        const fake = reinstalling();
        const { run, log, sleep } = await install(probeProject(), fake, { clean: true });
        await expect(run).resolves.toEqual({ trackerId: "t1", rollbackId: "r1" });
        const [change, remove] = fake.to("xmlhttp.do").map((c) => Object.fromEntries(new URLSearchParams(c.init.body as string)));
        expect(change).toEqual({
          sysparm_processor: "com.snc.apps.AppsAjaxProcessor",
          sysparm_function: "changeApplication",
          sysparm_value: SCOPE_ID,
          sysparm_ck: "tok",
        });
        expect(remove).toEqual({
          sysparm_processor: "com.snc.apps.AppsAjaxProcessor",
          sysparm_function: "deleteApplication",
          sysparm_sys_id: SCOPE_ID,
          sysparm_fluent_app: "true",
          sysparm_delete_all: "true",
          sysparm_ck: "tok",
        });
        expect(log.info).toHaveBeenCalledWith(`Uninstalling application ${SCOPE_ID} for clean installation...`);
        expect(log.info).toHaveBeenCalledWith("Deleted");
        expect(log.info).toHaveBeenCalledWith(`Successfully uninstalled application with scope ID: ${SCOPE_ID}`);
        expect(sleep).toHaveBeenCalledTimes(1);
      });

      it("uninstalls a store app, waiting through a partial deletion", async () => {
        const pending = Array.from({ length: 30 }, () => res({ result: { status: "1", status_message: "Removing" } }));
        const fake = reinstalling("sys_store_app")
          .on("GET", "api/sn_cicd/progress/p1", ...pending, res({ result: { status: "3", status_message: "Failed to completely delete application" } }))
          .on("GET", "api/now/table/sys_scope", scope("sys_store_app"), scope("sys_store_app", { active: "false" }));
        const { run, log } = await install(probeProject(), fake, { clean: true });
        await expect(run).resolves.toBeDefined();
        expect(new URLSearchParams(fake.to("xmlhttp.do")[1].init.body as string).get("sysparm_function")).toBe("uninstallApplication");
        expect(log.info).toHaveBeenCalledWith("Uninstall pending, waiting on Removing");
        expect(log.warn).toHaveBeenCalledWith(expect.stringMatching(/^Deleted application and metadata/));
      });

      it("accepts a store app the instance only deactivated", async () => {
        const fake = reinstalling().on("GET", "api/sn_cicd/progress/p1", res({ result: { status: "1", status_message: "The store application was deactivated" } }));
        await expect((await install(probeProject(), fake, { clean: true })).run).resolves.toBeDefined();
      });

      it.each([
        ["the app switch fails", (f: FakeInstance) => f.on("POST", "xmlhttp.do", res({}, { status: 500, statusText: "Nope" })), "Failed to set current application: Nope"],
        ["the delete fails", (f: FakeInstance) => f.on("POST", "xmlhttp.do", res({}), res({}, { status: 500, statusText: "Nope" })), "Failed to uninstall application: Nope"],
        ["no progress id comes back", (f: FakeInstance) => f.on("POST", "xmlhttp.do", res({}), res({}, { text: "<xml/>" })), "App uninstall is taking too long or failed, please check the instance logs"],
        ["the uninstall fails", (f: FakeInstance) => f.on("GET", "api/sn_cicd/progress/p1", res({ result: { status: "4" } })), "App uninstall is taking too long or failed, please check the instance logs"],
        ["the mutex stays held", (f: FakeInstance) => f.on("GET", "api/now/table/sys_mutex", res({ result: [{}] })), "Error while waiting for app uninstall to complete, please check the instance logs"],
        ["the scope survives", (f: FakeInstance) => f.on("GET", "api/now/table/sys_scope", scope("sys_app")), "Failed to uninstall application, sys_scope record still exists"],
      ])("stops when %s", async (_label, script, message) => {
        const fake = script(reinstalling());
        const { run, log } = await install(probeProject(), fake, { clean: true });
        await expect(run).rejects.toThrow(message);
        expect(fake.to("sn_appclient_upload_processor.do")).toHaveLength(0);
        if (message.startsWith("Error while waiting")) expect(log.warn).toHaveBeenCalledWith("The update mutex is still held after the uninstall.");
      });

      it("adds the hosted-plugin note to an uninstall failure", async () => {
        const fake = reinstalling("sys_store_app").on("POST", "xmlhttp.do", res({}), res({}, { status: 500, statusText: "Nope" }));
        await expect((await install(probeProject({ hostedPlugins: ["p"] }), fake, { clean: true })).run).rejects.toThrow(
          /Nope\n For apps with hosted_plugin content, please ensure sys_property 'glide\.hosted_plugin\.uninstall\.disabled' is 'false'$/,
        );
      });
    });
  });

  describe("flow activation", () => {
    async function activate(answer: InstallResponse, dir = withFlows(probeProject())) {
      const fake = new FakeInstance().on("POST", "api/now/wfa_fluent/activate_flows", answer);
      const { run, log } = await install(dir, fake);
      await expect(run).resolves.toEqual({ trackerId: "t1", rollbackId: "r1" });
      return { log, fake };
    }

    it("skips a build without flows", async () => {
      const { log, fake } = await activate(res({}), probeProject());
      expect(fake.to("api/now/wfa_fluent/activate_flows")).toHaveLength(0);
      expect(log.debug).toHaveBeenCalledWith("No flows or actions to activate.");
    });

    it.each([
      [res({ result: { error: { message: "result error" } } }, { status: 500 }), "result error"],
      [res({ error: { message: "top error" } }, { status: 500 }), "top error"],
      [res({ message: "plain" }, { status: 500 }), "plain"],
      [res(THROWS, { status: 500, statusText: "Server Error" }), "Server Error"],
    ])("only logs a failed request (%#)", async (answer, message) => {
      const { log } = await activate(answer);
      expect(log.debug).toHaveBeenCalledWith(`Post-install task "flow-activation" failed: Failed to activate flows: ${message}`);
    });

    it("treats a missing endpoint as an instance without flow activation", async () => {
      const { log } = await activate(res({ error: { message: "Requested URI does not represent any resource" } }, { status: 400 }));
      expect(log.debug).toHaveBeenCalledWith(
        "Flow activation is not available on this instance: Requested URI does not represent any resource",
      );
    });

    it("logs an empty summary", async () => {
      const { log } = await activate(res({}));
      expect(log.debug).toHaveBeenCalledWith("Flow activation found nothing to activate.");
    });

    it("warns about partial failures, at most five of them", async () => {
      const results = [
        { success: true, sys_id: "ok" },
        { success: false, flow_name: "Flow A", message: "Invalid", errorMessage: "missing trigger" },
        ...Array.from({ length: 6 }, (_, i) => ({ success: false, sys_id: `f${i}` })),
      ];
      const { log } = await activate(res({ result: { summary: { total: 8, succeeded: 1, failed: 7 }, results } }, { status: 422 }));
      expect(log.warn.mock.calls.map(([m]) => m)).toEqual([
        "  Failed: Flow A — Invalid: missing trigger",
        "  Failed: f0 — ",
        "  Failed: f1 — ",
        "  Failed: f2 — ",
        "  Failed: f3 — ",
        "  ... and 2 more",
        "Flow activation complete: 1/8 succeeded, 7 failed",
      ]);
    });

    it("fails the task when nothing activated", async () => {
      const { log } = await activate(res({ result: { summary: { total: 1, failed: 1 } } }));
      expect(log.debug).toHaveBeenCalledWith('Post-install task "flow-activation" failed: Flow activation complete: 0/1 succeeded, 1 failed');
    });
  });

  it("uses an OAuth bearer for every request", async () => {
    const fake = new FakeInstance()
      .on("GET", "api/now/ui/user/current_user", res({ result: {} }))
      .on("GET", "api/now/table/sys_upgrade_history", res({ result: [{}] }));
    const { run } = await install(probeProject(), fake, {}, async () => ({ type: "oauth", token: "bearer" }));
    await expect(run).resolves.toBeDefined();
    expect(fake.calls.every((c) => c.init.headers.Authorization === "Bearer bearer")).toBe(true);
    expect((fake.to("sn_appclient_upload_processor.do")[0].init.body as FormData).get("sysparm_ck")).toBe("");
  });

  it("queries only the scope facts the config has", async () => {
    const fake = new FakeInstance();
    await (await install(probeProject({ scopeId: "" }), fake)).run;
    expect(fake.to("api/now/table/sys_scope")[0].url.searchParams.get("sysparm_query")).toBe("scope=x_snc_bprobe");
  });
});

describe("nativeInstallStatus", () => {
  it("reports the latest install of the scope", async () => {
    const fake = new FakeInstance().on(
      "GET",
      "api/now/table/sys_upgrade_history",
      res({ result: [{ sys_id: "h1", upgrade_finished: "2026-10-15 10:00:00" }] }),
      res({ result: [] }),
    );
    const deps = { instanceUrl: INSTANCE, auth: basicAuth, fetch: fake.fetch };
    await expect(nativeInstallStatus(probeProject(), deps)).resolves.toEqual({ finished: true, id: "h1" });
    await expect(nativeInstallStatus(probeProject(), deps)).resolves.toEqual({ finished: false, id: "" });
    expect(Object.fromEntries(fake.calls[0].url.searchParams)).toEqual({
      sysparm_query: "to_version=x_snc_bprobe^ORDERBYDESCupgrade_started",
      sysparm_fields: "upgrade_finished,sys_id",
      sysparm_limit: "1",
    });
  });
});
