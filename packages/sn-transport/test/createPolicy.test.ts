// SPDX-License-Identifier: GPL-3.0-or-later
import {
  CREATE_TABLE_ALLOWLIST_ENV,
  DENIED_CREATE_TABLES,
  MCP_CREATE_TABLE_ALLOWLIST_ENV,
  classifyCreateTable,
  describeDeniedCreateTable,
  describeUnlistedCreateTable,
  evaluateCreateTablePolicy,
  isDeniedCreateTable,
  normalizeCreateTableName,
  parseCreateTableAllowlist,
  readCreateTableAllowlist,
} from "../src/index";

const baseOptions = {
  consumer: "push --create",
  env: {} as Record<string, string | undefined>,
  isAllowedByDefault: (t: string) => t === "sys_script_include",
  defaultDescription: "only application files are allowed",
};

describe("create-table policy (shared)", () => {
  it("exposes the env names and the deny list", () => {
    expect(CREATE_TABLE_ALLOWLIST_ENV).toBe("SYNCRONA_CREATE_TABLE_ALLOWLIST");
    expect(MCP_CREATE_TABLE_ALLOWLIST_ENV).toBe("SYNCRONA_MCP_CREATE_TABLE_ALLOWLIST");
    expect([...DENIED_CREATE_TABLES].sort()).toEqual(
      [
        "cmdb_ci",
        "sys_properties",
        "sys_user",
        "sys_user_group",
        "sys_user_has_role",
        "sys_user_role",
      ]
    );
  });

  it("normalizes names by trimming and lower-casing", () => {
    expect(normalizeCreateTableName("  SYS_Script ")).toBe("sys_script");
    expect(isDeniedCreateTable(" SYS_USER ")).toBe(true);
    expect(isDeniedCreateTable("sys_script")).toBe(false);
  });

  it("parses an allowlist, dropping empty and denied entries", () => {
    expect([...parseCreateTableAllowlist(" Incident , ,u_x,sys_user,")]).toEqual([
      "incident",
      "u_x",
    ]);
    expect(parseCreateTableAllowlist(undefined).size).toBe(0);
  });

  it("reads the shared env var, and lets a preferred env var win when set", () => {
    const env = {
      [CREATE_TABLE_ALLOWLIST_ENV]: "u_shared",
      [MCP_CREATE_TABLE_ALLOWLIST_ENV]: "u_mcp",
    };
    expect([...readCreateTableAllowlist(env)]).toEqual(["u_shared"]);
    expect([...readCreateTableAllowlist(env, MCP_CREATE_TABLE_ALLOWLIST_ENV)]).toEqual(["u_mcp"]);
    // An unset preferred variable falls back to the shared one.
    expect([
      ...readCreateTableAllowlist({ [CREATE_TABLE_ALLOWLIST_ENV]: "u_shared" }, MCP_CREATE_TABLE_ALLOWLIST_ENV),
    ]).toEqual(["u_shared"]);
    // Set-but-empty still wins: it narrows that consumer back to its defaults.
    expect(
      readCreateTableAllowlist(
        { [CREATE_TABLE_ALLOWLIST_ENV]: "u_shared", [MCP_CREATE_TABLE_ALLOWLIST_ENV]: "" },
        MCP_CREATE_TABLE_ALLOWLIST_ENV
      ).size
    ).toBe(0);
  });

  it("classifies denied, allowlisted and unlisted tables", () => {
    const env = { [CREATE_TABLE_ALLOWLIST_ENV]: "u_env,sys_user" };
    expect(classifyCreateTable("sys_user", { env })).toBe("denied");
    expect(classifyCreateTable("cmdb_ci", { env, extraAllowed: ["cmdb_ci"] })).toBe("denied");
    expect(classifyCreateTable("U_ENV", { env })).toBe("allowlisted");
    expect(classifyCreateTable("u_cfg", { env, extraAllowed: [" U_CFG "] })).toBe("allowlisted");
    expect(
      classifyCreateTable("u_cfg", { env, extraAllowed: [42 as unknown as string] })
    ).toBe("unlisted");
    expect(classifyCreateTable("incident", { env })).toBe("unlisted");
    expect(classifyCreateTable("   ", { env, extraAllowed: [""] })).toBe("unlisted");
  });

  it("evaluates the full policy with a synchronous default rule", () => {
    expect(evaluateCreateTablePolicy("sys_script_include", baseOptions)).toEqual({ allowed: true });
    expect(
      evaluateCreateTablePolicy("u_cfg", { ...baseOptions, extraAllowed: ["u_cfg"] })
    ).toEqual({ allowed: true });

    const denied = evaluateCreateTablePolicy("sys_properties", baseOptions);
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) {
      expect(denied.reason).toMatch(/"sys_properties" is denied for push --create/);
      expect(denied.reason).toContain(CREATE_TABLE_ALLOWLIST_ENV);
    }

    const unlisted = evaluateCreateTablePolicy("incident", {
      ...baseOptions,
      extraRemedy: "Or list it under createTables.",
    });
    expect(unlisted.allowed).toBe(false);
    if (!unlisted.allowed) {
      expect(unlisted.reason).toMatch(/"incident" is not on the push --create table allowlist/);
      expect(unlisted.reason).toMatch(/By default only application files are allowed\./);
      expect(unlisted.reason).toMatch(/Or list it under createTables\.$/);
    }
  });

  it("names the preferred env var first and the shared one as the alternative", () => {
    const opts = { consumer: "x", preferredEnvName: MCP_CREATE_TABLE_ALLOWLIST_ENV, denyNote: " always" };
    expect(describeDeniedCreateTable("sys_user", opts)).toContain(
      `refused always, and the deny list cannot be overridden via ${MCP_CREATE_TABLE_ALLOWLIST_ENV} (or ${CREATE_TABLE_ALLOWLIST_ENV}).`
    );
    expect(describeUnlistedCreateTable("t", "d", opts)).toContain(
      `set the ${MCP_CREATE_TABLE_ALLOWLIST_ENV} (or ${CREATE_TABLE_ALLOWLIST_ENV}) environment variable`
    );
    // Naming the shared variable as "preferred" does not list it twice.
    expect(
      describeUnlistedCreateTable("t", "d", { consumer: "x", preferredEnvName: CREATE_TABLE_ALLOWLIST_ENV })
    ).not.toContain("(or ");
  });
});
