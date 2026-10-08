// SPDX-License-Identifier: GPL-3.0-or-later
import { Sync } from "@syncrona/types";

// INJ-1: the single rule for "is this string safe to use as ONE path segment?".
// It lives in this leaf module (nothing but @syncrona/types is imported here) so
// every consumer that joins an instance-supplied name onto a local path — the
// download pipeline, `init --ci`'s packages/<scope> directories, the scope doc
// generator — shares the exact same rule without dragging a module graph along.
//
// It also refuses what no filesystem can store as written: a NUL or other C0/C1
// control character or DEL (NUL truncates the name in every OS call; the rest
// are refused by Windows and break terminals and git), a lone UTF-16 surrogate
// (Node writes it as U+FFFD, so the name on disk is not the name asked for),
// and a segment over 255 UTF-8 bytes (NAME_MAX on Linux and macOS, ENAMETOOLONG).
// Record names are made to fit first (recordFolderNames.sanitizeRecordFolderName);
// every other segment — table, field, type, scope — is instance data that must
// be refused rather than altered, because it also addresses the instance.
export const MAX_PATH_SEGMENT_BYTES = 255;

export interface UnsafePathComponent {
  /** Why the segment is refused, as a clause: "it contains a path separator (path traversal)". */
  reason: string;
  /**
   * True when the segment would take a joined path somewhere else (a separator,
   * a dot-only name, an empty segment). False when it stays in place but no
   * filesystem stores it as written — a refusal message must not then claim an
   * escape that would not happen.
   */
  traversal: boolean;
}

const codePointLabel = (char: string): string =>
  `U+${(char.codePointAt(0) ?? 0).toString(16).toUpperCase().padStart(4, "0")}`;

/** The reason isSafePathComponent refuses `component`, or undefined when it accepts it. */
export const unsafePathComponentReason = (
  component: string
): UnsafePathComponent | undefined => {
  if (typeof component !== "string") return { reason: "it is not a string", traversal: true };
  if (component.length === 0) return { reason: "it is empty", traversal: true };
  if (/^\.+$/.test(component)) {
    return { reason: "it is a relative directory name (path traversal)", traversal: true };
  }
  if (/[/\\]/.test(component)) {
    return { reason: "it contains a path separator (path traversal)", traversal: true };
  }
  const control = /[\u0000-\u001f\u007f-\u009f]/u.exec(component);
  if (control) {
    return {
      reason: `it contains a control character (${codePointLabel(control[0])})`,
      traversal: false,
    };
  }
  // With the `u` flag a paired surrogate is one code point and does not match;
  // only a lone half does.
  const surrogate = /[\ud800-\udfff]/u.exec(component);
  if (surrogate) {
    return {
      reason: `it contains a lone UTF-16 surrogate (${codePointLabel(surrogate[0])})`,
      traversal: false,
    };
  }
  const bytes = Buffer.byteLength(component, "utf8");
  if (bytes > MAX_PATH_SEGMENT_BYTES) {
    return {
      reason: `it is ${bytes} UTF-8 bytes, over the ${MAX_PATH_SEGMENT_BYTES}-byte limit for one path segment`,
      traversal: false,
    };
  }
  return undefined;
};

export const isSafePathComponent = (component: string): boolean =>
  unsafePathComponentReason(component) === undefined;

export function wait(ms: number) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function chunkArr(
  arr: Sync.FileContext[],
  chunkSize: number
): Sync.FileContext[][] {
  const numChunks = Math.ceil(arr.length / chunkSize);
  const chunks: Sync.FileContext[][] = [];
  for (let i = 0; i < numChunks; i++) {
    const rangeBegin = i * chunkSize;
    const rangeEnd =
      rangeBegin + chunkSize > arr.length ? arr.length : rangeBegin + chunkSize;
    chunks.push(arr.slice(rangeBegin, rangeEnd));
  }
  return chunks;
}

export const allSettled = <T>(
  promises: Promise<T>[]
): Promise<Sync.PromiseResult<T>[]> => {
  return Promise.all(
    promises.map((prom) =>
      prom
        .then(
          (value): Sync.PromiseResult<T> => ({
            status: "fulfilled",
            value,
          })
        )
        .catch(
          (reason): Sync.PromiseResult<T> => ({
            status: "rejected",
            reason,
          })
        )
    )
  );
};

export const aggregateErrorMessages = (
  errs: Error[],
  defaultMsg: string,
  labelFn: (err: Error, index: number) => string
): string => {
  return errs.reduce((acc, err, index) => {
    return `${acc}\n${labelFn(err, index)}:\n${err.message || defaultMsg}`;
  }, "");
};

// DX24: render a coarse human duration for progress ETAs ("45s", "2m 10s",
// "1h 5m"). Pure; non-finite or non-positive input renders as "0s".
export function formatDuration(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) {
    return "0s";
  }
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }
  const hours = Math.floor(minutes / 60);
  const remMinutes = minutes % 60;
  return remMinutes > 0 ? `${hours}h ${remMinutes}m` : `${hours}h`;
}

// Render a column-aligned text table (header, separator, rows). No deps; used
// for readable dry-run previews. Missing cells are treated as empty.
export function formatTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length))
  );
  const renderRow = (cells: string[]): string =>
    cells.map((cell, i) => (cell ?? "").padEnd(widths[i])).join("  ").trimEnd();
  const separator = widths.map((w) => "-".repeat(w)).join("  ");
  return [renderRow(headers), separator, ...rows.map(renderRow)].join("\n");
}
