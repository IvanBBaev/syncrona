// SPDX-License-Identifier: GPL-3.0-or-later
// The OAuth token poster marks a rejected token request so the data client's
// 401 handler passes it on as is. Only an object can be marked (a WeakSet
// refuses a primitive), so a token client that rejects with something else —
// null or a string, which axios itself never throws but an interceptor or an
// adapter could — must still surface that rejection, not a WeakSet TypeError.
import { jest } from "@jest/globals";

type Interceptor = (value: unknown) => unknown;
const tokenPost = jest.fn<(path: string, body: unknown) => Promise<unknown>>();
const requestInterceptors: Interceptor[] = [];

jest.unstable_mockModule("axios", () => ({
  __esModule: true,
  default: {
    isAxiosError: () => false,
    create: jest.fn((config: { headers?: Record<string, string> }) => {
      const isTokenClient = config.headers?.["Content-Type"] === "application/x-www-form-urlencoded";
      return {
        post: isTokenClient ? tokenPost : jest.fn(),
        get: jest.fn(),
        interceptors: {
          request: { use: (fn: Interceptor) => requestInterceptors.push(fn) },
          response: { use: jest.fn() },
        },
      };
    }),
  },
}));

jest.unstable_mockModule("axios-rate-limit", () => ({
  __esModule: true,
  default: (client: unknown) => client,
}));

describe("snClient OAuth token poster with a non-object rejection", () => {
  beforeEach(() => {
    tokenPost.mockReset();
    requestInterceptors.length = 0;
  });

  it.each([
    ["a string", "token client down"],
    ["null", null],
  ])("passes %s on unmarked instead of failing in the WeakSet", async (_label, rejection) => {
    tokenPost.mockRejectedValue(rejection);
    const { snClient, resetClient } = await import("../snClient.js");
    resetClient();
    snClient("https://example.service-now.com/", "u", "p", {
      clientId: "cid",
      clientSecret: "secret",
      grantType: "password",
    });

    expect(requestInterceptors).toHaveLength(1);
    let caught: unknown = "not rejected";
    try {
      await requestInterceptors[0]({ headers: {} });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBe(rejection);
    expect(tokenPost).toHaveBeenCalledTimes(1);
  });
});
