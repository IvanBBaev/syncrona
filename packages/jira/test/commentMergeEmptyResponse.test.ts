// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Regression harness for the comment-merge path (ROADMAP seventh-wave re-exam,
 * finding "jira/src/client.ts:244"): when the embedded comment page is truncated
 * and the dedicated `/issue/{key}/comment` endpoint answers 2xx with a
 * valid-shape but EMPTY `comments` array, the client must fall back to the
 * embedded page — not replace it with nothing. An empty array is truthy, so a
 * bare `if (recent)` at the merge call site would wipe every embedded comment.
 */
import { getIssue } from "../src/client";
import type { JiraConfig } from "../src/types";

const config: JiraConfig = {
  baseUrl: "https://acme.atlassian.net",
  deployment: "cloud",
  email: "me@acme.com",
  token: "tok",
};

function comment(created: string, body: string): Record<string, unknown> {
  return { author: { displayName: "A" }, created, body };
}

/** Issue payload whose embedded comment page is truncated (5 of 7 shown). */
function truncatedIssuePayload(): Record<string, unknown> {
  return {
    key: "ABC-1",
    fields: {
      summary: "S",
      comment: {
        startAt: 0,
        maxResults: 5,
        total: 7,
        comments: [
          comment("1", "e1"),
          comment("2", "e2"),
          comment("3", "e3"),
          comment("4", "e4"),
          comment("5", "e5"),
        ],
      },
    },
  };
}

function stubFetchSequence(payloads: unknown[]): jest.Mock {
  const mock = jest.fn();
  for (const payload of payloads) {
    mock.mockResolvedValueOnce({
      status: 200,
      statusText: "OK",
      text: async () => JSON.stringify(payload),
    });
  }
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

describe("getIssue comment merge on a degenerate dedicated-endpoint response", () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  it("keeps the embedded page when the dedicated endpoint returns 200 with zero comments", async () => {
    const mock = stubFetchSequence([
      truncatedIssuePayload(),
      { startAt: 0, maxResults: 5, total: 7, comments: [] },
    ]);

    const issue = await getIssue(config, "ABC-1", { comments: 5 });

    // The truncated embedded page must have triggered the dedicated fetch...
    expect(mock).toHaveBeenCalledTimes(2);
    expect(mock.mock.calls[1][0] as string).toContain("/issue/ABC-1/comment");
    // ...but its empty answer must NOT wipe the comments the issue payload
    // already carried.
    expect(issue.comments.map((c) => c.body)).toEqual(["e1", "e2", "e3", "e4", "e5"]);
  });

  it("uses a non-empty dedicated page even when it holds fewer comments than requested", async () => {
    // total(7) < requested(10): the dedicated endpoint legitimately returns all
    // seven. Fewer-than-maxResults is completeness, not failure — the fix for
    // the empty case must not discard this page.
    const mock = stubFetchSequence([
      truncatedIssuePayload(),
      {
        startAt: 0,
        maxResults: 10,
        total: 7,
        comments: [
          comment("7", "seventh"),
          comment("6", "sixth"),
          comment("5", "fifth"),
          comment("4", "fourth"),
          comment("3", "third"),
          comment("2", "second"),
          comment("1", "first"),
        ],
      },
    ]);

    const issue = await getIssue(config, "ABC-1", { comments: 10 });

    expect(mock).toHaveBeenCalledTimes(2);
    expect(issue.comments.map((c) => c.body)).toEqual([
      "first",
      "second",
      "third",
      "fourth",
      "fifth",
      "sixth",
      "seventh",
    ]);
  });
});
