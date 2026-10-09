// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

// `syncrona download <scope>` against an existing scope that owns no
// sys_metadata rows. The empty-manifest refusal must hold on BOTH paths: a
// scoped endpoint that answers `{ tables: {} }` must not slip an empty manifest
// (with no scopeId) past the guard the Table API build enforces. Real
// downloadCommand + manifest builder; only defaultClient is replaced.

const SCOPE_ID = "b".repeat(32);

const ok = (result: unknown) =>
  Promise.resolve({ status: 200, data: { result } }) as Promise<never>;
const http = (status: number) =>
  Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status, data: {} },
  });

let endpointMode: "missing" | "empty" = "missing";
const fake = {
  getManifest: jest.fn((scope: string) =>
    endpointMode === "missing"
      ? (Promise.reject(http(404)) as Promise<never>)
      : ok({ scope, tables: {} })
  ),
  tableAPIGet: jest.fn((table: string, query: string) => {
    if ((table === "sys_app" || table === "sys_scope") && /^scope=/.test(query)) {
      return ok([{ sys_id: SCOPE_ID }]);
    }
    return ok([]);
  }),
};

// Any prompt under --ci is a bug: without a terminal it would hang a CI job.
const prompt = jest.fn(() => Promise.reject(new Error("prompted under --ci")));
jest.unstable_mockModule("inquirer", () => ({ default: { prompt } }));

const actual = await import("../snClient.js");
jest.unstable_mockModule("../snClient.js", () => ({
  ...actual,
  defaultClient: () => fake,
}));

const { downloadCommand } = await import("../commands.js");
const ConfigManager = await import("../config.js");
const { logger } = await import("../Logger.js");
const { initCommands } = await import("../commander.js");

describe.each(["missing", "empty"] as const)(
  "`syncrona download <empty scope> --ci` (scoped endpoint %s)",
  (mode) => {
    const originalCwd = process.cwd();
    let tmp: string;

    beforeEach(() => {
      endpointMode = mode;
      tmp = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-download-empty-"));
      fs.writeFileSync(path.join(tmp, "sync.config.js"), ConfigManager.getDefaultConfigFile("src"));
      fs.mkdirSync(path.join(tmp, "src"));
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

    it("refuses to build an empty manifest and writes none", async () => {
      await ConfigManager.loadConfigs();
      await expect(
        downloadCommand({ logLevel: "info", scope: "x_acme_asset_track", ci: true } as never)
      ).rejects.toThrow(/No tables discovered for scope "x_acme_asset_track"\. Refusing to build an empty manifest/);
      expect(fs.existsSync(path.join(tmp, "sync.manifest.json"))).toBe(false);
    });

    it("through the CLI: no prompt, exit code 1, and an error that names the empty-scope case", async () => {
      await ConfigManager.loadConfigs();
      const errors: string[] = [];
      (logger.error as unknown as jest.Mock).mockImplementation(((m: string) => errors.push(m)) as never);
      const previousExitCode = process.exitCode;
      process.exitCode = undefined;
      try {
        await initCommands(["download", "x_acme_asset_track", "--ci"]);
        // runHandler settles the command asynchronously; wait for its sink.
        for (let i = 0; i < 200 && process.exitCode === undefined; i++) {
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = previousExitCode;
      }
      expect(prompt).not.toHaveBeenCalled();
      const refusal = errors.find((m) => m.startsWith("No tables discovered"));
      expect(refusal).toMatch(/No tables discovered for scope "x_acme_asset_track"/);
      expect(refusal).toMatch(/owns no records yet, there is nothing to download/);
      // The scope exists, so `init --new` (which refuses an existing scope and
      // points back at `download`) must not be the advice: that loop has no exit.
      expect(refusal).not.toMatch(/init --new/);
      expect(refusal).toMatch(/excludes: \{ <table>: false \}/);
      expect(refusal).toMatch(/syncrona config show-defaults/);
      expect(refusal).toMatch(/dataModelTables/);
      expect(fs.existsSync(path.join(tmp, "sync.manifest.json"))).toBe(false);
    });
  }
);

describe("`syncrona refresh` keeps the scopeId init --new wrote", () => {
  const originalCwd = process.cwd();
  let tmp: string;

  beforeEach(() => {
    endpointMode = "empty";
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-refresh-scopeid-"));
    fs.writeFileSync(path.join(tmp, "sync.config.js"), ConfigManager.getDefaultConfigFile("src"));
    fs.mkdirSync(path.join(tmp, "src"));
    fs.writeFileSync(
      path.join(tmp, "sync.manifest.json"),
      JSON.stringify({ scope: "x_acme_asset_track", scopeId: SCOPE_ID, tables: {} })
    );
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

  it("carries the scopeId over when the fresh manifest has none", async () => {
    await ConfigManager.loadConfigs();
    const { syncManifest } = await import("../downloadPipeline.js");
    await expect(syncManifest()).resolves.toBe(true);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, "sync.manifest.json"), "utf8"));
    expect(manifest).toEqual({ scope: "x_acme_asset_track", scopeId: SCOPE_ID, tables: {} });
  });
});
