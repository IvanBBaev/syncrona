// SPDX-License-Identifier: GPL-3.0-or-later
import { formatDuration } from "./genericUtils.js";

// Exported for tests (progressTick.test.ts renders this with a faked TTY to lock
// DEV-3: the format token must not start with a built-in progress token).
export const getProgTick = (
  logLevel: string,
  total: number,
  stream: NodeJS.WritableStream = process.stderr
): (() => void) | undefined => {
  if (logLevel !== "info") {
    // no-op at other log levels
    return undefined;
  }
  // DX24: show count and an ETA derived from observed throughput, e.g.
  //   [========            ] 30/100 (30%) ~2m 10s left
  // Rendered by hand (no `progress` dependency): the trailing "left" label is
  // suffixed to an already-formatted duration, so it can never collide with a
  // reserved token the way `progress`'s `:eta`/`:etaHuman` templating could.
  const width = 40;
  const isTty = Boolean((stream as unknown as { isTTY?: boolean }).isTTY);
  const startedAt = Date.now();
  let completed = 0;
  return () => {
    completed += 1;
    const elapsed = Date.now() - startedAt;
    const remainingMs =
      completed > 0 && completed < total
        ? (elapsed / completed) * (total - completed)
        : 0;
    // Only paint a live bar on a TTY; on pipes/CI we advance silently.
    if (!isTty) {
      return;
    }
    const ratio = total > 0 ? Math.min(1, completed / total) : 1;
    const filled = Math.round(width * ratio);
    const bar = "=".repeat(filled) + " ".repeat(width - filled);
    const percent = Math.round(ratio * 100);
    const line = `${bar} ${completed}/${total} (${percent}%) ~${formatDuration(
      remainingMs
    )} left`;
    stream.write(`\r${line}`);
    if (completed >= total) {
      stream.write("\n");
    }
  };
};
