// SPDX-License-Identifier: GPL-3.0-or-later
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

// Cap captured output per stream. Without this a runaway child (an infinite log
// loop, a binary dump) grows the in-memory string until the server OOMs; the
// captured text is only ever shown/parsed, so truncating it is safe.
const MAX_OUTPUT_CHARS = 5_000_000;
const TRUNCATION_NOTICE = "\n[output truncated: exceeded capture limit]";

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
    let stdoutTruncated = false;
    let stderrTruncated = false;
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
      if (stdoutTruncated) {
        return;
      }
      stdout += chunk.toString();
      if (stdout.length > MAX_OUTPUT_CHARS) {
        stdout = stdout.slice(0, MAX_OUTPUT_CHARS);
        stdoutTruncated = true;
      }
    });

    child.stderr.on("data", (chunk: Buffer) => {
      if (stderrTruncated) {
        return;
      }
      stderr += chunk.toString();
      if (stderr.length > MAX_OUTPUT_CHARS) {
        stderr = stderr.slice(0, MAX_OUTPUT_CHARS);
        stderrTruncated = true;
      }
    });

    const finalStdout = (): string => (stdoutTruncated ? stdout + TRUNCATION_NOTICE : stdout);
    const finalStderr = (): string => (stderrTruncated ? stderr + TRUNCATION_NOTICE : stderr);

    child.on("error", (err: Error) => {
      clearTimeout(timeout);
      finished = true;
      resolve({
        exitCode: 1,
        stdout: finalStdout(),
        stderr: `${finalStderr()}\n${err.message}`,
        timedOut,
      });
    });

    child.on("close", (code: number | null) => {
      clearTimeout(timeout);
      finished = true;
      resolve({
        exitCode: code ?? 1,
        stdout: finalStdout(),
        stderr: finalStderr(),
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
