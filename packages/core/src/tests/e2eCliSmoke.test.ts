import { execFile } from "child_process";
import { existsSync } from "fs";
import fs from "fs";
import os from "os";
import path from "path";

export {};

// E2E smoke (G11 first slice): boots the actual compiled CLI binary as a
// child process — catches packaging/bootstrap breakage (wrong main, module
// kind, registry wiring) that unit tests with mocks can never see.
// Requires dist/ to be built (always true in CI; skip locally otherwise).

const CLI = path.resolve(__dirname, "../../dist/index.js");
const describeIfBuilt = existsSync(CLI) ? describe : describe.skip;

type CliResult = { code: number; stdout: string; stderr: string };

function runCli(args: string[], cwd: string): Promise<CliResult> {
  return new Promise((resolve) => {
    const env = { ...process.env, SYNCRONA_NO_UPDATE_NOTIFIER: "1", CI: "1" };
    // The bootstrap exits early under jest — the child must look like a
    // regular CLI invocation.
    delete (env as Record<string, unknown>).JEST_WORKER_ID;
    execFile(
      process.execPath,
      [CLI, ...args],
      { cwd, env, timeout: 20000 },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code?: number }).code as number)
            : err
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      }
    );
  });
}

describeIfBuilt("CLI e2e smoke (dist binary)", () => {
  let workspace: string;

  beforeAll(() => {
    workspace = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-e2e-"));
  });

  it("boots and lists every registry command in --help", async () => {
    const res = await runCli(["--help"], workspace);
    const out = res.stdout + res.stderr;

    expect(res.code).toBe(0);
    for (const command of [
      "dev",
      "refresh",
      "push",
      "download",
      "init",
      "build",
      "deploy",
      "docs",
      "status",
      "doctor",
      "plugins",
      "mcp",
      "login",
      "logout",
      "instances",
      "use",
    ]) {
      expect(out).toContain(command);
    }
  }, 30000);

  it("rejects unknown commands with a non-zero exit (strict surface)", async () => {
    const res = await runCli(["frobnicate"], workspace);
    expect(res.code).not.toBe(0);
  }, 30000);
});
