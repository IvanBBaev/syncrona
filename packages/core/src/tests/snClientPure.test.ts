import type { AxiosResponse } from "axios";
import {
  retryOnErr,
  processPushResponse,
  getErrorResponseStatus,
  isRetryableRequestError,
} from "../snClient";

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
});

describe("getErrorResponseStatus / isRetryableRequestError", () => {
  it("returns undefined status for a non-axios error", () => {
    expect(getErrorResponseStatus(new Error("plain"))).toBeUndefined();
  });

  it("treats a network error (no HTTP status) as retryable", () => {
    expect(isRetryableRequestError(new Error("ECONNRESET"))).toBe(true);
  });
});
