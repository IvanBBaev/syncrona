import { Sync } from "@syncro-now-ai/types";

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
