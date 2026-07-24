// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
// The real error taxonomy, imported from the package's own module rather than
// re-implemented: `isJiraHttpError` is an instanceof check, so a hand-rolled
// stub here would let a broken `kind` branch pass. This deep specifier is not
// the one mocked below, so it stays the genuine implementation.
import { jiraHttpError, isJiraHttpError } from "@syncrona/jira/dist/errors.js";
export {};

const mockDetectDeployment = jest.fn();
const mockExtractIssueKey = jest.fn();
const mockGetIssue = jest.fn();
const mockResolveJiraConfig = jest.fn();
const mockVerifyAuth = jest.fn();
const mockSaveJiraCredentials = jest.fn();
const mockRemoveJiraCredentials = jest.fn();
const mockRemoveAllJiraCredentials = jest.fn();
const mockJiraCredentialHealth = jest.fn();
const mockGetCurrentBranch = jest.fn();
const mockPrompt = jest.fn();
const mockLoggerInfo = jest.fn();
const mockLoggerSuccess = jest.fn();
const mockLoggerError = jest.fn();
const mockLoggerWarn = jest.fn();

jest.unstable_mockModule("@syncrona/jira", () => ({
  detectDeployment: (...args: unknown[]) => mockDetectDeployment(...args),
  extractIssueKey: (...args: unknown[]) => mockExtractIssueKey(...args),
  getIssue: (...args: unknown[]) => mockGetIssue(...args),
  resolveJiraConfig: (...args: unknown[]) => mockResolveJiraConfig(...args),
  verifyAuth: (...args: unknown[]) => mockVerifyAuth(...args),
  isJiraHttpError,
  NO_JIRA_CONFIG_MESSAGE:
    "No Jira credentials configured. Run `syncrona jira-login`, or set JIRA_BASE_URL and JIRA_TOKEN.",
  jiraUndecryptableMessage: (profile: string) =>
    `Stored Jira credentials for profile "${profile}" could not be decrypted — re-run jira-login.`,
}));

jest.unstable_mockModule("@syncrona/credential-store", () => ({
  saveJiraCredentials: (...args: unknown[]) => mockSaveJiraCredentials(...args),
  removeJiraCredentials: (...args: unknown[]) => mockRemoveJiraCredentials(...args),
  removeAllJiraCredentials: (...args: unknown[]) => mockRemoveAllJiraCredentials(...args),
  jiraCredentialHealth: (...args: unknown[]) => mockJiraCredentialHealth(...args),
}));

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    setLogLevel: jest.fn(),
    info: (...args: unknown[]) => mockLoggerInfo(...args),
    success: (...args: unknown[]) => mockLoggerSuccess(...args),
    error: (...args: unknown[]) => mockLoggerError(...args),
    warn: (...args: unknown[]) => mockLoggerWarn(...args),
    debug: jest.fn(),
    silly: jest.fn(),
    getInternalLogger: () => ({ error: jest.fn() }),
  },
}));

jest.unstable_mockModule("../gitUtils.js", () => ({
  getCurrentBranch: (...args: unknown[]) => mockGetCurrentBranch(...args),
}));

jest.unstable_mockModule("../commandHelpers.js", () => ({ setLogLevel: jest.fn() }));
jest.unstable_mockModule("inquirer", () => ({
  __esModule: true,
  default: { prompt: (...args: unknown[]) => mockPrompt(...args) },
}));

// The SUT is imported dynamically AFTER the module mocks are registered:
// jest.unstable_mockModule does not hoist, so a static import would bind the
// real dependencies before the mocks take effect.
let jiraCommand: typeof import("../jiraCommands.js").jiraCommand;
let jiraLoginCommand: typeof import("../jiraCommands.js").jiraLoginCommand;
let jiraLogoutCommand: typeof import("../jiraCommands.js").jiraLogoutCommand;

const BASE_ARGS = { logLevel: "info", dryRun: false } as const;

const SAMPLE_ISSUE = {
  key: "ABC-1",
  url: "https://acme.atlassian.net/browse/ABC-1",
  summary: "Do the thing",
  description: "Details here.",
  status: "In Progress",
  statusCategory: "indeterminate",
  type: "Story",
  priority: "High",
  assignee: "Alice",
  reporter: "Bob",
  labels: ["backend"],
  components: ["api"],
  parent: { key: "ABC-0", summary: "Epic" },
  subtasks: [{ key: "ABC-2", summary: "sub", status: "To Do" }],
  links: [{ relationship: "blocks", issue: { key: "ABC-9", summary: "other" } }],
  fixVersions: ["1.2.0"],
  created: "2026-01-01T00:00:00.000Z",
  updated: "2026-01-02T00:00:00.000Z",
  comments: [
    { author: "Carol", created: "2026-01-03T00:00:00.000Z", body: "Looks good." },
  ],
};

let stdoutSpy: jest.SpyInstance;

beforeEach(async () => {
  jest.clearAllMocks();
  ({ jiraCommand, jiraLoginCommand, jiraLogoutCommand } = await import(
    "../jiraCommands.js"
  ));
  process.exitCode = 0;
  mockResolveJiraConfig.mockResolvedValue({
    baseUrl: "https://acme.atlassian.net",
    deployment: "cloud",
    email: "me@acme.com",
    token: "tok",
  });
  mockGetIssue.mockResolvedValue(SAMPLE_ISSUE);
  mockJiraCredentialHealth.mockReturnValue("missing");
  mockSaveJiraCredentials.mockResolvedValue(undefined);
  mockRemoveJiraCredentials.mockResolvedValue(undefined);
  mockRemoveAllJiraCredentials.mockResolvedValue(2);
  stdoutSpy = jest.spyOn(process.stdout, "write").mockImplementation(() => true);
});

afterEach(() => {
  stdoutSpy.mockRestore();
  process.exitCode = 0;
});

describe("jiraCommand", () => {
  it("fetches and pretty-prints an issue from an explicit key", async () => {
    await jiraCommand({ ...BASE_ARGS, key: "abc-1" });

    expect(mockGetIssue).toHaveBeenCalledWith(
      expect.objectContaining({ deployment: "cloud" }),
      "ABC-1",
      { comments: 5 }
    );
    expect(mockLoggerSuccess).toHaveBeenCalledWith("ABC-1  Do the thing");
    expect(mockLoggerInfo).toHaveBeenCalledWith("URL: https://acme.atlassian.net/browse/ABC-1");
    expect(process.exitCode).toBe(0);
  });

  it("renders the rich fields: parent, subtasks, links, description, comments", async () => {
    await jiraCommand({ ...BASE_ARGS, key: "ABC-1" });

    const infos = mockLoggerInfo.mock.calls.map((c) => c[0]);

    // Scalar fields.
    expect(infos).toContain("Type: Story");
    expect(infos).toContain("Status: In Progress (indeterminate)");
    expect(infos).toContain("Priority: High");
    expect(infos).toContain("Assignee: Alice");
    expect(infos).toContain("Reporter: Bob");
    expect(infos).toContain("Labels: backend");
    expect(infos).toContain("Components: api");
    expect(infos).toContain("Fix versions: 1.2.0");
    expect(infos).toContain("Parent: ABC-0 Epic");

    // Section headers and their indented block bodies.
    expect(infos).toContain("Subtasks:");
    expect(infos).toContain("  ABC-2 sub [To Do]");
    expect(infos).toContain("Linked issues:");
    expect(infos).toContain("  blocks: ABC-9 other");
    expect(infos).toContain("Description:");
    expect(infos).toContain("  Details here.");
    expect(infos).toContain("Comments (1):");
    expect(infos).toContain("  Carol — 2026-01-03T00:00:00.000Z");
    expect(infos).toContain("  Looks good.");
  });

  it("omits empty sections and fields", async () => {
    mockGetIssue.mockResolvedValue({
      ...SAMPLE_ISSUE,
      priority: "",
      parent: undefined,
      subtasks: [],
      links: [],
      description: "",
      comments: [],
    });

    await jiraCommand({ ...BASE_ARGS, key: "ABC-1" });

    const infos = mockLoggerInfo.mock.calls.map((c) => c[0]);
    expect(infos).not.toContain("Priority: ");
    expect(infos.some((l: string) => l.startsWith("Priority:"))).toBe(false);
    expect(infos.some((l: string) => l.startsWith("Parent:"))).toBe(false);
    expect(infos).not.toContain("Subtasks:");
    expect(infos).not.toContain("Linked issues:");
    expect(infos).not.toContain("Description:");
    expect(infos.some((l: string) => l.startsWith("Comments"))).toBe(false);
  });

  it("honors a custom --comments value", async () => {
    await jiraCommand({ ...BASE_ARGS, key: "ABC-1", comments: 2 });
    expect(mockGetIssue).toHaveBeenCalledWith(expect.anything(), "ABC-1", { comments: 2 });
  });

  it("emits raw JSON with --json instead of pretty output", async () => {
    await jiraCommand({ ...BASE_ARGS, key: "ABC-1", json: true });
    expect(stdoutSpy).toHaveBeenCalledWith(`${JSON.stringify(SAMPLE_ISSUE, null, 2)}\n`);
    expect(mockLoggerSuccess).not.toHaveBeenCalled();
  });

  it("falls back to the git branch when no key is given", async () => {
    mockGetCurrentBranch.mockResolvedValue("feature/ABC-7-thing");
    mockExtractIssueKey.mockReturnValue("ABC-7");

    await jiraCommand({ ...BASE_ARGS });

    expect(mockExtractIssueKey).toHaveBeenCalledWith("feature/ABC-7-thing");
    expect(mockGetIssue).toHaveBeenCalledWith(expect.anything(), "ABC-7", { comments: 5 });
  });

  it("errors when no key can be resolved", async () => {
    mockGetCurrentBranch.mockResolvedValue(null);

    await jiraCommand({ ...BASE_ARGS });

    expect(mockGetIssue).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining("No Jira issue key"));
    expect(process.exitCode).toBe(1);
  });

  it("errors when no credentials are configured", async () => {
    mockResolveJiraConfig.mockResolvedValue(null);
    mockJiraCredentialHealth.mockReturnValue("missing");

    await jiraCommand({ ...BASE_ARGS, key: "ABC-1" });

    expect(mockGetIssue).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining("No Jira credentials"));
    expect(process.exitCode).toBe(1);
  });

  it("points at re-login when a stored profile exists but won't decrypt", async () => {
    mockResolveJiraConfig.mockResolvedValue(null);
    mockJiraCredentialHealth.mockReturnValue("undecryptable");

    await jiraCommand({ ...BASE_ARGS, key: "ABC-1", profile: "work" });

    expect(mockJiraCredentialHealth).toHaveBeenCalledWith("work");
    expect(mockGetIssue).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.stringContaining("could not be decrypted")
    );
    expect(mockLoggerError).not.toHaveBeenCalledWith(
      expect.stringContaining("No Jira credentials")
    );
    expect(process.exitCode).toBe(1);
  });

  it("reports a fetch failure and sets a non-zero exit code", async () => {
    mockGetIssue.mockRejectedValue(new Error("HTTP 404"));

    await jiraCommand({ ...BASE_ARGS, key: "ABC-1" });

    expect(mockLoggerError).toHaveBeenCalledWith("HTTP 404");
    expect(process.exitCode).toBe(1);
  });
});

// 401 and 403 both read as "auth" in prose, but only 401 is fixable by logging
// in again. Classifying on the client's structured `kind` keeps the hint from
// contradicting the message the client itself printed one line earlier.
describe("jiraCommand error hints", () => {
  const RELOGIN_HINT = expect.stringContaining("jira-login");

  const failWith = async (e: unknown) => {
    mockGetIssue.mockRejectedValue(e);
    await jiraCommand({ ...BASE_ARGS, key: "ABC-1" });
    return mockLoggerInfo.mock.calls.map((c) => c[0] as string);
  };

  const httpError = (status: number) =>
    jiraHttpError({
      status,
      url: "https://acme.atlassian.net/rest/api/3/issue/ABC-1",
      context: "ABC-1",
    });

  it("tells a forbidden caller that re-login will not help", async () => {
    const hints = await failWith(httpError(403));

    expect(hints).not.toContainEqual(RELOGIN_HINT);
    expect(hints).toContainEqual(expect.stringContaining("not permitted"));
    expect(process.exitCode).toBe(1);
  });

  it("still points an unauthorized caller at re-login", async () => {
    const hints = await failWith(httpError(401));

    expect(hints).toContainEqual(RELOGIN_HINT);
  });

  it("points a not-found caller at the issue key", async () => {
    const hints = await failWith(httpError(404));

    expect(hints).toContainEqual(expect.stringContaining("verify the issue key"));
    expect(hints).not.toContainEqual(RELOGIN_HINT);
  });

  it("tells a throttled caller to wait rather than re-authenticate", async () => {
    const hints = await failWith(httpError(429));

    expect(hints).toContainEqual(expect.stringContaining("throttling"));
    expect(hints).not.toContainEqual(RELOGIN_HINT);
  });

  it("falls back to message matching for failures raised before a response", async () => {
    // A timeout/DNS failure never reaches a status, so it arrives as a plain
    // Error — the prose branches must still classify it.
    const hints = await failWith(new Error("request timed out after 30000ms"));

    expect(hints).toContainEqual(expect.stringContaining("timed out"));
  });
});

describe("jiraLoginCommand", () => {
  it("verifies and saves Cloud credentials with email", async () => {
    mockDetectDeployment.mockReturnValue("cloud");
    mockPrompt
      .mockResolvedValueOnce({ baseUrlRaw: "https://acme.atlassian.net/" })
      .mockResolvedValueOnce({ deployment: "cloud" })
      .mockResolvedValueOnce({ email: "me@acme.com" })
      .mockResolvedValueOnce({ token: "tok" });
    mockVerifyAuth.mockResolvedValue("Alice Example");

    await jiraLoginCommand({ ...BASE_ARGS });

    expect(mockVerifyAuth).toHaveBeenCalledWith({
      baseUrl: "https://acme.atlassian.net",
      deployment: "cloud",
      token: "tok",
      email: "me@acme.com",
    });
    expect(mockSaveJiraCredentials).toHaveBeenCalledWith({
      profile: "default",
      baseUrl: "https://acme.atlassian.net",
      deployment: "cloud",
      token: "tok",
      email: "me@acme.com",
    });
    expect(mockLoggerSuccess).toHaveBeenCalledWith(expect.stringContaining("Alice Example"));
  });

  it("saves Server credentials without prompting for email", async () => {
    mockDetectDeployment.mockReturnValue("server");
    mockPrompt
      .mockResolvedValueOnce({ baseUrlRaw: "https://jira.acme.com" })
      .mockResolvedValueOnce({ deployment: "server" })
      .mockResolvedValueOnce({ token: "pat" });
    mockVerifyAuth.mockResolvedValue("svc");

    await jiraLoginCommand({ ...BASE_ARGS, profile: "work" });

    expect(mockSaveJiraCredentials).toHaveBeenCalledWith({
      profile: "work",
      baseUrl: "https://jira.acme.com",
      deployment: "server",
      token: "pat",
    });
  });

  it("does not save when verification fails", async () => {
    mockDetectDeployment.mockReturnValue("cloud");
    mockPrompt
      .mockResolvedValueOnce({ baseUrlRaw: "https://acme.atlassian.net" })
      .mockResolvedValueOnce({ deployment: "cloud" })
      .mockResolvedValueOnce({ email: "me@acme.com" })
      .mockResolvedValueOnce({ token: "bad" });
    mockVerifyAuth.mockRejectedValue(new Error("401"));

    await jiraLoginCommand({ ...BASE_ARGS });

    expect(mockSaveJiraCredentials).not.toHaveBeenCalled();
    expect(mockLoggerError).toHaveBeenCalledWith(expect.stringContaining("Could not authenticate"));
    expect(process.exitCode).toBe(1);
  });
});

describe("jiraLogin prompt validators", () => {
  type Question = { name: string; validate?: (v: string) => true | string };

  /** Collect every question object passed across all inquirer.prompt calls. */
  function collectQuestions(): Question[] {
    return mockPrompt.mock.calls.flatMap((call) => call[0] as Question[]);
  }

  function validatorFor(name: string): (v: string) => true | string {
    const q = collectQuestions().find((question) => question.name === name);
    if (!q || !q.validate) {
      throw new Error(`No validator found for prompt "${name}"`);
    }
    return q.validate;
  }

  it("rejects blank and accepts non-blank base URL, email, and token", async () => {
    mockDetectDeployment.mockReturnValue("cloud");
    mockPrompt
      .mockResolvedValueOnce({ baseUrlRaw: "https://acme.atlassian.net" })
      .mockResolvedValueOnce({ deployment: "cloud" })
      .mockResolvedValueOnce({ email: "me@acme.com" })
      .mockResolvedValueOnce({ token: "tok" });
    mockVerifyAuth.mockResolvedValue("Alice");

    await jiraLoginCommand({ ...BASE_ARGS });

    const baseUrl = validatorFor("baseUrlRaw");
    expect(baseUrl("   ")).toMatch(/required/i);
    expect(baseUrl("https://x")).toBe(true);

    const email = validatorFor("email");
    expect(email("  ")).toMatch(/required/i);
    expect(email("me@acme.com")).toBe(true);

    const token = validatorFor("token");
    expect(token("")).toMatch(/required/i);
    expect(token("tok")).toBe(true);
  });
});

describe("jiraLogoutCommand", () => {
  it("removes a single profile by default", async () => {
    await jiraLogoutCommand({ ...BASE_ARGS, profile: "work" });
    expect(mockRemoveJiraCredentials).toHaveBeenCalledWith("work");
    expect(mockRemoveAllJiraCredentials).not.toHaveBeenCalled();
  });

  it("removes the default profile when none is given", async () => {
    await jiraLogoutCommand({ ...BASE_ARGS });
    expect(mockRemoveJiraCredentials).toHaveBeenCalledWith("default");
  });

  it("removes all profiles with --all", async () => {
    await jiraLogoutCommand({ ...BASE_ARGS, all: true });
    expect(mockRemoveAllJiraCredentials).toHaveBeenCalled();
    expect(mockRemoveJiraCredentials).not.toHaveBeenCalled();
    expect(mockLoggerSuccess).toHaveBeenCalledWith(expect.stringContaining("2 profile(s)"));
  });
});
