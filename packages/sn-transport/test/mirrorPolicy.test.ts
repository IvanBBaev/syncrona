// SPDX-License-Identifier: GPL-3.0-or-later
// Mirror transport policy (WP-M0). The classifier cases below are not invented:
// they are the shapes a live ServiceNow PDI returned, recorded as measurements
// M1/M2/M6/M7 in docs/design/mirror-analyses.md §7. Keeping them here as
// fixtures is what stops a later "simplification" back to status-code-only
// classification or to offset paging — both of which look fine in isolation and
// are wrong against the real platform.
import type { SnErrorClass } from "../src/mirrorPolicy";
import {
  RETRYABLE_HTTP_STATUSES,
  classifyError,
  diagnoseReachability,
  computeRetryDelay,
  buildKeysetQuery,
  HIBERNATION_MARKERS,
  RETRY_BASE_DELAY_MS,
  RETRY_MAX_DELAY_MS,
  RETRY_AFTER_MAX_MS,
  TABLE_API_BASE,
  SYS_ID_RE,
} from "../src/index";

// ---------------------------------------------------------------------------
// The three measured error-envelope shapes (analyses §7, M1). Byte-for-byte the
// bodies the instance returned, so the fixtures carry the measurement rather
// than a paraphrase of it.
// ---------------------------------------------------------------------------

/** M1a: a malformed request — the envelope arrives on a 400, not only on 401. */
const MEASURED_400_ENVELOPE =
  '{"error":{"message":"Invalid table sys_nonexistent","detail":"Table sys_nonexistent does not exist"},"status":"failure"}';

/** M1b: an unauthenticated request — the platform's exact 401 wording. */
const MEASURED_401_ENVELOPE =
  '{"error":{"message":"User Not Authenticated","detail":"Required to provide Auth information"},"status":"failure"}';

/** M1c: the same envelope with a genuinely null `detail`. */
const MEASURED_NULL_DETAIL_ENVELOPE =
  '{"error":{"message":"Insufficient rights to query records","detail":null},"status":"failure"}';

describe("classifyError: the three measured PDI envelopes (M1)", () => {
  it("reads the envelope that arrives on a 400 (M1a)", () => {
    const result = classifyError(400, MEASURED_400_ENVELOPE);
    expect(result.httpStatus).toBe(400);
    expect(result.message).toBe("Invalid table sys_nonexistent");
    expect(result.detail).toBe("Table sys_nonexistent does not exist");
    // Nothing in the text names auth or an ACL, so the status decides: a 400 is
    // a caller mistake and no amount of retrying fixes it.
    expect(result.classified).toBe("fatal");
  });

  it("reads the 401 envelope and classifies from its wording (M1b)", () => {
    const result = classifyError(401, MEASURED_401_ENVELOPE);
    expect(result.message).toBe("User Not Authenticated");
    expect(result.detail).toBe("Required to provide Auth information");
    expect(result.classified).toBe("auth");
  });

  it("keeps a measured null detail as null rather than the string 'null' (M1c)", () => {
    const result = classifyError(403, MEASURED_NULL_DETAIL_ENVELOPE);
    expect(result.detail).toBeNull();
    expect(result.classified).toBe("acl");
  });

  it("classifies the auth envelope by its words even when the status says 400 (D5)", () => {
    // The defect this pins: a status-only classifier sees 400, reports "fatal",
    // and the operator is told the query was malformed when the real cause is a
    // wrong password behind a proxy that rewrote the status.
    const result = classifyError(400, MEASURED_401_ENVELOPE);
    expect(result.classified).toBe("auth");
  });
});

describe("classifyError: envelope parsing", () => {
  it("accepts an already-parsed object body as well as raw text", () => {
    const parsed = JSON.parse(MEASURED_401_ENVELOPE) as unknown;
    expect(classifyError(401, parsed).classified).toBe("auth");
  });

  it("falls back to the status when the body is not JSON at all", () => {
    const result = classifyError(502, "<html><body>Bad Gateway</body></html>");
    expect(result.message).toBe("HTTP 502");
    expect(result.detail).toBeNull();
    expect(result.classified).toBe("transient");
  });

  it("falls back to the status for a null, primitive or envelope-less body", () => {
    expect(classifyError(404, null).classified).toBe("not-found");
    // A bare JSON scalar parses fine but is not an object.
    expect(classifyError(404, "12").message).toBe("HTTP 404");
    expect(classifyError(404, { result: [] }).message).toBe("HTTP 404");
    // `error` present but not an object — not the envelope shape.
    expect(classifyError(404, { error: "boom" }).message).toBe("HTTP 404");
  });

  it("tolerates an envelope whose message is missing or not a string", () => {
    const result = classifyError(500, { error: { message: 42, detail: 7 } });
    expect(result.message).toBe("");
    expect(result.detail).toBeNull();
    expect(result.classified).toBe("transient");
  });

  it("matches an ACL marker found only in the detail field", () => {
    const result = classifyError(400, {
      error: { message: "Operation Failed", detail: "Read operation against file denied" },
    });
    expect(result.classified).toBe("acl");
  });

  it("does not fire the ACL word match on ordinary words containing 'acl'", () => {
    // `\bacl\b` rather than a substring: "oracle" and "tentacle" both contain
    // "acl" and neither is a permission problem.
    const result = classifyError(400, {
      error: { message: "Oracle connector tentacle failure", detail: null },
    });
    expect(result.classified).toBe("fatal");
  });
});

describe("classifyError: status fallback", () => {
  const STATUS_FALLBACKS: ReadonlyArray<[number, SnErrorClass]> = [
    [408, "transient"],
    [425, "transient"],
    [429, "transient"],
    [500, "transient"],
    [503, "transient"],
    // §5.1 says "5xx", so the widened rule must cover the gateway statuses the
    // v1 enumeration never listed.
    [521, "transient"],
    [401, "auth"],
    [403, "acl"],
    [404, "not-found"],
    [400, "fatal"],
    [409, "fatal"],
  ];

  it.each(STATUS_FALLBACKS)("classifies a bare HTTP %i as %s", (status, expected) => {
    expect(classifyError(status, "").classified).toBe(expected);
  });

  it("stays a superset of the v1 retryable status list", () => {
    // The mirror widens 408/425/429/5xx over `RETRYABLE_HTTP_STATUSES`; this
    // pins the widening as a superset so the two policies cannot diverge into
    // "retryable for the CLI, fatal for the mirror".
    for (const status of RETRYABLE_HTTP_STATUSES) {
      expect(classifyError(status, "").classified).toBe("transient");
    }
  });
});

describe("diagnoseReachability: one test per state (D4)", () => {
  it("reports auth-failed for a JSON 401", () => {
    const result = diagnoseReachability({
      status: 401,
      contentType: "application/json",
      body: MEASURED_401_ENVELOPE,
    });
    expect(result.state).toBe("auth-failed");
    // §10 requires the literal "auth failed" wording in the operator message.
    expect(result.detail).toContain("auth failed");
    expect(result.detail).toContain("User Not Authenticated");
  });

  it("reports unreachable for a connection error", () => {
    const result = diagnoseReachability({
      networkError: { code: "ENOTFOUND", message: "getaddrinfo ENOTFOUND dev00000.service-now.com" },
    });
    expect(result.state).toBe("unreachable");
    expect(result.detail).toContain("instance unreachable");
    expect(result.detail).toContain("ENOTFOUND");
  });

  it("reports hibernating for the HTML hibernation page", () => {
    const result = diagnoseReachability({
      // Measured behavior: a hibernating PDI answers 200 with an HTML page, so
      // a status-first diagnosis would call this instance healthy.
      status: 200,
      contentType: "text/html;charset=UTF-8",
      body: "<html><head><title>Instance Hibernating page</title></head><body>This instance is hibernating</body></html>",
    });
    expect(result.state).toBe("hibernating");
    expect(result.detail).toBe("instance hibernating (wake it at developer.servicenow.com)");
  });

  it("reports ok for a healthy JSON response", () => {
    const result = diagnoseReachability({
      status: 200,
      contentType: "application/json",
      body: { result: [] },
    });
    expect(result.state).toBe("ok");
  });
});

describe("diagnoseReachability: edges around the tri-state", () => {
  it("falls back through code, message and a literal when the error is bare", () => {
    expect(diagnoseReachability({ networkError: { message: "socket hang up" } }).detail).toContain(
      "socket hang up"
    );
    expect(diagnoseReachability({ networkError: {} }).detail).toContain("no response");
  });

  it("treats a non-hibernation HTML body as unreachable, not ok", () => {
    // A captive portal or SSO gateway answering for the instance: we are not
    // talking to ServiceNow, so no sweep may start.
    const result = diagnoseReachability({
      status: 200,
      body: "<html><body>Sign in to continue</body></html>",
    });
    expect(result.state).toBe("unreachable");
    expect(result.detail).toContain("returned HTML, not JSON");
  });

  it("detects HTML from the content type even when the body is not a string", () => {
    const result = diagnoseReachability({ status: 200, contentType: "TEXT/HTML", body: { a: 1 } });
    expect(result.state).toBe("unreachable");
  });

  it("recognises every documented hibernation marker", () => {
    for (const marker of HIBERNATION_MARKERS) {
      const result = diagnoseReachability({
        status: 200,
        contentType: "text/html",
        body: `<html>${marker.toUpperCase()}</html>`,
      });
      expect(result.state).toBe("hibernating");
    }
  });

  it("treats a 5xx as unreachable for the purpose of starting a sweep", () => {
    const result = diagnoseReachability({ status: 503, body: "" });
    expect(result.state).toBe("unreachable");
    expect(result.detail).toContain("HTTP 503");
  });

  it("treats a 403 on the probe target as reachable, not as an auth failure", () => {
    // An ACL denial on one endpoint says nothing about the instance being up,
    // and mislabelling it "auth failed" would send the operator to reset a
    // password that is perfectly fine.
    const result = diagnoseReachability({ status: 403, body: MEASURED_NULL_DETAIL_ENVELOPE });
    expect(result.state).toBe("ok");
  });

  it("reports an absent status as HTTP 0 rather than crashing", () => {
    expect(diagnoseReachability({ body: "" }).detail).toContain("HTTP 0");
  });

  it("flattens control characters out of instance-supplied text", () => {
    // A record's own error text must not be able to forge extra log lines.
    const result = diagnoseReachability({
      status: 401,
      body: { error: { message: "User Not Authenticated\n[ok] all good", detail: null } },
    });
    expect(result.detail).not.toContain("\n");
    expect(result.detail).toContain("User Not Authenticated [ok] all good");
  });

  it("bounds an absurdly long instance message", () => {
    const result = diagnoseReachability({
      status: 401,
      body: { error: { message: `User Not Authenticated ${"x".repeat(500)}`, detail: null } },
    });
    expect(result.detail.length).toBeLessThan(300);
    expect(result.detail).toContain("...");
  });
});

describe("computeRetryDelay: full jitter with a defensive Retry-After (D6)", () => {
  it("keeps the delay inside [0, min(cap, base * 2^attempt)]", () => {
    // Full jitter, so the assertion is on the interval, not on a point value.
    expect(computeRetryDelay(0, null, { random: () => 0 })).toBe(0);
    expect(computeRetryDelay(0, null, { random: () => 0.999 })).toBe(999);
    expect(computeRetryDelay(3, null, { random: () => 1 })).toBe(RETRY_BASE_DELAY_MS * 8);
  });

  it("caps the computed backoff at RETRY_MAX_DELAY_MS", () => {
    expect(computeRetryDelay(20, null, { random: () => 1 })).toBe(RETRY_MAX_DELAY_MS);
    // 2**attempt overflows to Infinity here; the cap must still hold.
    expect(computeRetryDelay(5000, null, { random: () => 1 })).toBe(RETRY_MAX_DELAY_MS);
  });

  it("clamps a nonsensical attempt to the first-retry interval", () => {
    expect(computeRetryDelay(-4, null, { random: () => 1 })).toBe(RETRY_BASE_DELAY_MS);
    expect(computeRetryDelay(Number.NaN, null, { random: () => 1 })).toBe(RETRY_BASE_DELAY_MS);
    // A fractional attempt floors rather than producing a fractional exponent.
    expect(computeRetryDelay(2.9, null, { random: () => 1 })).toBe(RETRY_BASE_DELAY_MS * 4);
  });

  it("uses Math.random when no RNG is injected", () => {
    const delay = computeRetryDelay(0);
    expect(delay).toBeGreaterThanOrEqual(0);
    expect(delay).toBeLessThanOrEqual(RETRY_BASE_DELAY_MS);
  });

  it("lets a delta-seconds Retry-After win over the backoff", () => {
    expect(computeRetryDelay(0, "12", { random: () => 1 })).toBe(12_000);
    expect(computeRetryDelay(0, "0", { random: () => 1 })).toBe(0);
  });

  it("honors an HTTP-date Retry-After against an injected clock", () => {
    const now = Date.parse("2026-01-01T00:00:00Z");
    expect(
      computeRetryDelay(0, "Thu, 01 Jan 2026 00:00:30 GMT", { now: () => now, random: () => 1 })
    ).toBe(30_000);
  });

  it("treats an already-past Retry-After date as retry-now", () => {
    // No injected clock here, so this also covers the default Date.now path.
    expect(computeRetryDelay(0, "Thu, 01 Jan 1970 00:00:00 GMT", { random: () => 1 })).toBe(0);
  });

  it("bounds a hostile Retry-After so one sleep cannot eat the run deadline", () => {
    expect(computeRetryDelay(0, "86400", { random: () => 1 })).toBe(RETRY_AFTER_MAX_MS);
  });

  it("falls back to the backoff for an absent, blank or unparseable header", () => {
    // M2: a default ServiceNow response carries no rate-limit headers at all,
    // so this is the path that actually runs in production.
    expect(computeRetryDelay(0, undefined, { random: () => 1 })).toBe(RETRY_BASE_DELAY_MS);
    expect(computeRetryDelay(0, "   ", { random: () => 1 })).toBe(RETRY_BASE_DELAY_MS);
    expect(computeRetryDelay(0, "later", { random: () => 1 })).toBe(RETRY_BASE_DELAY_MS);
  });
});

describe("buildKeysetQuery: design §6 parameters, exactly", () => {
  const CURSOR = "0123456789abcdef0123456789abcdef";
  const FIELDS = ["sys_id", "sys_updated_on", "name"] as const;

  it("emits exactly the six documented parameters and no others", () => {
    const query = buildKeysetQuery("sys_script_include", CURSOR, 1000, { fields: [...FIELDS] });
    expect(query.path).toBe(`${TABLE_API_BASE}/sys_script_include`);
    expect(query.params).toEqual({
      sysparm_query: `sys_id>${CURSOR}^ORDERBYsys_id`,
      sysparm_fields: "sys_id,sys_updated_on,name",
      sysparm_limit: "1000",
      sysparm_exclude_reference_link: "true",
      sysparm_display_value: "false",
      sysparm_suppress_pagination_header: "true",
    });
  });

  it("never produces offset pagination", () => {
    // The invariant, stated as a test: no input reaches a `sysparm_offset`,
    // because an offset window slides under concurrent inserts and silently
    // drops records out of a tree that claims to be complete.
    for (const cursor of [null, CURSOR]) {
      const query = buildKeysetQuery("incident", cursor, 500, { fields: ["sys_id"] });
      expect(Object.keys(query.params)).not.toContain("sysparm_offset");
      expect(JSON.stringify(query)).not.toContain("offset");
    }
  });

  it("omits the cursor condition on the first page instead of sending an empty one", () => {
    const query = buildKeysetQuery("incident", null, 1000, { fields: ["sys_id"] });
    // `sys_id>` with nothing after it is a malformed condition, not "from the
    // beginning" — the first page carries the ORDERBY alone.
    expect(query.params.sysparm_query).toBe("ORDERBYsys_id");
  });

  it("ANDs extra conditions before the cursor and keeps ORDERBY last", () => {
    const query = buildKeysetQuery("sys_metadata", CURSOR, 200, {
      fields: ["sys_id"],
      extraQuery: "sys_updated_on>=2026-01-01",
    });
    expect(query.params.sysparm_query).toBe(
      `sys_updated_on>=2026-01-01^sys_id>${CURSOR}^ORDERBYsys_id`
    );
  });

  it("ignores a blank extraQuery", () => {
    const query = buildKeysetQuery("incident", null, 1, { fields: ["sys_id"], extraQuery: "  " });
    expect(query.params.sysparm_query).toBe("ORDERBYsys_id");
  });

  it("adds sys_id to the projection when the caller forgot it", () => {
    // Without sys_id in the response there is no next cursor, so the pager
    // would fetch one page and stop — a silent truncation.
    const query = buildKeysetQuery("incident", null, 10, { fields: ["number", "  short_desc  "] });
    expect(query.params.sysparm_fields).toBe("sys_id,number,short_desc");
  });

  it("rejects a table name that would redirect the request", () => {
    expect(() => buildKeysetQuery("../sys_user", null, 10, { fields: ["sys_id"] })).toThrow(
      /unsafe table name/
    );
    expect(() => buildKeysetQuery("", null, 10, { fields: ["sys_id"] })).toThrow(
      /unsafe table name/
    );
  });

  it("rejects a cursor that is not a sys_id (INV-6)", () => {
    // The injection this blocks: a `^` inside the cursor would be read as a
    // condition separator and could cancel the caller's scope filter.
    expect(() =>
      buildKeysetQuery("incident", "abc^sys_class_name=task", 10, { fields: ["sys_id"] })
    ).toThrow(/is not a sys_id/);
    expect(() => buildKeysetQuery("incident", "ABCDEF", 10, { fields: ["sys_id"] })).toThrow(
      /is not a sys_id/
    );
    expect(SYS_ID_RE.test("0123456789ABCDEF0123456789abcdef")).toBe(false);
  });

  it("rejects a non-positive or fractional page size", () => {
    expect(() => buildKeysetQuery("incident", null, 0, { fields: ["sys_id"] })).toThrow(
      /positive integer/
    );
    expect(() => buildKeysetQuery("incident", null, 1.5, { fields: ["sys_id"] })).toThrow(
      /positive integer/
    );
  });

  it("rejects a field name that would widen the projection", () => {
    expect(() =>
      buildKeysetQuery("incident", null, 10, { fields: ["sys_id,sys_created_by"] })
    ).toThrow(/unsafe field name/);
  });

  it("rejects an empty projection", () => {
    expect(() => buildKeysetQuery("incident", null, 10, { fields: ["", "   "] })).toThrow(
      /asked for no fields/
    );
  });
});
