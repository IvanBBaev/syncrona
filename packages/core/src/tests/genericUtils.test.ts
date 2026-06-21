import {
  chunkArr,
  allSettled,
  aggregateErrorMessages,
  wait,
  formatDuration,
} from "../genericUtils";
import type { Sync } from "@syncro-now-ai/types";

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
    const results = await allSettled<number>([
      Promise.resolve(1),
      Promise.reject(new Error("boom")),
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
});
