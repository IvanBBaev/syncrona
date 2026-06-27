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
});

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

  function stubFetch(status: number, payload: unknown): jest.Mock {
    const mock = jest.fn().mockResolvedValue({
      status,
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

  it("maps 401 to an auth error", async () => {
    stubFetch(401, { message: "no" });
    await expect(getIssue(config, "ABC-1")).rejects.toThrow(/authentication failed/i);
  });

  it("maps 404 to a not-found error", async () => {
    stubFetch(404, null);
    await expect(getIssue(config, "ABC-1")).rejects.toThrow(/not found/i);
  });

  it("rejects an empty key", async () => {
    await expect(getIssue(config, "   ")).rejects.toThrow(/issue key is required/i);
  });

  it("verifyAuth returns the display name from /myself", async () => {
    stubFetch(200, { displayName: "Alice Example" });
    await expect(verifyAuth(config)).resolves.toBe("Alice Example");
  });

  it("verifyAuth throws on a failed /myself", async () => {
    stubFetch(403, null);
    await expect(verifyAuth(config)).rejects.toThrow(/authentication failed/i);
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
});
