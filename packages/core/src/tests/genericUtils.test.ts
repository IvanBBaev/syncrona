// SPDX-License-Identifier: GPL-3.0-or-later
import {
  chunkArr,
  allSettled,
  aggregateErrorMessages,
  wait,
  formatDuration,
} from "../genericUtils.js";
import type { Sync } from "@syncrona/types";

const fc = (name: string): Sync.FileContext =>
  ({ name } as unknown as Sync.FileContext);

describe("chunkArr", () => {
  it("splits an array into chunks of the requested size", () => {
    const arr = [fc("a"), fc("b"), fc("c"), fc("d"), fc("e")];
    const chunks = chunkArr(arr, 2);
    expect(chunks).toHaveLength(3);
    expect(chunks[0]).toHaveLength(2);
    expect(chunks[2]).toHaveLength(1); // remainder
  });

  it("returns an empty array for an empty input", () => {
    expect(chunkArr([], 3)).toEqual([]);
  });

  it("returns a single chunk when chunkSize exceeds length", () => {
    const arr = [fc("a"), fc("b")];
    const chunks = chunkArr(arr, 10);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toHaveLength(2);
  });
});

describe("allSettled", () => {
  it("reports fulfilled and rejected results without short-circuiting", async () => {
    // The no-op handler is load-bearing. allSettled is the only thing that
    // attaches a real rejection handler to this promise, so any change that
    // stops it doing so leaves the rejection unhandled — and an unhandled
    // rejection kills the whole Jest worker with exit code 1 rather than
    // failing the assertions below. Mutation testing found this the hard way:
    // emptying allSettled's map callback produced "Test runner crashed. Tried
    // twice to restart it without any luck" twice in a row, so Stryker scored
    // those mutants RuntimeError and could not grade them at all. Pre-handling
    // the rejection here keeps the failure inside the test, where
    // `results[1].status` is undefined and the expectation fails normally.
    const rejected = Promise.reject<number>(new Error("boom"));
    rejected.catch(() => undefined);

    const results = await allSettled<number>([
      Promise.resolve(1),
      rejected,
      Promise.resolve(3),
    ]);
    expect(results[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(results[1].status).toBe("rejected");
    expect(results[2]).toEqual({ status: "fulfilled", value: 3 });
  });

  it("returns an empty array for no promises", async () => {
    expect(await allSettled([])).toEqual([]);
  });
});

describe("aggregateErrorMessages", () => {
  it("joins each error with its label", () => {
    const out = aggregateErrorMessages(
      [new Error("first"), new Error("second")],
      "default",
      (_err, i) => `item ${i}`
    );
    expect(out).toContain("item 0");
    expect(out).toContain("first");
    expect(out).toContain("item 1");
    expect(out).toContain("second");
  });

  it("falls back to the default message when an error has no message", () => {
    const out = aggregateErrorMessages(
      [new Error("")],
      "fallback-msg",
      () => "label"
    );
    expect(out).toContain("fallback-msg");
  });
});

describe("wait", () => {
  it("resolves after the given delay", async () => {
    const start = Date.now();
    await wait(10);
    expect(Date.now() - start).toBeGreaterThanOrEqual(8);
  });
});

describe("formatDuration", () => {
  it("renders sub-minute durations in seconds", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(999)).toBe("1s");
  });

  it("renders minutes with optional trailing seconds", () => {
    expect(formatDuration(130_000)).toBe("2m 10s");
    expect(formatDuration(120_000)).toBe("2m");
  });

  it("renders hours with optional trailing minutes", () => {
    expect(formatDuration(3_900_000)).toBe("1h 5m");
    expect(formatDuration(3_600_000)).toBe("1h");
  });

  it("clamps non-positive and non-finite input to 0s", () => {
    expect(formatDuration(0)).toBe("0s");
    expect(formatDuration(-100)).toBe("0s");
    expect(formatDuration(Number.NaN)).toBe("0s");
    expect(formatDuration(Infinity)).toBe("0s");
  });

  // A negative ETA is not hypothetical: it comes out of `remaining / rate` the
  // moment the clock or the rate estimate skews. Small negatives round to -0 and
  // render as "0s" by accident, so the clamp is only actually observable on a
  // negative larger than half a second.
  it("clamps a large negative duration to 0s rather than rendering it", () => {
    expect(formatDuration(-100_000)).toBe("0s");
  });

  // The seconds/minutes switchover. Exactly 60s must promote to "1m" — rendering
  // "60s" is the off-by-one that a `<=` here would produce, and 59.5s must round
  // up into the same branch.
  it("switches from seconds to minutes at exactly one minute", () => {
    expect(formatDuration(59_499)).toBe("59s");
    expect(formatDuration(59_500)).toBe("1m");
    expect(formatDuration(60_000)).toBe("1m");
  });
});
