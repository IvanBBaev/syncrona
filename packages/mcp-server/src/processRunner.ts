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

// REV-210: escalation budget after a timeout fires. SIGTERM goes out immediately,
// SIGKILL follows after KILL_GRACE_MS, and GIVE_UP_MS after the SIGTERM we answer
// unconditionally — because `close` is not ours to wait for (see settle() below).
const KILL_GRACE_MS = 1500;
const GIVE_UP_MS = 2500;
const GIVE_UP_NOTICE =
  "\n[timed out: the child was killed but its output streams stayed open " +
  "(a grandchild process is likely still holding them); reporting without waiting " +
  "for them to close]";

export function runCommand(
  command: string,
  args: string[],
  timeoutMs: number = DEFAULT_TIMEOUT_MS,
  cwd: string = PROJECT_DIR,
  extraEnv?: Record<string, string>,
  // REV-82 (SEC-1): base environment for the child, defaulting to the server's
  // own `process.env`. A caller can pass a reduced copy (e.g.
  // scrubSecretsFromEnv(process.env)) so a spawned child never inherits
  // credential-bearing variables; `extraEnv` is still layered on top.
  envBase: NodeJS.ProcessEnv = process.env
): Promise<CmdResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...envBase,
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
    let killTimer: NodeJS.Timeout | undefined;
    let giveUpTimer: NodeJS.Timeout | undefined;

    // REV-210: the single exit from this promise. Two things were wrong before.
    //
    // (1) The promise could only settle from `error` or `close`. Node emits `close`
    //     after the process has exited AND its stdio streams have been closed, so a
    //     child that spawns a grandchild with inherited stdio keeps the pipes open
    //     after it dies — and neither SIGTERM nor the follow-up SIGKILL reaches the
    //     grandchild, since the child is not spawned in its own process group. The
    //     timeout branch therefore killed the child and then waited forever. Every
    //     caller plainly awaits this function with no outer deadline, so the MCP tool
    //     call hung indefinitely. A timeout has to be a guarantee about when we
    //     answer, so the timeout branch now arms a give-up timer that settles without
    //     depending on any child event.
    //
    // (2) With more than one settle path, `resolve` had to become idempotent, and
    //     every timer had to be cleared from one place — otherwise the escalation
    //     chain keeps the event loop alive for seconds after we have already
    //     answered. Detaching the stream listeners and destroying the pipes matters
    //     for the same reason: an abandoned grandchild must not keep writing into
    //     buffers nobody will read, nor hold a handle that stops the server exiting.
    const settle = (result: CmdResult): void => {
      if (finished) {
        return;
      }
      finished = true;
      clearTimeout(timeout);
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (giveUpTimer) {
        clearTimeout(giveUpTimer);
      }
      child.stdout?.removeAllListeners("data");
      child.stderr?.removeAllListeners("data");
      resolve(result);
    };

    const timeout = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => {
        if (!finished) {
          child.kill("SIGKILL");
        }
      }, KILL_GRACE_MS);
      giveUpTimer = setTimeout(() => {
        if (finished) {
          return;
        }
        // Release what we can before abandoning the child: the pipes are the only
        // handles we own, and holding them would keep this process from exiting.
        child.stdout?.destroy();
        child.stderr?.destroy();
        child.unref();
        settle({
          exitCode: 1,
          stdout: finalStdout(),
          stderr: `${finalStderr()}${GIVE_UP_NOTICE}`,
          timedOut: true,
        });
      }, GIVE_UP_MS);
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
      settle({
        exitCode: 1,
        stdout: finalStdout(),
        stderr: `${finalStderr()}\n${err.message}`,
        timedOut,
      });
    });

    child.on("close", (code: number | null) => {
      settle({
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
