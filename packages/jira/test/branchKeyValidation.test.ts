// SPDX-License-Identifier: GPL-3.0-or-later
import { extractIssueKey } from "../src/branch";

describe("extractIssueKey after stripping a branch-type word", () => {
  it("rejects a remainder that is not a project key", () => {
    expect(extractIssueKey("release_2026-10")).toBeNull();
    expect(extractIssueKey("hotfix_1-2")).toBeNull();
    expect(extractIssueKey("feature_1abc-2")).toBeNull();
  });

  it("drops the empty segment a doubled underscore leaves before the key", () => {
    expect(extractIssueKey("feature__abc-1")).toBe("ABC-1");
  });

  it("keeps scanning past an invalid remainder to a real key", () => {
    expect(extractIssueKey("release_2026-10-for-ABC-7")).toBe("ABC-7");
  });

  it("still keeps underscores inside a genuine key", () => {
    expect(extractIssueKey("feature_my_proj-12")).toBe("MY_PROJ-12");
  });
});
