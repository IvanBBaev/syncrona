// SPDX-License-Identifier: GPL-3.0-or-later
import { getIssue, type JiraConfig } from "../src/index";

describe("getIssue network failure reason", () => {
  const config: JiraConfig = {
    baseUrl: "https://acme.atlassian.net",
    deployment: "cloud",
    email: "me@acme.com",
    token: "tok",
  };
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function rejectWith(error: Error): void {
    global.fetch = jest.fn().mockRejectedValue(error) as unknown as typeof fetch;
  }

  it("includes the cause code Node's fetch hides behind 'fetch failed'", async () => {
    const cause = Object.assign(new Error("getaddrinfo ENOTFOUND acme.atlassian.net"), {
      code: "ENOTFOUND",
    });
    rejectWith(new TypeError("fetch failed", { cause }));
    await expect(getIssue(config, "ABC-1")).rejects.toThrow(
      "Jira request failed: fetch failed (ENOTFOUND)"
    );
  });

  it("falls back to the cause message when it carries no code", async () => {
    rejectWith(new TypeError("fetch failed", { cause: new Error("socket hang up") }));
    await expect(getIssue(config, "ABC-1")).rejects.toThrow(
      "Jira request failed: fetch failed (socket hang up)"
    );
  });

  it("leaves a failure without a cause unchanged", async () => {
    rejectWith(new Error("ECONNREFUSED"));
    await expect(getIssue(config, "ABC-1")).rejects.toThrow(/^Jira request failed: ECONNREFUSED$/);
  });
});
