// SPDX-License-Identifier: GPL-3.0-or-later
describe("resolved Jira token whitespace", () => {
  const ORIGINAL = { ...process.env };

  afterEach(() => {
    process.env = { ...ORIGINAL };
    jest.resetModules();
    jest.dontMock("@syncrona/credential-store");
  });

  function mockStore(token: string | null): void {
    const stored = token === null ? null : { baseUrl: "https://acme.atlassian.net", email: "me@acme.com", token };
    jest.doMock("@syncrona/credential-store", () => ({
      loadJiraCredentials: jest.fn().mockResolvedValue(stored),
      loadJiraCredentialsSync: jest.fn().mockReturnValue(stored),
    }));
  }

  it("trims a trailing CRLF from JIRA_TOKEN (async and sync paths)", async () => {
    process.env.JIRA_BASE_URL = "https://acme.atlassian.net";
    process.env.JIRA_EMAIL = "me@acme.com";
    process.env.JIRA_TOKEN = "tok\r\n";
    mockStore(null);
    const { resolveJiraConfig, resolveJiraConfigSync } = await import("../src/resolveConfig");
    expect((await resolveJiraConfig({}))?.token).toBe("tok");
    expect(resolveJiraConfigSync({})?.token).toBe("tok");
  });

  it("trims whitespace around a stored token", async () => {
    delete process.env.JIRA_BASE_URL;
    delete process.env.JIRA_TOKEN;
    mockStore("  tok\n");
    const { resolveJiraConfig, resolveJiraConfigSync } = await import("../src/resolveConfig");
    expect((await resolveJiraConfig({}))?.token).toBe("tok");
    expect(resolveJiraConfigSync({ profile: "work" })?.token).toBe("tok");
  });

  it("treats a whitespace-only token as not configured", async () => {
    process.env.JIRA_BASE_URL = "https://acme.atlassian.net";
    process.env.JIRA_TOKEN = " \n";
    mockStore(null);
    const { resolveJiraConfigSync } = await import("../src/resolveConfig");
    expect(resolveJiraConfigSync({})).toBeNull();
  });
});
