// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import { AxiosError, AxiosHeaders, type AxiosResponse } from "axios";
import {
  retryOnErr,
  processPushResponse,
  getErrorResponseStatus,
  isRetryableRequestError,
} from "../snClient.js";

const resp = (status: number): AxiosResponse =>
  ({ status } as AxiosResponse);

describe("processPushResponse", () => {
  it("maps 404 to a 'not found' failure", () => {
    const r = processPushResponse(resp(404), "sys_script/MyRule/abc");
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/Could not find/);
  });

  it("maps other non-2xx statuses to a generic failure", () => {
    const r = processPushResponse(resp(500), "sys_script/MyRule/abc");
    expect(r.success).toBe(false);
    expect(r.message).toMatch(/unexpected response \(500\)/);
  });

  it("maps 2xx to success (boundaries included)", () => {
    expect(processPushResponse(resp(200), "x").success).toBe(true);
    expect(processPushResponse(resp(201), "x").success).toBe(true);
    expect(processPushResponse(resp(299), "x").success).toBe(true);
  });

  it("treats 300 as a failure", () => {
    expect(processPushResponse(resp(300), "x").success).toBe(false);
  });

  it("words each outcome exactly", () => {
    expect(processPushResponse(resp(204), "rec")).toEqual({ success: true, message: "rec pushed successfully!" });
    expect(processPushResponse(resp(404), "rec")).toEqual({
      success: false,
      message: "Could not find rec on the server.",
    });
    expect(processPushResponse(resp(199), "rec")).toEqual({
      success: false,
      message: "Failed to push rec. Received an unexpected response (199)",
    });
  });
});

describe("retryOnErr", () => {
  it("returns the value on the first successful attempt", async () => {
    const f = jest.fn().mockResolvedValue("ok");
    const out = await retryOnErr(f, 3);
    expect(out).toBe("ok");
    expect(f).toHaveBeenCalledTimes(1);
  });

  it("retries until success and reports remaining retries", async () => {
    const f = jest
      .fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("recovered");
    const onRetry = jest.fn();
    const out = await retryOnErr(f, 2, 0, onRetry);
    expect(out).toBe("recovered");
    expect(f).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenCalledWith(1);
  });

  it("throws once retries are exhausted", async () => {
    const f = jest.fn().mockRejectedValue(new Error("permanent"));
    await expect(retryOnErr(f, 1)).rejects.toThrow("permanent");
    expect(f).toHaveBeenCalledTimes(2); // initial + 1 retry
  });

  it("makes a single attempt when no retries are allowed", async () => {
    const f = jest.fn().mockRejectedValue(new Error("once"));
    const onRetry = jest.fn();
    await expect(retryOnErr(f, 0, 0, onRetry)).rejects.toThrow("once");
    expect(f).toHaveBeenCalledTimes(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it("counts the remaining retries down on every failed attempt", async () => {
    const f = jest
      .fn()
      .mockRejectedValueOnce(new Error("1"))
      .mockRejectedValueOnce(new Error("2"))
      .mockRejectedValueOnce(new Error("3"))
      .mockResolvedValue("done");
    const onRetry = jest.fn();
    await expect(retryOnErr(f, 3, 0, onRetry)).resolves.toBe("done");
    expect(onRetry.mock.calls).toEqual([[2], [1], [0]]);
  });

  it("rethrows the last error once the retries run out", async () => {
    const last = new Error("last");
    const f = jest.fn().mockRejectedValueOnce(new Error("first")).mockRejectedValueOnce(last);
    await expect(retryOnErr(f, 1)).rejects.toBe(last);
  });

  it("consults the retry predicate only for failures", async () => {
    const shouldRetry = jest.fn().mockReturnValue(true);
    const failure = new Error("flaky");
    const f = jest.fn().mockRejectedValueOnce(failure).mockResolvedValue("ok");
    await expect(retryOnErr(f, 2, 0, undefined, shouldRetry)).resolves.toBe("ok");
    expect(shouldRetry).toHaveBeenCalledTimes(1);
    expect(shouldRetry).toHaveBeenCalledWith(failure);
  });

  it("short-circuits when shouldRetry returns false", async () => {
    const f = jest.fn().mockRejectedValue(new Error("fatal"));
    const shouldRetry = jest.fn().mockReturnValue(false);
    await expect(retryOnErr(f, 5, 0, undefined, shouldRetry)).rejects.toThrow(
      "fatal"
    );
    expect(f).toHaveBeenCalledTimes(1); // no retry attempted
  });

  it("waits for the server's Retry-After before retrying a throttled request", async () => {
    jest.useFakeTimers();
    try {
      const throttled = new AxiosError("Too Many Requests", "ERR_BAD_REQUEST", undefined, undefined, {
        status: 429,
        headers: new AxiosHeaders({ "Retry-After": "2" }),
      } as AxiosResponse);
      const f = jest.fn<() => Promise<string>>().mockRejectedValueOnce(throttled).mockResolvedValue("ok");
      const out = retryOnErr(f, 1, 10);
      await jest.advanceTimersByTimeAsync(1_999);
      expect(f).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      await expect(out).resolves.toBe("ok");
      expect(f).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("reads Retry-After from plain lower-cased headers and ignores a non-text value", async () => {
    jest.useFakeTimers();
    try {
      const withHeaders = (headers: Record<string, unknown>) =>
        new AxiosError("Service Unavailable", "ERR_BAD_RESPONSE", undefined, undefined, {
          status: 503,
          headers,
        } as unknown as AxiosResponse);
      const f = jest
        .fn<() => Promise<string>>()
        .mockRejectedValueOnce(withHeaders({ "retry-after": "1" }))
        .mockRejectedValueOnce(withHeaders({ "retry-after": 5 }))
        .mockResolvedValue("ok");
      const out = retryOnErr(f, 2, 10);
      await jest.advanceTimersByTimeAsync(999);
      expect(f).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(1);
      expect(f).toHaveBeenCalledTimes(2);
      // The numeric header is not a string, so the fixed 10 ms spacing applies.
      await jest.advanceTimersByTimeAsync(10);
      await expect(out).resolves.toBe("ok");
      expect(f).toHaveBeenCalledTimes(3);
    } finally {
      jest.useRealTimers();
    }
  });
});

describe("getErrorResponseStatus / isRetryableRequestError", () => {
  it("returns undefined status for a non-axios error", () => {
    expect(getErrorResponseStatus(new Error("plain"))).toBeUndefined();
  });

  it("treats a network error (no HTTP status) as retryable", () => {
    expect(isRetryableRequestError(new Error("ECONNRESET"))).toBe(true);
  });
});
