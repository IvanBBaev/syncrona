import { spawn } from "child_process";
import { existsSync } from "fs";
import path from "path";
import { DEFAULT_TIMEOUT_MS, PRIMARY_SYNCRO_CLI, PROJECT_DIR } from "./runtimeConfig";

export type CmdResult = {
  exitCode: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
};

export function runCommand(
  command: string,
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  cwd: string = PROJECT_DIR,
  extraEnv?: Record<string, string>
): Promise<CmdResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...process.env,
        ...(extraEnv || {}),
      },
      shell: false,
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let finished = false;

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => {
        if (!finished) {
          child.kill("SIGKILL");
        }
      }, 1500);
    }, timeoutMs);

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("error", (err: Error) => {
      clearTimeout(timeout);
      finished = true;
      resolve({
        exitCode: 1,
        stdout,
        stderr: `${stderr}\n${err.message}`,
        timedOut,
      });
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timeout);
      finished = true;
      resolve({
        exitCode: code ?? 1,
        stdout,
        stderr,
        timedOut,
      });
    });
  });
}

export async function runSyncroCliCommand(
  subcommand: string,
  args: string[],
  timeoutMs: number,
  projectDir: string = PROJECT_DIR,
  extraEnv?: Record<string, string>
): Promise<CmdResult> {
  const localCoreCli = path.resolve(__dirname, "../../core/dist/index.js");
  if (existsSync(localCoreCli)) {
    return runCommand("node", [localCoreCli, subcommand, ...args], timeoutMs, projectDir, extraEnv);
  }

  return runCommand("npx", [PRIMARY_SYNCRO_CLI, subcommand, ...args], timeoutMs, projectDir, extraEnv);
}
