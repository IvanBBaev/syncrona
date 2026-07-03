// SPDX-License-Identifier: GPL-3.0-or-later
import { classifyError, ErrorCategory } from "../errorTaxonomy.js";

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
