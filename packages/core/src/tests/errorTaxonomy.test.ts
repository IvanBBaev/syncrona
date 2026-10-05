// SPDX-License-Identifier: GPL-3.0-or-later
import { classifyError, CICD_ROLE, ErrorCategory } from "../errorTaxonomy.js";

// DX19: every CLI failure is classified so the user gets an actionable hint.

const cat = (e: unknown): ErrorCategory => classifyError(e).category;

describe("classifyError", () => {
  it("classifies transport-level Node error codes as network", () => {
    for (const code of ["ECONNREFUSED", "ENOTFOUND", "ETIMEDOUT", "ECONNRESET"]) {
      expect(cat(Object.assign(new Error("boom"), { code }))).toBe("network");
    }
  });

  it("uses HTTP status before message text", () => {
    expect(cat({ response: { status: 401 } })).toBe("auth");
    expect(cat({ response: { status: 403 } })).toBe("auth");
    expect(cat({ response: { status: 404 } })).toBe("data");
    expect(cat({ response: { status: 429 } })).toBe("network");
    expect(cat({ response: { status: 503 } })).toBe("network");
  });

  it("falls back to message keywords", () => {
    expect(cat(new Error("Invalid credentials for the integration user"))).toBe("auth");
    expect(cat(new Error("Failed to load config file sync.config.js"))).toBe("config");
    expect(cat(new Error("ENOENT: no such file or directory, open '.env'"))).toBe("config");
    expect(cat(new Error("Record does not exist on the instance"))).toBe("data");
    expect(cat(new Error("getaddrinfo timeout reaching instance"))).toBe("network");
  });

  it("returns unknown for an unrecognised error", () => {
    expect(cat(new Error("something weird happened"))).toBe("unknown");
    expect(cat(undefined)).toBe("unknown");
    expect(cat("a bare string")).toBe("unknown");
  });

  it("names the missing sn_cicd role for a 403 from the CI/CD API (WP-5)", () => {
    const byUrl = classifyError({ response: { status: 403 }, config: { url: "api/sn_cicd/testsuite/run" } });
    expect(byUrl.category).toBe("auth");
    expect(byUrl.hint).toContain(CICD_ROLE);
    const byMessage = classifyError(
      Object.assign(new Error("403 from /api/sn_cicd/progress/1"), { response: { status: 403 } })
    );
    expect(byMessage.hint).toContain(CICD_ROLE);
    // Other 403s keep the generic auth hint; a 401 on sn_cicd is still bad credentials.
    expect(classifyError({ response: { status: 403 }, config: { url: "api/now/table/x" } }).hint).not.toContain(
      CICD_ROLE
    );
    expect(classifyError({ response: { status: 401 }, config: { url: "api/sn_cicd/x" } }).hint).not.toContain(
      CICD_ROLE
    );
  });

  it("always provides a non-empty actionable hint", () => {
    for (const e of [
      Object.assign(new Error("x"), { code: "ECONNREFUSED" }),
      { response: { status: 401 } },
      new Error("sync.config.js broken"),
      new Error("not found"),
      new Error("???"),
    ]) {
      expect(classifyError(e).hint.length).toBeGreaterThan(0);
    }
  });
});
