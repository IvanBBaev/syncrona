// SPDX-License-Identifier: GPL-3.0-or-later
import {
  extractIssueKey,
  detectDeployment,
  restApiBase,
  adfToText,
  normalizeIssue,
  buildAuthHeader,
  getIssue,
  verifyAuth,
  jiraUndecryptableMessage,
  JiraHttpError,
  isJiraHttpError,
  jiraHttpError,
  CLOUD_MISSING_EMAIL_MESSAGE,
  type JiraConfig,
} from "../src/index";

describe("branch.extractIssueKey", () => {
  it("extracts the first Jira key from a branch name", () => {
    expect(extractIssueKey("feature/ABC-123-do-thing")).toBe("ABC-123");
  });

  it("upper-cases a lowercase branch", () => {
    expect(extractIssueKey("feature/abc-123")).toBe("ABC-123");
  });

  it("returns the first key when several are present", () => {
    expect(extractIssueKey("ABC-1-then-DEF-2")).toBe("ABC-1");
  });

  it("returns null when no key is present", () => {
    expect(extractIssueKey("main")).toBeNull();
    expect(extractIssueKey("")).toBeNull();
    expect(extractIssueKey(null)).toBeNull();
    expect(extractIssueKey(undefined)).toBeNull();
  });

  it("returns null when the hyphen is not followed by digits", () => {
    // `LOGIN-PAGE` has no numeric issue number, so it is not a Jira key.
    expect(extractIssueKey("hotfix/login-page")).toBeNull();
  });

  it("ignores standards/notation tokens that look like keys", () => {
    // `utf-8` would otherwise resolve to the bogus key `UTF-8`.
    expect(extractIssueKey("fix/utf-8-encoding")).toBeNull();
    expect(extractIssueKey("chore/bump-to-rfc-7231")).toBeNull();
  });

  it("skips a denylisted token and keeps the first genuine key", () => {
    expect(extractIssueKey("fix-utf-8-for-ABC-42")).toBe("ABC-42");
  });
});

describe("deployment detection", () => {
  it("detects Cloud from atlassian.net and jira.com hosts", () => {
    expect(detectDeployment("https://acme.atlassian.net")).toBe("cloud");
    expect(detectDeployment("https://acme.jira.com")).toBe("cloud");
  });

  it("treats anything else as server", () => {
    expect(detectDeployment("https://jira.acme.com")).toBe("server");
    expect(detectDeployment("https://servicenow.acme.internal/jira")).toBe("server");
  });

  it("falls back to a substring check for an unparseable URL", () => {
    expect(detectDeployment("acme.atlassian.net")).toBe("cloud");
    expect(detectDeployment("not a url")).toBe("server");
  });

  it("ignores the port when detecting the deployment", () => {
    // `.host` would carry ":8443" and miss the Cloud suffix; `.hostname` does not.
    expect(detectDeployment("https://acme.atlassian.net:8443")).toBe("cloud");
    expect(detectDeployment("https://jira.acme.com:8080")).toBe("server");
  });

  it("maps the deployment to the right REST base", () => {
    expect(restApiBase("cloud")).toBe("/rest/api/3");
    expect(restApiBase("server")).toBe("/rest/api/2");
  });
});

describe("adfToText", () => {
  it("passes a plain string through, trimmed", () => {
    expect(adfToText("  hello world  ")).toBe("hello world");
  });

  it("returns an empty string for null/undefined", () => {
    expect(adfToText(null)).toBe("");
    expect(adfToText(undefined)).toBe("");
  });

  it("flattens a paragraph document", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [{ type: "text", text: "First line." }],
        },
        {
          type: "paragraph",
          content: [{ type: "text", text: "Second line." }],
        },
      ],
    };
    expect(adfToText(doc)).toBe("First line.\n\nSecond line.");
  });

  it("renders bullet and ordered lists", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            { type: "listItem", content: [{ type: "text", text: "a" }] },
            { type: "listItem", content: [{ type: "text", text: "b" }] },
          ],
        },
        {
          type: "orderedList",
          content: [
            { type: "listItem", content: [{ type: "text", text: "one" }] },
            { type: "listItem", content: [{ type: "text", text: "two" }] },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toBe("- a\n- b\n\n1. one\n2. two");
  });

  it("handles hardBreak, mention and emoji nodes", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "hi " },
            { type: "mention", attrs: { text: "@bob" } },
            { type: "hardBreak" },
            { type: "emoji", attrs: { shortName: ":tada:" } },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toBe("hi @bob\n:tada:");
  });

  it("extracts the URL from an attrs-only inlineCard (pasted link)", () => {
    // A pasted link is an `inlineCard` with `attrs.url` and NO `content` — it
    // must not vanish, leaving "See the spec:" with the URL gone (finding #37).
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "text", text: "See the spec: " },
            { type: "inlineCard", attrs: { url: "https://example.com/spec" } },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toBe("See the spec: https://example.com/spec");
  });

  it("falls back to a smart-link's resolved data.url", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            {
              type: "inlineCard",
              attrs: { data: { url: "https://example.com/resolved" } },
            },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toBe("https://example.com/resolved");
  });

  it("renders a status lozenge's text and a date pill", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "paragraph",
          content: [
            { type: "status", attrs: { text: "IN PROGRESS", color: "yellow" } },
            { type: "text", text: " by " },
            // 2026-01-02T00:00:00.000Z = 1767312000000 ms.
            { type: "date", attrs: { timestamp: 1767312000000 } },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toBe("IN PROGRESS by 2026-01-02");
  });

  it("emits a placeholder for a media attachment node", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "mediaSingle",
          content: [
            { type: "media", attrs: { type: "file", alt: "diagram.png" } },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toBe("[attachment: diagram.png]");
  });

  it("renders an attrs-only blockCard at block level", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "blockCard", attrs: { url: "https://example.com/board" } },
      ],
    };
    expect(adfToText(doc)).toBe("https://example.com/board");
  });

  it("recurses into unknown node types instead of dropping text", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "panel",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "kept" }] },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toBe("kept");
  });

  it("fences a code block and preserves its newlines", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "codeBlock",
          attrs: { language: "ts" },
          content: [{ type: "text", text: "const a = 1;\nconst b = 2;" }],
        },
      ],
    };
    expect(adfToText(doc)).toBe("```ts\nconst a = 1;\nconst b = 2;\n```");
  });

  it("renders a blockquote's paragraphs", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "blockquote",
          content: [
            { type: "paragraph", content: [{ type: "text", text: "quoted one" }] },
            { type: "paragraph", content: [{ type: "text", text: "quoted two" }] },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toBe("quoted one\nquoted two");
  });

  it("drops a horizontal rule between blocks", () => {
    const doc = {
      type: "doc",
      content: [
        { type: "paragraph", content: [{ type: "text", text: "before" }] },
        { type: "rule" },
        { type: "paragraph", content: [{ type: "text", text: "after" }] },
      ],
    };
    expect(adfToText(doc)).toBe("before\n\nafter");
  });

  it("renders a list item with multiple paragraphs and a nested list", () => {
    const doc = {
      type: "doc",
      content: [
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "outer" }] },
                { type: "paragraph", content: [{ type: "text", text: "more" }] },
                {
                  type: "bulletList",
                  content: [
                    {
                      type: "listItem",
                      content: [
                        { type: "paragraph", content: [{ type: "text", text: "inner" }] },
                      ],
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toBe("- outer\n  more\n  - inner");
  });

  it("renders a table as pipe-joined rows", () => {
    const cell = (text: string) => ({
      type: "tableCell",
      content: [{ type: "paragraph", content: [{ type: "text", text }] }],
    });
    const doc = {
      type: "doc",
      content: [
        {
          type: "table",
          content: [
            { type: "tableRow", content: [cell("A"), cell("B")] },
            { type: "tableRow", content: [cell("1"), cell("2")] },
          ],
        },
      ],
    };
    expect(adfToText(doc)).toBe("A | B\n1 | 2");
  });

  it("degrades gracefully on a pathologically deep document", () => {
    // Nest blockquotes far past MAX_DEPTH; the converter must drop the deep
    // sub-tree rather than overflow the stack.
    let node: AdfTestNode = {
      type: "paragraph",
      content: [{ type: "text", text: "deep" }],
    };
    for (let i = 0; i < 500; i += 1) {
      node = { type: "blockquote", content: [node] };
    }
    const doc = { type: "doc", content: [node] };
    expect(() => adfToText(doc)).not.toThrow();
  });

  it("degrades gracefully on a pathologically deep inline tree", () => {
    // The inline path recurses too: an unknown inline node feeds its children back
    // through renderInline, so a hand-crafted deep chain must drop past MAX_DEPTH
    // rather than overflow the stack.
    let inline: AdfTestNode = { type: "text", text: "x" };
    for (let i = 0; i < 500; i += 1) {
      inline = { type: "unknownInline", content: [inline] };
    }
    const doc = {
      type: "doc",
      content: [{ type: "paragraph", content: [inline] }],
    };
    expect(() => adfToText(doc)).not.toThrow();
  });
});

type AdfTestNode = {
  type: string;
  text?: string;
  content?: AdfTestNode[];
};

describe("buildAuthHeader", () => {
  it("builds Basic auth for Cloud from email:token", () => {
    const header = buildAuthHeader({
      baseUrl: "https://acme.atlassian.net",
      deployment: "cloud",
      email: "me@acme.com",
      token: "tok",
    });
    const expected = `Basic ${Buffer.from("me@acme.com:tok", "utf8").toString("base64")}`;
    expect(header).toBe(expected);
  });

  it("builds Bearer auth for Server", () => {
    expect(
      buildAuthHeader({
        baseUrl: "https://jira.acme.com",
        deployment: "server",
        token: "pat",
      })
    ).toBe("Bearer pat");
  });
});

describe("normalizeIssue", () => {
  const cloudRaw = {
    key: "ABC-1",
    fields: {
      summary: "Do the thing",
      description: {
        type: "doc",
        content: [
          { type: "paragraph", content: [{ type: "text", text: "Details here." }] },
        ],
      },
      status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
      issuetype: { name: "Story" },
      priority: { name: "High" },
      assignee: { displayName: "Alice" },
      reporter: { displayName: "Bob" },
      labels: ["backend", "urgent"],
      components: [{ name: "api" }, { name: "auth" }],
      fixVersions: [{ name: "1.2.0" }],
      created: "2026-01-01T00:00:00.000Z",
      updated: "2026-01-02T00:00:00.000Z",
      parent: { key: "ABC-0", fields: { summary: "Epic" } },
      subtasks: [
        { key: "ABC-2", fields: { summary: "sub", status: { name: "To Do" } } },
      ],
      issuelinks: [
        {
          type: { outward: "blocks", inward: "is blocked by" },
          outwardIssue: { key: "ABC-9", fields: { summary: "other" } },
        },
      ],
      comment: {
        comments: [
          {
            author: { displayName: "Carol" },
            created: "2026-01-03T00:00:00.000Z",
            updated: "2026-01-03T01:00:00.000Z",
            body: {
              type: "doc",
              content: [
                { type: "paragraph", content: [{ type: "text", text: "Looks good." }] },
              ],
            },
          },
        ],
      },
    },
  };

  it("maps a Cloud payload (ADF bodies) to the normalized shape", () => {
    const issue = normalizeIssue(cloudRaw, "cloud", "https://acme.atlassian.net/");
    expect(issue.key).toBe("ABC-1");
    expect(issue.url).toBe("https://acme.atlassian.net/browse/ABC-1");
    expect(issue.summary).toBe("Do the thing");
    expect(issue.description).toBe("Details here.");
    expect(issue.status).toBe("In Progress");
    expect(issue.statusCategory).toBe("indeterminate");
    expect(issue.type).toBe("Story");
    expect(issue.priority).toBe("High");
    expect(issue.assignee).toBe("Alice");
    expect(issue.reporter).toBe("Bob");
    expect(issue.labels).toEqual(["backend", "urgent"]);
    expect(issue.components).toEqual(["api", "auth"]);
    expect(issue.fixVersions).toEqual(["1.2.0"]);
    expect(issue.parent).toEqual({ key: "ABC-0", summary: "Epic" });
    expect(issue.subtasks).toEqual([
      { key: "ABC-2", summary: "sub", status: "To Do" },
    ]);
    expect(issue.links).toEqual([
      { relationship: "blocks", issue: { key: "ABC-9", summary: "other" } },
    ]);
    expect(issue.comments).toEqual([
      {
        author: "Carol",
        created: "2026-01-03T00:00:00.000Z",
        updated: "2026-01-03T01:00:00.000Z",
        body: "Looks good.",
      },
    ]);
  });

  it("maps a Server payload (string body) and an inward link", () => {
    const serverRaw = {
      key: "SRV-7",
      fields: {
        summary: "Server story",
        description: "Plain text body.",
        status: { name: "Open", statusCategory: { key: "new" } },
        issuetype: { name: "Bug" },
        issuelinks: [
          {
            type: { outward: "blocks", inward: "is blocked by" },
            inwardIssue: { key: "SRV-1", fields: { summary: "blocker" } },
          },
        ],
      },
    };
    const issue = normalizeIssue(serverRaw, "server", "https://jira.acme.com");
    expect(issue.description).toBe("Plain text body.");
    expect(issue.statusCategory).toBe("new");
    expect(issue.parent).toBeUndefined();
    expect(issue.links).toEqual([
      { relationship: "is blocked by", issue: { key: "SRV-1", summary: "blocker" } },
    ]);
    expect(issue.comments).toEqual([]);
  });

  it("caps comments to the most-recent N", () => {
    const raw = {
      key: "ABC-1",
      fields: {
        comment: {
          comments: [
            { author: { displayName: "A" }, created: "1", body: "1" },
            { author: { displayName: "B" }, created: "2", body: "2" },
            { author: { displayName: "C" }, created: "3", body: "3" },
          ],
        },
      },
    };
    const issue = normalizeIssue(raw, "server", "https://jira.acme.com", 2);
    expect(issue.comments.map((c) => c.body)).toEqual(["2", "3"]);
  });

  it("tolerates an empty/garbage payload", () => {
    const issue = normalizeIssue(null, "cloud", "https://acme.atlassian.net");
    expect(issue.key).toBe("");
    expect(issue.labels).toEqual([]);
    expect(issue.subtasks).toEqual([]);
    expect(issue.comments).toEqual([]);
  });

  it("falls back to name then emailAddress for user display", () => {
    const raw = {
      key: "ABC-1",
      fields: {
        assignee: { name: "jsmith" },
        reporter: { emailAddress: "r@acme.com" },
      },
    };
    const issue = normalizeIssue(raw, "server", "https://jira.acme.com");
    expect(issue.assignee).toBe("jsmith");
    expect(issue.reporter).toBe("r@acme.com");
  });

  it("coerces numeric/boolean scalars to strings", () => {
    const raw = { key: 123, fields: { summary: true } };
    const issue = normalizeIssue(raw, "server", "https://jira.acme.com");
    expect(issue.key).toBe("123");
    expect(issue.summary).toBe("true");
  });
});

describe("client getIssue / verifyAuth (stubbed fetch)", () => {
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

  function stubFetch(status: number, payload: unknown, statusText = ""): jest.Mock {
    const mock = jest.fn().mockResolvedValue({
      status,
      statusText,
      text: async () => (payload == null ? "" : JSON.stringify(payload)),
    });
    global.fetch = mock as unknown as typeof fetch;
    return mock;
  }

  it("fetches and normalizes an issue, hitting the v3 endpoint", async () => {
    const mock = stubFetch(200, {
      key: "ABC-1",
      fields: { summary: "S", status: { name: "Open" } },
    });
    const issue = await getIssue(config, "abc-1");
    expect(issue.key).toBe("ABC-1");
    expect(issue.summary).toBe("S");
    const calledUrl = mock.mock.calls[0][0] as string;
    expect(calledUrl).toContain("/rest/api/3/issue/ABC-1");
    const init = mock.mock.calls[0][1] as { headers: Record<string, string> };
    expect(init.headers.Authorization).toMatch(/^Basic /);
  });

  /** Headers stub whose `Retry-After` answers with the given value. */
  function retryAfterHeaders(value: string | null): { get: (name: string) => string | null } {
    return { get: (name) => (name.toLowerCase() === "retry-after" ? value : null) };
  }

  it("retries once on HTTP 429, honoring Retry-After, then returns the issue", async () => {
    const mock = jest
      .fn()
      .mockResolvedValueOnce({
        status: 429,
        headers: retryAfterHeaders("0"),
        text: async () => "",
      })
      .mockResolvedValueOnce({
        status: 200,
        text: async () =>
          JSON.stringify({ key: "ABC-1", fields: { summary: "S" } }),
      });
    global.fetch = mock as unknown as typeof fetch;
    const issue = await getIssue(config, "ABC-1");
    expect(issue.key).toBe("ABC-1");
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("gives up after a single 429 retry", async () => {
    const mock = jest.fn().mockResolvedValue({
      status: 429,
      headers: retryAfterHeaders("0"),
      text: async () => "",
    });
    global.fetch = mock as unknown as typeof fetch;
    await expect(getIssue(config, "ABC-1")).rejects.toThrow(/HTTP 429/);
    expect(mock).toHaveBeenCalledTimes(2);
  });

  it("waits the default backoff before retrying a 429 with no Retry-After", async () => {
    // Proxies routinely strip Retry-After. Retrying a throttled endpoint after
    // 0ms would almost certainly 429 again — pin that the client waits the
    // 1s default instead of re-requesting immediately.
    jest.useFakeTimers();
    try {
      const mock = jest
        .fn()
        .mockResolvedValueOnce({ status: 429, text: async () => "" })
        .mockResolvedValueOnce({
          status: 200,
          text: async () =>
            JSON.stringify({ key: "ABC-1", fields: { summary: "S" } }),
        });
      global.fetch = mock as unknown as typeof fetch;
      const pending = getIssue(config, "ABC-1");
      await jest.advanceTimersByTimeAsync(999);
      expect(mock).toHaveBeenCalledTimes(1); // still sleeping
      await jest.advanceTimersByTimeAsync(1);
      const issue = await pending;
      expect(issue.key).toBe("ABC-1");
      expect(mock).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it("rejects a 2xx response that carries no issue key", async () => {
    // A 200 SSO/login page or proxy splash must fail loudly, not yield a blank issue.
    stubFetch(200, { not: "an issue" });
    await expect(getIssue(config, "ABC-1")).rejects.toThrow(/unexpected response/i);
  });

  it("maps 401 to an unauthorized JiraHttpError (bad credentials)", async () => {
    stubFetch(401, { message: "no" }, "Unauthorized");
    // #69: 401 is "unauthorized" (bad/absent creds) and advises re-login.
    // #71: it is a typed JiraHttpError carrying status/kind/url/body.
    const err = await getIssue(config, "ABC-1").catch((e) => e);
    expect(isJiraHttpError(err)).toBe(true);
    expect(err).toBeInstanceOf(JiraHttpError);
    expect(err.status).toBe(401);
    expect(err.kind).toBe("unauthorized");
    expect(err.statusText).toBe("Unauthorized");
    expect(err.url).toContain("/rest/api/3/issue/ABC-1");
    expect(err.body).toContain("no");
    expect(err.message).toMatch(/authentication failed/i);
    expect(err.message).toMatch(/jira-login/);
  });

  it("distinguishes 403 (forbidden) from 401 (unauthorized)", async () => {
    // #69: 403 means authenticated-but-not-permitted; re-login does not help.
    stubFetch(403, { message: "nope" }, "Forbidden");
    const err = await getIssue(config, "ABC-1").catch((e) => e);
    expect(err).toBeInstanceOf(JiraHttpError);
    expect(err.status).toBe(403);
    expect(err.kind).toBe("forbidden");
    expect(err.message).toMatch(/forbidden/i);
    expect(err.message).toMatch(/permission|scope/i);
    // Must NOT tell a permitted-but-forbidden user their credentials are wrong.
    expect(err.message).not.toMatch(/authentication failed/i);
  });

  it("maps 404 to a not-found JiraHttpError", async () => {
    const err = await (async () => {
      stubFetch(404, null);
      return getIssue(config, "ABC-1").catch((e) => e);
    })();
    expect(err).toBeInstanceOf(JiraHttpError);
    expect(err.kind).toBe("not-found");
    expect(err.message).toMatch(/not found/i);
  });

  it("rejects an empty key", async () => {
    await expect(getIssue(config, "   ")).rejects.toThrow(/issue key is required/i);
  });

  it("verifyAuth returns the display name from /myself", async () => {
    stubFetch(200, { displayName: "Alice Example" });
    await expect(verifyAuth(config)).resolves.toBe("Alice Example");
  });

  it("verifyAuth throws on a forbidden /myself", async () => {
    // 403 is "forbidden" (authenticated but not permitted), distinct from 401.
    stubFetch(403, null);
    await expect(verifyAuth(config)).rejects.toThrow(/access forbidden/i);
  });

  it("verifyAuth rejects a 200 that carries no user identity", async () => {
    // A 200 SSO/login splash or proxy page (no displayName/name/email/accountId)
    // must NOT be accepted as a successful login — that would persist invalid creds.
    stubFetch(200, { not: "an identity" });
    await expect(verifyAuth(config)).rejects.toThrow(/unexpected response/i);
  });

  it("verifyAuth accepts an identity carried only by accountId", async () => {
    stubFetch(200, { accountId: "557058:abc" });
    await expect(verifyAuth(config)).resolves.toBe("authenticated user");
  });

  it("verifyAuth fails early on Jira Cloud with no email", async () => {
    // #35: the login connection test must surface the missing-email problem too,
    // rather than making a request that is guaranteed to 401.
    const mock = stubFetch(200, { displayName: "X" });
    const cloudNoEmail: JiraConfig = {
      baseUrl: "https://acme.atlassian.net",
      deployment: "cloud",
      token: "tok",
    };
    await expect(verifyAuth(cloudNoEmail)).rejects.toThrow(
      CLOUD_MISSING_EMAIL_MESSAGE
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it("maps a 500 with a non-JSON body to a generic request error", async () => {
    global.fetch = jest.fn().mockResolvedValue({
      status: 500,
      text: async () => "<html>Server Error</html>",
    }) as unknown as typeof fetch;
    await expect(getIssue(config, "ABC-1")).rejects.toThrow(/HTTP 500/);
  });

  it("maps an aborted (timed-out) request to a timeout error", async () => {
    const abort = new Error("aborted");
    abort.name = "AbortError";
    global.fetch = jest.fn().mockRejectedValue(abort) as unknown as typeof fetch;
    await expect(getIssue(config, "ABC-1", { timeoutMs: 5 })).rejects.toThrow(
      /timed out/i
    );
  });

  it("wraps a non-abort fetch failure with context", async () => {
    global.fetch = jest
      .fn()
      .mockRejectedValue(new Error("ECONNREFUSED")) as unknown as typeof fetch;
    await expect(getIssue(config, "ABC-1")).rejects.toThrow(
      /Jira request failed: ECONNREFUSED/
    );
  });

  it("fails early on Jira Cloud with no email, before making a request", async () => {
    // #35: Cloud Basic auth is email:token; with no email the header is
    // base64(":token"), a guaranteed 401. Fail with an actionable message that
    // names JIRA_EMAIL instead of a raw 401 misread as bad credentials — and do
    // not even hit the network.
    const mock = stubFetch(200, { key: "ABC-1", fields: {} });
    const cloudNoEmail: JiraConfig = {
      baseUrl: "https://acme.atlassian.net",
      deployment: "cloud",
      token: "tok",
    };
    await expect(getIssue(cloudNoEmail, "ABC-1")).rejects.toThrow(
      CLOUD_MISSING_EMAIL_MESSAGE
    );
    expect(mock).not.toHaveBeenCalled();
  });

  it("does not require an email on Server/Data Center", async () => {
    // Server/DC uses a Bearer token — no email needed, so the guard must not fire.
    const serverConfig: JiraConfig = {
      baseUrl: "https://jira.acme.com",
      deployment: "server",
      token: "pat",
    };
    stubFetch(200, { key: "SRV-1", fields: { summary: "S" } });
    const issue = await getIssue(serverConfig, "SRV-1");
    expect(issue.key).toBe("SRV-1");
  });

  it("pages the comment endpoint for the newest comments when embedded page is truncated", async () => {
    // #34: the issue payload embeds only the first (oldest) page. When total >
    // shown, fetch /issue/{key}/comment?orderBy=-created and use the newest N,
    // preserved in chronological order for the reader.
    const issuePayload = {
      key: "ABC-1",
      fields: {
        summary: "S",
        comment: {
          startAt: 0,
          maxResults: 2,
          total: 5,
          comments: [
            { author: { displayName: "Old" }, created: "1", body: "oldest" },
            { author: { displayName: "Old2" }, created: "2", body: "second" },
          ],
        },
      },
    };
    // Endpoint returns newest-first; the client reverses to chronological order.
    const commentPayload = {
      startAt: 0,
      maxResults: 3,
      total: 5,
      comments: [
        { author: { displayName: "Newest" }, created: "5", body: "newest" },
        { author: { displayName: "Fourth" }, created: "4", body: "fourth" },
        { author: { displayName: "Third" }, created: "3", body: "third" },
      ],
    };
    const mock = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(issuePayload),
      })
      .mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(commentPayload),
      });
    global.fetch = mock as unknown as typeof fetch;

    const issue = await getIssue(config, "ABC-1", { comments: 3 });
    // Two requests: the issue, then the dedicated comment page.
    expect(mock).toHaveBeenCalledTimes(2);
    const commentUrl = mock.mock.calls[1][0] as string;
    expect(commentUrl).toContain("/rest/api/3/issue/ABC-1/comment");
    expect(commentUrl).toContain("orderBy=-created");
    expect(commentUrl).toContain("maxResults=3");
    // The three NEWEST comments, in chronological order — not the oldest page.
    expect(issue.comments.map((c) => c.body)).toEqual(["third", "fourth", "newest"]);
  });

  it("does not make a second request when the embedded comment page is complete", async () => {
    // total == shown → nothing truncated → no extra fetch.
    const mock = stubFetch(200, {
      key: "ABC-1",
      fields: {
        summary: "S",
        comment: {
          total: 1,
          comments: [{ author: { displayName: "A" }, created: "1", body: "only" }],
        },
      },
    });
    const issue = await getIssue(config, "ABC-1", { comments: 5 });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(issue.comments.map((c) => c.body)).toEqual(["only"]);
  });

  it("falls back to the embedded page when the comment endpoint fails", async () => {
    // A comments-only failure must not fail the whole issue fetch.
    const issuePayload = {
      key: "ABC-1",
      fields: {
        summary: "S",
        comment: {
          total: 3,
          comments: [{ author: { displayName: "A" }, created: "1", body: "embedded" }],
        },
      },
    };
    const mock = jest
      .fn()
      .mockResolvedValueOnce({
        status: 200,
        statusText: "OK",
        text: async () => JSON.stringify(issuePayload),
      })
      .mockResolvedValueOnce({
        status: 500,
        statusText: "Server Error",
        text: async () => "<html>boom</html>",
      });
    global.fetch = mock as unknown as typeof fetch;
    const issue = await getIssue(config, "ABC-1", { comments: 5 });
    expect(mock).toHaveBeenCalledTimes(2);
    expect(issue.comments.map((c) => c.body)).toEqual(["embedded"]);
  });

  it("skips comment paging when the caller asks for zero comments", async () => {
    const mock = stubFetch(200, {
      key: "ABC-1",
      fields: {
        summary: "S",
        comment: { total: 9, comments: [{ created: "1", body: "x" }] },
      },
    });
    const issue = await getIssue(config, "ABC-1", { comments: 0 });
    expect(mock).toHaveBeenCalledTimes(1);
    expect(issue.comments).toEqual([]);
  });
});

describe("JiraHttpError (typed HTTP failure)", () => {
  it("carries status, statusText, url, kind and a body snippet", () => {
    // #71: the structured contract callers branch on instead of regex-matching
    // the message string.
    const err = jiraHttpError({
      status: 403,
      statusText: "Forbidden",
      url: "https://acme.atlassian.net/rest/api/3/issue/ABC-1",
      body: { errorMessages: ["You do not have permission"] },
      context: "ABC-1",
    });
    expect(err).toBeInstanceOf(JiraHttpError);
    expect(err).toBeInstanceOf(Error);
    expect(isJiraHttpError(err)).toBe(true);
    expect(err.status).toBe(403);
    expect(err.statusText).toBe("Forbidden");
    expect(err.kind).toBe("forbidden");
    expect(err.url).toContain("/issue/ABC-1");
    expect(err.body).toContain("You do not have permission");
    expect(err.name).toBe("JiraHttpError");
  });

  it("classifies each status into the right kind", () => {
    const kind = (status: number) =>
      jiraHttpError({ status, url: "u", context: "c" }).kind;
    expect(kind(401)).toBe("unauthorized");
    expect(kind(403)).toBe("forbidden");
    expect(kind(404)).toBe("not-found");
    expect(kind(429)).toBe("rate-limited");
    expect(kind(500)).toBe("server");
    expect(kind(503)).toBe("server");
    expect(kind(418)).toBe("unknown");
  });

  it("collapses and truncates a long body snippet", () => {
    const err = jiraHttpError({
      status: 500,
      url: "u",
      body: "line one\n   line two\t\tmore   " + "x".repeat(1000),
      context: "c",
    });
    expect(err.body).not.toContain("\n");
    expect(err.body).toMatch(/…$/);
    expect((err.body || "").length).toBeLessThanOrEqual(501);
  });

  it("omits the body field when there is no body", () => {
    const err = jiraHttpError({ status: 404, url: "u", context: "c" });
    expect(err.body).toBeUndefined();
  });

  it("isJiraHttpError rejects plain errors and non-errors", () => {
    expect(isJiraHttpError(new Error("plain"))).toBe(false);
    expect(isJiraHttpError(null)).toBe(false);
    expect(isJiraHttpError("boom")).toBe(false);
  });
});

describe("resolveJiraConfig (env precedence)", () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL };
    jest.resetModules();
  });

  it("builds a config from environment variables", async () => {
    process.env.JIRA_BASE_URL = "https://acme.atlassian.net/";
    process.env.JIRA_EMAIL = "me@acme.com";
    process.env.JIRA_TOKEN = "tok";
    delete process.env.JIRA_DEPLOYMENT;
    const { resolveJiraConfig } = await import("../src/index");
    const config = await resolveJiraConfig({});
    expect(config).toEqual({
      baseUrl: "https://acme.atlassian.net",
      deployment: "cloud",
      email: "me@acme.com",
      token: "tok",
    });
  });

  it("returns null when nothing is configured and no store match", async () => {
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_TOKEN;
    jest.resetModules();
    jest.doMock("@syncro-now-ai/credential-store", () => ({
      loadJiraCredentials: jest.fn().mockResolvedValue(null),
      loadJiraCredentialsSync: jest.fn().mockReturnValue(null),
    }));
    const { resolveJiraConfig } = await import("../src/resolveConfig");
    const config = await resolveJiraConfig({ profile: "nope" });
    expect(config).toBeNull();
    jest.dontMock("@syncro-now-ai/credential-store");
  });

  it("prefers an explicit profile's stored credentials over the environment", async () => {
    // An explicitly named --profile is a deliberate choice and must win over
    // ambient JIRA_* env, which only serves the no-profile (CI/one-off) path.
    process.env.JIRA_BASE_URL = "https://env.atlassian.net";
    process.env.JIRA_EMAIL = "env@acme.com";
    process.env.JIRA_TOKEN = "env-tok";
    jest.resetModules();
    jest.doMock("@syncro-now-ai/credential-store", () => ({
      loadJiraCredentials: jest.fn().mockResolvedValue({
        profile: "work",
        baseUrl: "https://stored.atlassian.net",
        deployment: "cloud",
        email: "stored@acme.com",
        token: "stored-tok",
      }),
      loadJiraCredentialsSync: jest.fn(),
    }));
    const { resolveJiraConfig } = await import("../src/resolveConfig");
    expect(await resolveJiraConfig({ profile: "work" })).toEqual({
      baseUrl: "https://stored.atlassian.net",
      deployment: "cloud",
      email: "stored@acme.com",
      token: "stored-tok",
    });
    jest.dontMock("@syncro-now-ai/credential-store");
  });

  it("falls back to the environment when the explicit profile has no stored creds", async () => {
    process.env.JIRA_BASE_URL = "https://env.atlassian.net";
    process.env.JIRA_EMAIL = "env@acme.com";
    process.env.JIRA_TOKEN = "env-tok";
    delete process.env.JIRA_DEPLOYMENT;
    jest.resetModules();
    jest.doMock("@syncro-now-ai/credential-store", () => ({
      loadJiraCredentials: jest.fn().mockResolvedValue(null),
      loadJiraCredentialsSync: jest.fn(),
    }));
    const { resolveJiraConfig } = await import("../src/resolveConfig");
    expect(await resolveJiraConfig({ profile: "work" })).toEqual({
      baseUrl: "https://env.atlassian.net",
      deployment: "cloud",
      email: "env@acme.com",
      token: "env-tok",
    });
    jest.dontMock("@syncro-now-ai/credential-store");
  });

  it('falls back to the stored "default" profile when no profile and no env are set', async () => {
    // The primary post-`jira-login` path: no --profile flag, no JIRA_* env.
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_TOKEN;
    jest.resetModules();
    const loadJiraCredentials = jest
      .fn()
      .mockImplementation(async (profile: string) =>
        profile === "default"
          ? {
              profile: "default",
              baseUrl: "https://stored.atlassian.net/",
              deployment: "cloud",
              email: "stored@acme.com",
              token: "stored-tok",
            }
          : null
      );
    jest.doMock("@syncro-now-ai/credential-store", () => ({
      loadJiraCredentials,
      loadJiraCredentialsSync: jest.fn(),
    }));
    const { resolveJiraConfig } = await import("../src/resolveConfig");
    expect(await resolveJiraConfig({})).toEqual({
      baseUrl: "https://stored.atlassian.net",
      deployment: "cloud",
      email: "stored@acme.com",
      token: "stored-tok",
    });
    expect(loadJiraCredentials).toHaveBeenCalledWith("default");
    jest.dontMock("@syncro-now-ai/credential-store");
  });
});

describe("resolveJiraConfigSync (MCP runtime path)", () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL };
    jest.resetModules();
    jest.dontMock("@syncro-now-ai/credential-store");
  });

  it("builds a config from environment variables", async () => {
    process.env.JIRA_BASE_URL = "https://acme.atlassian.net/";
    process.env.JIRA_EMAIL = "me@acme.com";
    process.env.JIRA_TOKEN = "tok";
    delete process.env.JIRA_DEPLOYMENT;
    const { resolveJiraConfigSync } = await import("../src/index");
    expect(resolveJiraConfigSync({})).toEqual({
      baseUrl: "https://acme.atlassian.net",
      deployment: "cloud",
      email: "me@acme.com",
      token: "tok",
    });
  });

  it("honors an explicit JIRA_DEPLOYMENT override over host detection", async () => {
    process.env.JIRA_BASE_URL = "https://acme.atlassian.net";
    process.env.JIRA_TOKEN = "tok";
    process.env.JIRA_DEPLOYMENT = "server";
    delete process.env.JIRA_EMAIL;
    const { resolveJiraConfigSync } = await import("../src/index");
    expect(resolveJiraConfigSync({})?.deployment).toBe("server");
  });

  it("falls back to the credential store when env is unset", async () => {
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_TOKEN;
    delete process.env.JIRA_DEPLOYMENT;
    jest.resetModules();
    jest.doMock("@syncro-now-ai/credential-store", () => ({
      loadJiraCredentials: jest.fn(),
      loadJiraCredentialsSync: jest.fn().mockReturnValue({
        profile: "work",
        baseUrl: "https://jira.acme.com/",
        deployment: "server",
        token: "pat",
      }),
    }));
    const { resolveJiraConfigSync } = await import("../src/resolveConfig");
    expect(resolveJiraConfigSync({ profile: "work" })).toEqual({
      baseUrl: "https://jira.acme.com",
      deployment: "server",
      token: "pat",
    });
  });

  it("returns null when neither env nor the store is configured", async () => {
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_TOKEN;
    jest.resetModules();
    jest.doMock("@syncro-now-ai/credential-store", () => ({
      loadJiraCredentials: jest.fn(),
      loadJiraCredentialsSync: jest.fn().mockReturnValue(null),
    }));
    const { resolveJiraConfigSync } = await import("../src/resolveConfig");
    expect(resolveJiraConfigSync({ profile: "nope" })).toBeNull();
  });

  it('falls back to the stored "default" profile when no profile and no env are set', async () => {
    // Mirrors the async variant: the MCP runtime must find a plain `jira-login`
    // (no --profile) without any JIRA_* env being exported.
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_TOKEN;
    jest.resetModules();
    const loadJiraCredentialsSync = jest
      .fn()
      .mockImplementation((profile: string) =>
        profile === "default"
          ? {
              profile: "default",
              baseUrl: "https://jira.acme.com/",
              deployment: "server",
              token: "pat",
            }
          : null
      );
    jest.doMock("@syncro-now-ai/credential-store", () => ({
      loadJiraCredentials: jest.fn(),
      loadJiraCredentialsSync,
    }));
    const { resolveJiraConfigSync } = await import("../src/resolveConfig");
    expect(resolveJiraConfigSync({})).toEqual({
      baseUrl: "https://jira.acme.com",
      deployment: "server",
      token: "pat",
    });
    expect(loadJiraCredentialsSync).toHaveBeenCalledWith("default");
  });

  it("treats a stored record with a missing token as unusable", async () => {
    // A partially-written store record (baseUrl but no token) must resolve to
    // null — not to a config that fails downstream with a confusing auth error.
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_TOKEN;
    jest.resetModules();
    jest.doMock("@syncro-now-ai/credential-store", () => ({
      loadJiraCredentials: jest.fn(),
      loadJiraCredentialsSync: jest.fn().mockReturnValue({
        profile: "work",
        baseUrl: "https://jira.acme.com",
        deployment: "server",
        token: "",
      }),
    }));
    const { resolveJiraConfigSync } = await import("../src/resolveConfig");
    expect(resolveJiraConfigSync({ profile: "work" })).toBeNull();
  });
});

describe("jiraUndecryptableMessage", () => {
  it("names the profile and the exact re-login command", () => {
    // The CLI and MCP tests assert this contract only through mocks; this pins
    // the real string so the guidance cannot silently drift or lose the profile.
    const msg = jiraUndecryptableMessage("work");
    expect(msg).toMatch(/could not be decrypted/);
    expect(msg).toContain('profile "work"');
    expect(msg).toContain("syncro-now-ai jira-login --profile work");
  });
});
