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
