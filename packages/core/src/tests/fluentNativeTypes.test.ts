// SPDX-License-Identifier: GPL-3.0-or-later
export {};

// `fluent types --native` reads sys_db_object, sys_dictionary and sys_choice
// over the Table API. The client here is an in-memory fake that answers each
// read from fixture rows, honours `nameIN`, `sys_scope.scope=`, limit and
// offset, and records every call, so paging and chunking are observable
// without a ServiceNow instance.

let fetchNativeSchema: typeof import("../fluentNativeTypes.js").fetchNativeSchema;
let renderNativeTypes: typeof import("../fluentNativeTypes.js").renderNativeTypes;
let generateNativeTypes: typeof import("../fluentNativeTypes.js").generateNativeTypes;
let baseType: typeof import("../fluentNativeTypes.js").baseType;
let interfaceNames: typeof import("../fluentNativeTypes.js").interfaceNames;
let MAX_PAGES: number;
let NonApiResponseError: typeof import("../snClient.js").NonApiResponseError;

beforeAll(async () => {
  ({ fetchNativeSchema, renderNativeTypes, generateNativeTypes, baseType, interfaceNames, MAX_PAGES } =
    await import("../fluentNativeTypes.js"));
  ({ NonApiResponseError } = await import("../snClient.js"));
});

type Row = Record<string, unknown>;

interface Call {
  table: string;
  query: string;
  fields: string;
  limit: number;
  offset: number;
  extra?: { params?: Record<string, string> };
}

interface Fixture {
  sys_db_object: Row[];
  sys_dictionary: Row[];
  sys_choice: Row[];
}

function nameFilter(query: string): ((row: Row) => boolean) | undefined {
  const match = /^nameIN([^^]*)/.exec(query);
  if (!match) return undefined;
  const names = new Set(match[1].split(","));
  return (row) => names.has(String(row.name));
}

interface Server {
  /** Rows the instance returns per page at most, whatever the request asks for. */
  cap?: number;
  /** Answer with `X-Total-Count`, as the Table API does by default (true). */
  totalCount?: boolean;
}

function fakeClient(fixture: Fixture, override?: (call: Call) => unknown, server: Server = {}) {
  const calls: Call[] = [];
  const client = {
    tableAPIGet: async (
      table: string,
      query: string,
      fields: string,
      limit = 500,
      offset = 0,
      extra?: { params?: Record<string, string> }
    ) => {
      const call = { table, query, fields, limit, offset, extra };
      calls.push(call);
      const custom = override?.(call);
      if (custom !== undefined) return custom;
      let rows = fixture[table as keyof Fixture];
      const byName = nameFilter(query);
      if (byName) rows = rows.filter(byName);
      const scope = /^sys_scope\.scope=([^^]*)/.exec(query);
      if (scope) rows = rows.filter((row) => row["sys_scope.scope"] === scope[1]);
      const size = Math.min(limit, server.cap ?? limit);
      return {
        data: { result: rows.slice(offset, offset + size) },
        headers: server.totalCount === false ? {} : { "x-total-count": String(rows.length) },
      };
    },
  };
  return { client: client as never, calls };
}

const TASK_FIXTURE: Fixture = {
  sys_db_object: [
    { name: "task", label: "Task", "super_class.name": "", "sys_scope.scope": "global" },
    { name: "x_acme_ticket", label: "Ticket", "super_class.name": "task", "sys_scope.scope": "x_acme" },
    { name: "x_acme_note", label: "Note", "super_class.name": "", "sys_scope.scope": "x_acme" },
  ],
  sys_dictionary: [
    { name: "task", element: "number", column_label: "Number", internal_type: "string", mandatory: "true", max_length: "40" },
    { name: "task", element: "state", column_label: "State", internal_type: "integer", choice: "3" },
    { name: "task", element: "assigned_to", column_label: "Assigned to", internal_type: "reference", reference: "sys_user" },
    { name: "task", element: "active", column_label: "Active", internal_type: "boolean" },
    { name: "x_acme_ticket", element: "severity", column_label: "Severity", internal_type: "string", choice: "1" },
    { name: "x_acme_ticket", element: "opened", column_label: "Opened", internal_type: "glide_date_time" },
    { name: "x_acme_note", element: "body", column_label: "Body */ end", internal_type: "html" },
  ],
  sys_choice: [
    { name: "task", element: "state", value: "2" },
    { name: "task", element: "state", value: "1" },
    { name: "task", element: "state", value: "10" },
    // A child table narrowing an inherited choice column.
    { name: "x_acme_ticket", element: "state", value: "1" },
    { name: "x_acme_ticket", element: "state", value: "7" },
    // The same value in two languages.
    { name: "x_acme_ticket", element: "severity", value: "high" },
    { name: "x_acme_ticket", element: "severity", value: "low" },
    { name: "x_acme_ticket", element: "severity", value: "high" },
  ],
};

describe("baseType (internal_type mapping)", () => {
  it.each([
    ["boolean", "boolean"],
    ["integer", "number"],
    ["longint", "number"],
    ["decimal", "number"],
    ["float", "number"],
    ["percent_complete", "number"],
    ["order_index", "number"],
    ["glide_date_time", "GlideDateTime"],
    ["due_date", "GlideDateTime"],
    ["glide_date", "GlideDate"],
    ["glide_time", "GlideTime"],
    ["glide_duration", "GlideDuration"],
    ["timer", "GlideDuration"],
    ["reference", "SysId"],
    ["document_id", "SysId"],
    ["domain_id", "SysId"],
    ["GUID", "SysId"],
    ["glide_list", "SysIdList"],
    ["string", "string"],
    ["script", "string"],
    ["html", "string"],
    ["toString", "string"],
  ])("maps %s to %s", (internalType, expected) => {
    expect(baseType(internalType)).toBe(expected);
  });
});

describe("interfaceNames", () => {
  it("keeps valid names and escapes reserved, declared, invalid and colliding ones", () => {
    const names = interfaceNames(["task", "class", "SysId", "1table", "a-b", "a_b", "Tables"]);
    expect(Object.fromEntries(names)).toEqual({
      "1table": "_1table",
      SysId: "_SysId",
      Tables: "_Tables",
      "a-b": "a_b",
      a_b: "a_b_2",
      class: "_class",
      task: "task",
    });
  });
});

describe("fetchNativeSchema", () => {
  it("reads the scope's tables, walks up to their ancestors, and sorts everything", async () => {
    const { client, calls } = fakeClient(TASK_FIXTURE);
    const schema = await fetchNativeSchema(client, { scope: "x_acme" });
    expect(schema.scope).toBe("x_acme");
    expect(schema.requested).toEqual(["x_acme_note", "x_acme_ticket"]);
    expect(schema.tables.map((t) => t.name)).toEqual(["task", "x_acme_note", "x_acme_ticket"]);
    const task = schema.tables[0];
    expect(task.fields.map((f) => f.element)).toEqual(["active", "assigned_to", "number", "state"]);
    expect(task.fields[1]).toEqual({
      element: "assigned_to",
      label: "Assigned to",
      internalType: "reference",
      reference: "sys_user",
      mandatory: false,
      choice: "0",
    });
    expect(task.fields[2]).toMatchObject({ mandatory: true, maxLength: 40 });
    expect(task.choices).toEqual({ state: ["1", "10", "2"] });
    expect(schema.tables[2].choices).toEqual({ severity: ["high", "low"], state: ["1", "7"] });

    expect(calls.map((c) => [c.table, c.query])).toEqual([
      ["sys_db_object", "sys_scope.scope=x_acme^ORDERBYsys_id"],
      ["sys_db_object", "nameINtask^ORDERBYsys_id"],
      [
        "sys_dictionary",
        "nameINtask,x_acme_note,x_acme_ticket^elementISNOTEMPTY^active=true^ORDERBYsys_id",
      ],
      ["sys_choice", "nameINtask,x_acme_note,x_acme_ticket^inactive=false^ORDERBYsys_id"],
    ]);
    expect(calls[0].fields).toBe("name,label,super_class.name,sys_scope.scope");
    expect(calls.every((c) => c.extra?.params?.sysparm_exclude_reference_link === "true")).toBe(true);
  });

  it("reads named tables instead of the scope and refuses unknown ones", async () => {
    const { client, calls } = fakeClient(TASK_FIXTURE);
    const schema = await fetchNativeSchema(client, { scope: "ignored", tables: [" x_acme_ticket ", "x_acme_ticket", ""] });
    expect(schema.scope).toBeUndefined();
    expect(schema.requested).toEqual(["x_acme_ticket"]);
    expect(schema.tables.map((t) => t.name)).toEqual(["task", "x_acme_ticket"]);
    expect(calls[0].query).toBe("nameINx_acme_ticket^ORDERBYsys_id");

    await expect(fetchNativeSchema(client, { tables: ["x_acme_ticket", "nope", "gone"] })).rejects.toThrow(
      "No sys_db_object record for table(s): gone, nope."
    );
  });

  it("refuses names that would change the encoded query", async () => {
    const { client, calls } = fakeClient(TASK_FIXTURE);
    await expect(fetchNativeSchema(client, { tables: ["task^ORnameSTARTSWITHsys"] })).rejects.toThrow(
      'Invalid table "task^ORnameSTARTSWITHsys"'
    );
    await expect(fetchNativeSchema(client, { scope: "x^y" })).rejects.toThrow('Invalid scope "x^y"');
    await expect(fetchNativeSchema(client, {})).rejects.toThrow('Invalid scope ""');
    expect(calls).toEqual([]);
  });

  it("pages every read until an empty page and chunks nameIN lists", async () => {
    const tables = Array.from({ length: 5 }, (_, i) => ({
      name: `x_t${i}`,
      label: `T${i}`,
      "sys_scope.scope": "x_big",
    }));
    const dictionary = tables.flatMap((t) =>
      ["a", "b", "c"].map((element) => ({ name: t.name, element, internal_type: "string" }))
    );
    // Without X-Total-Count only an empty page ends a read.
    const { client, calls } = fakeClient(
      { sys_db_object: tables, sys_dictionary: dictionary, sys_choice: [] },
      undefined,
      { totalCount: false }
    );
    const schema = await fetchNativeSchema(client, { scope: "x_big", pageSize: 2, chunkSize: 2 });
    expect(schema.tables).toHaveLength(5);
    expect(schema.tables.every((t) => t.fields.length === 3)).toBe(true);

    const scopeReads = calls.filter((c) => c.table === "sys_db_object");
    expect(scopeReads.map((c) => c.offset)).toEqual([0, 2, 4, 5]);
    const dictionaryReads = calls.filter((c) => c.table === "sys_dictionary");
    // Three chunks (2 + 2 + 1 tables); 6, 6 and 3 rows at 2 per page.
    expect(dictionaryReads.map((c) => [c.query.split("^")[0], c.offset])).toEqual([
      ["nameINx_t0,x_t1", 0],
      ["nameINx_t0,x_t1", 2],
      ["nameINx_t0,x_t1", 4],
      ["nameINx_t0,x_t1", 6],
      ["nameINx_t2,x_t3", 0],
      ["nameINx_t2,x_t3", 2],
      ["nameINx_t2,x_t3", 4],
      ["nameINx_t2,x_t3", 6],
      ["nameINx_t4", 0],
      ["nameINx_t4", 2],
      ["nameINx_t4", 3],
    ]);
    expect(dictionaryReads.every((c) => c.limit === 2)).toBe(true);
  });

  it("walks a multi-level chain, tolerates a cycle and a parent it cannot read", async () => {
    const { client } = fakeClient({
      sys_db_object: [
        { name: "x_c", "super_class.name": "x_b", "sys_scope.scope": "x_s" },
        { name: "x_b", "super_class.name": "x_a", "sys_scope.scope": "global" },
        { name: "x_a", "super_class.name": "x_c", "sys_scope.scope": "global" },
        { name: "x_d", "super_class.name": "missing_parent", "sys_scope.scope": "x_s" },
        { name: "x_e", "super_class.name": "bad name", "sys_scope.scope": "x_s" },
        { name: "", "sys_scope.scope": "x_s" },
      ],
      sys_dictionary: [],
      sys_choice: [],
    });
    const schema = await fetchNativeSchema(client, { scope: "x_s" });
    expect(schema.tables.map((t) => [t.name, t.superClass ?? null, t.label])).toEqual([
      ["x_a", "x_c", "x_a"],
      ["x_b", "x_a", "x_b"],
      ["x_c", "x_b", "x_c"],
      ["x_d", "missing_parent", "x_d"],
      ["x_e", "bad name", "x_e"],
    ]);
    const { content } = renderNativeTypes(schema);
    expect(content).toContain(" * Extends `missing_parent`, which could not be read");
    expect(content).toContain("export interface x_d {}");
    // An interface cannot extend itself: the loop is cut at its first member by
    // name, which says so, and the rest of the chain still extends.
    expect(content).toContain(
      " * Extends `x_c`, which leads back to this table: the cyclic super_class chain is cut here\n */\n" +
        "export interface x_a {}"
    );
    expect(content).toContain("export interface x_b extends x_a {}");
    expect(content).toContain("export interface x_c extends x_b {}");
    expect(content).not.toMatch(/x_a extends/);
  });

  it("keeps reading past pages the instance shortens below the requested size", async () => {
    const rows = Array.from({ length: 7 }, (_, i) => ({ name: `x_t${i}`, "sys_scope.scope": "x_cap" }));
    const fixture = { sys_db_object: rows, sys_dictionary: [], sys_choice: [] };

    const blind = fakeClient(fixture, undefined, { cap: 3, totalCount: false });
    const schema = await fetchNativeSchema(blind.client, { scope: "x_cap", pageSize: 5 });
    expect(schema.tables).toHaveLength(7);
    // Offsets advance by the rows received, not by the size asked for.
    expect(blind.calls.filter((c) => c.table === "sys_db_object").map((c) => c.offset)).toEqual([0, 3, 6, 7]);

    // With X-Total-Count the read ends on the last row instead of an empty page.
    const counted = fakeClient(fixture, undefined, { cap: 3 });
    expect((await fetchNativeSchema(counted.client, { scope: "x_cap", pageSize: 5 })).tables).toHaveLength(7);
    expect(counted.calls.filter((c) => c.table === "sys_db_object").map((c) => c.offset)).toEqual([0, 3, 6]);
  });

  it("ignores an X-Total-Count it cannot parse", async () => {
    const rows = [{ name: "x_t", "sys_scope.scope": "x_s" }];
    const { client, calls } = fakeClient({ sys_db_object: rows, sys_dictionary: [], sys_choice: [] }, (call) =>
      call.table === "sys_db_object" && call.query.startsWith("sys_scope")
        ? { data: { result: rows.slice(call.offset) }, headers: { "x-total-count": "many" } }
        : undefined
    );
    expect((await fetchNativeSchema(client, { scope: "x_s" })).tables).toHaveLength(1);
    expect(calls.filter((c) => c.table === "sys_db_object").map((c) => c.offset)).toEqual([0, 1]);
  });

  it("gives up on an instance that never runs out of rows", async () => {
    const { client, calls } = fakeClient({ sys_db_object: [], sys_dictionary: [], sys_choice: [] }, () => ({
      data: { result: [{ name: "x_same", "sys_scope.scope": "x_s" }] },
      headers: {},
    }));
    await expect(fetchNativeSchema(client, { scope: "x_s" })).rejects.toThrow(
      `Reading sys_db_object did not finish within ${MAX_PAGES} pages of 500 rows; ` +
        "the instance may be ignoring sysparm_offset."
    );
    expect(calls).toHaveLength(MAX_PAGES);
  });

  it("sorts columns and choice values by code unit, not by locale", async () => {
    const { client } = fakeClient({
      sys_db_object: [{ name: "x_t", "sys_scope.scope": "x_s" }],
      sys_dictionary: ["b", "B", "_c", "a", "Z"].map((element) => ({ name: "x_t", element, internal_type: "string" })),
      sys_choice: ["b", "B", "a", "\u00e9", "f"].map((value) => ({ name: "x_t", element: "b", value })),
    });
    const [table] = (await fetchNativeSchema(client, { scope: "x_s" })).tables;
    expect(table.fields.map((f) => f.element)).toEqual(["B", "Z", "_c", "a", "b"]);
    expect(table.choices.b).toEqual(["B", "a", "b", "f", "\u00e9"]);
  });

  it("normalises raw rows: reference objects, odd choice modes, duplicates and junk", async () => {
    const { client } = fakeClient({
      sys_db_object: [{ name: "x_t", label: { value: "Thing" }, "sys_scope.scope": "x_s" }],
      sys_dictionary: [
        { name: "x_t", element: "f", internal_type: "", choice: "9", max_length: "0" },
        { name: "x_t", element: "f", internal_type: "integer" },
        { name: "x_t", element: "kids", internal_type: "collection" },
        { name: "other", element: "g", internal_type: "string" },
        { name: "x_t", element: "", internal_type: "string" },
        { name: "x_t", element: "n", internal_type: null },
      ],
      sys_choice: [
        { name: "other", element: "f", value: "z" },
        { name: "x_t", element: "", value: "z" },
      ],
    });
    const schema = await fetchNativeSchema(client, { scope: "x_s" });
    expect(schema.tables).toEqual([
      {
        name: "x_t",
        label: "Thing",
        scope: "x_s",
        fields: [
          { element: "f", label: "f", internalType: "string", mandatory: false, choice: "0" },
          { element: "n", label: "n", internalType: "string", mandatory: false, choice: "0" },
        ],
        choices: {},
      },
    ]);
  });

  it("throws NonApiResponseError when the instance answers with a page, not JSON", async () => {
    const html = fakeClient(TASK_FIXTURE, () => ({
      data: "<html>\n  <body>Instance hibernating</body></html>",
      headers: { "content-type": "text/html" },
    }));
    const error = await fetchNativeSchema(html.client, { scope: "x_acme" }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(NonApiResponseError);
    expect((error as Error).message).toContain("content-type: text/html");
    expect((error as Error).message).toContain("<html> <body>Instance hibernating");

    const empty = fakeClient(TASK_FIXTURE, () => ({ data: null, headers: undefined }));
    await expect(fetchNativeSchema(empty.client, { scope: "x_acme" })).rejects.toBeInstanceOf(NonApiResponseError);
    const object = fakeClient(TASK_FIXTURE, () => ({ data: { error: "x" }, headers: { "content-type": 1 } }));
    await expect(fetchNativeSchema(object.client, { scope: "x_acme" })).rejects.toBeInstanceOf(NonApiResponseError);
  });
});

const OPTIONALITY_FIXTURE: Fixture = {
  sys_db_object: [
    { name: "x_base", "sys_scope.scope": "x_s" },
    { name: "x_child", "super_class.name": "x_base", "sys_scope.scope": "x_s" },
    { name: "x_same", "super_class.name": "x_base", "sys_scope.scope": "x_s" },
  ],
  sys_dictionary: [
    { name: "x_base", element: "code", internal_type: "string", mandatory: "true" },
    // Same type, but optional where the parent requires it: TS2430 without Omit.
    { name: "x_child", element: "code", internal_type: "string" },
    { name: "x_same", element: "code", internal_type: "string", mandatory: "true" },
  ],
  sys_choice: [],
};

const CYCLE_FIXTURE: Fixture = {
  sys_db_object: [
    { name: "x_a", "super_class.name": "x_b", "sys_scope.scope": "x_s" },
    { name: "x_b", "super_class.name": "x_a", "sys_scope.scope": "x_s" },
    { name: "x_self", "super_class.name": "x_self", "sys_scope.scope": "x_s" },
    { name: "x_leaf", "super_class.name": "x_a", "sys_scope.scope": "x_s" },
  ],
  sys_dictionary: [
    { name: "x_a", element: "f", internal_type: "string" },
    { name: "x_b", element: "f", internal_type: "integer", mandatory: "true" },
    { name: "x_leaf", element: "f", internal_type: "boolean" },
  ],
  sys_choice: [],
};

/** Type-checks each generated module on its own under `strict`, in memory. */
async function strictDiagnostics(modules: string[]): Promise<string[]> {
  const imported = await import("typescript");
  const ts = (imported as unknown as { default?: typeof imported }).default ?? imported;
  const files = new Map(modules.map((content, i) => [`/gen/types${i}.d.ts`, content]));
  const options = { strict: true, noEmit: true, skipLibCheck: true, target: ts.ScriptTarget.ES2022, types: [] };
  const host = ts.createCompilerHost(options);
  const { getSourceFile, fileExists, readFile } = host;
  // The generated modules live in memory; the standard library comes from disk.
  host.getSourceFile = (fileName, languageVersion, ...rest) => {
    const text = files.get(fileName);
    return text === undefined
      ? getSourceFile.call(host, fileName, languageVersion, ...rest)
      : ts.createSourceFile(fileName, text, languageVersion);
  };
  host.fileExists = (fileName) => files.has(fileName) || fileExists.call(host, fileName);
  host.readFile = (fileName) => files.get(fileName) ?? readFile.call(host, fileName);
  const program = ts.createProgram([...files.keys()], options, host);
  return ts
    .getPreEmitDiagnostics(program)
    .map((d) => `${d.file?.fileName ?? ""} TS${d.code}: ${ts.flattenDiagnosticMessageText(d.messageText, "\n")}`);
}

describe("renderNativeTypes", () => {
  async function render(fixture: Fixture, scope = "x_acme"): Promise<string> {
    const { client } = fakeClient(fixture);
    return (await generateNativeTypes(client, { scope })).content;
  }

  it("renders the expected module for an extended table with choices", async () => {
    const content = await render(TASK_FIXTURE);
    expect(content).toMatchSnapshot();
  });

  it("types columns, unions and inheritance", async () => {
    const content = await render(TASK_FIXTURE);
    expect(content).toContain("export interface task {");
    expect(content).toContain("  number: string;");
    expect(content).toContain("  /** Number — `string` — max length 40 */");
    expect(content).toContain("  state?: 1 | 2 | 10;");
    expect(content).toContain("  /** Assigned to — `reference` — references `sys_user` */");
    expect(content).toContain("  assigned_to?: SysId;");
    expect(content).toContain("  active?: boolean;");
    // A dropdown with --None-- can be empty.
    expect(content).toContain('  severity?: "high" | "low" | "";');
    expect(content).toContain("  opened?: GlideDateTime;");
    // The child narrows the inherited `state` choices, so it omits the parent's.
    expect(content).toContain('export interface x_acme_ticket extends Omit<task, "state"> {');
    expect(content).toContain("  state?: 1 | 7;");
    // Instance text cannot end the comment early.
    expect(content).toContain("/** Body *\\/ end — `html` */");
    expect(content).toContain("export interface Tables {\n  task: task;\n  x_acme_note: x_acme_note;");
    expect(content).toContain('export type TableName = "x_acme_note" | "x_acme_ticket";');
  });

  it("is byte-identical for the same schema whatever order the rows arrive in", async () => {
    const reversed: Fixture = {
      sys_db_object: [...TASK_FIXTURE.sys_db_object].reverse(),
      sys_dictionary: [...TASK_FIXTURE.sys_dictionary].reverse(),
      sys_choice: [...TASK_FIXTURE.sys_choice].reverse(),
    };
    expect(await render(reversed)).toBe(await render(TASK_FIXTURE));
  });

  it("keeps an identical inherited override without Omit, and drops overrides of plain columns", async () => {
    const content = await render({
      sys_db_object: [
        { name: "x_base", "sys_scope.scope": "x_s" },
        { name: "x_child", "super_class.name": "x_base", "sys_scope.scope": "x_s" },
      ],
      sys_dictionary: [
        { name: "x_base", element: "kind", internal_type: "string", choice: "3" },
        { name: "x_base", element: "plain", internal_type: "string" },
        { name: "x_base", element: "hint", internal_type: "string", choice: "2" },
        { name: "x_child", element: "extra", internal_type: "string" },
      ],
      sys_choice: [
        { name: "x_base", element: "kind", value: "a" },
        { name: "x_child", element: "kind", value: "a" },
        { name: "x_child", element: "plain", value: "p" },
        { name: "x_child", element: "hint", value: "h" },
        { name: "x_child", element: "nowhere", value: "n" },
      ],
    }, "x_s");
    expect(content).toContain("export interface x_child extends x_base {");
    expect(content).toContain('  kind?: "a";');
    // A suggestion list (choice 2) stays a string.
    expect(content).toContain("  hint?: string;");
    expect(content).not.toContain("plain?: \"p\"");
    expect(content).not.toContain("nowhere");
  });

  it("keeps string literals for a number column with non-canonical values and quotes odd keys", async () => {
    const content = await render({
      sys_db_object: [{ name: "x_t", "sys_scope.scope": "x_s" }],
      sys_dictionary: [
        { name: "x_t", element: "ratio", internal_type: "decimal", choice: "1" },
        { name: "x_t", element: "level", internal_type: "integer", choice: "1" },
        { name: "x_t", element: "u_odd-name", internal_type: "string" },
        { name: "x_t", element: "empty_ok", internal_type: "string", choice: "1" },
      ],
      sys_choice: [
        { name: "x_t", element: "ratio", value: "0.5" },
        { name: "x_t", element: "level", value: "-1" },
        { name: "x_t", element: "level", value: "01" },
        { name: "x_t", element: "level", value: "1" },
        { name: "x_t", element: "empty_ok", value: "" },
        { name: "x_t", element: "empty_ok", value: "x" },
      ],
    }, "x_s");
    expect(content).toContain('  ratio?: "0.5" | "";');
    // "01" is not how the number 1 is written, so the values stay as stored.
    expect(content).toContain('  level?: "-1" | "01" | "1" | "";');
    expect(content).toContain('  "u_odd-name"?: string;');
    expect(content).toContain('  empty_ok?: "" | "x";');
  });

  it.each([
    [["007", "7"], '"007" | "7"'],
    [["9007199254740993", "1"], '"1" | "9007199254740993"'],
    [["1e3", "2"], '"1e3" | "2"'],
    [["-0", "0"], '"-0" | "0"'],
    [["10", "-3", "0"], "-3 | 0 | 10"],
  ])("emits number literals only for canonical safe integers: %j", async (values, union) => {
    const content = await render({
      sys_db_object: [{ name: "x_t", "sys_scope.scope": "x_s" }],
      sys_dictionary: [{ name: "x_t", element: "level", internal_type: "integer", choice: "3" }],
      sys_choice: values.map((value) => ({ name: "x_t", element: "level", value })),
    }, "x_s");
    expect(content).toContain(`  level?: ${union};`);
  });

  it("omits an inherited column that a child redeclares with other optionality", async () => {
    const content = await render(OPTIONALITY_FIXTURE, "x_s");
    expect(content).toContain('export interface x_child extends Omit<x_base, "code"> {');
    expect(content).toContain("  code?: string;");
    // Same signature as the parent: no Omit needed.
    expect(content).toContain("export interface x_same extends x_base {");
  });

  it("generates a module that compiles under strict tsc", async () => {
    const modules = [
      await render(TASK_FIXTURE),
      await render(OPTIONALITY_FIXTURE, "x_s"),
      await render(CYCLE_FIXTURE, "x_s"),
    ];
    expect(await strictDiagnostics(modules)).toEqual([]);
  });

  it("writes an empty module for a scope with no tables", async () => {
    const result = await generateNativeTypes(fakeClient({ sys_db_object: [], sys_dictionary: [], sys_choice: [] }).client, {
      scope: "x_none",
    });
    expect(result.tableCount).toBe(0);
    expect(result.fieldCount).toBe(0);
    expect(result.content).toContain("export interface Tables {}");
    expect(result.content).toContain("export type TableName = never;");
    expect(result.content).toContain("/** The tables of scope `x_none` (ancestors excluded). */");
  });

  it("counts tables and own fields, and names the request when no scope was used", async () => {
    const { client } = fakeClient(TASK_FIXTURE);
    const result = await generateNativeTypes(client, { tables: ["x_acme_ticket"] });
    expect(result.tableCount).toBe(2);
    expect(result.fieldCount).toBe(6);
    expect(result.content).toContain("/** The tables that were asked for (ancestors excluded). */");
    expect(result.content).toContain('export type TableName = "x_acme_ticket";');
  });
});
