// SPDX-License-Identifier: GPL-3.0-or-later
//
// WP2: secret values never reach a flow document on disk.
import { FLOW_DOCUMENT_SCHEMA, type FlowDocument, type FlowRecord, type FlowStep } from "../flow/flowDocument.js";
import { FLOW_SECRET_TYPES, redactedMarker, redactFlowSecrets } from "../flow/flowSecrets.js";

const id = (n: number) => String(n).padStart(32, "0");

const record = (n: number, fields: Record<string, string>, payloads?: FlowRecord["payloads"]): FlowRecord => ({
  sys_id: id(n),
  fields,
  ...(payloads !== undefined ? { payloads } : {}),
});

const step = (n: number, payloads: FlowRecord["payloads"], children: FlowStep[] = []): FlowStep => ({
  ...record(n, { ui_id: `ui-${n}` }, payloads),
  kind: "action",
  children,
});

function doc(overrides: Partial<FlowDocument> = {}): FlowDocument {
  return {
    schema: FLOW_DOCUMENT_SCHEMA,
    flow: record(1, { name: "Example flow" }),
    triggers: [],
    inputs: [],
    outputs: [],
    variables: [],
    stages: [],
    steps: [],
    warnings: [],
    ...overrides,
  };
}

describe("redactFlowSecrets", () => {
  it("covers the dictionary's credential types", () => {
    expect([...FLOW_SECRET_TYPES].sort()).toEqual(["encrypted_text", "glide_encrypted", "masked", "password", "password2"]);
    expect(redactedMarker("password2")).toBe("<redacted:password2>");
  });

  it("withholds the default value of a secret-typed input, output or variable", () => {
    const source = doc({
      inputs: [
        record(2, { name: "api_key", internal_type: "password2", default_value: "placeholder-secret" }),
        record(3, { name: "label", internal_type: "string", default_value: "Hello" }),
      ],
      outputs: [record(4, { name: "token", internal_type: "masked", default_value: "" })],
      variables: [record(5, { name: "pin", internal_type: "password" })],
    });
    const out = redactFlowSecrets(source);
    expect(out.inputs[0].fields.default_value).toBe("<redacted:password2>");
    expect(out.inputs[1].fields.default_value).toBe("Hello");
    expect(out.outputs[0].fields.default_value).toBe("<redacted:masked>");
    expect(out.variables[0].fields).toEqual({ name: "pin", internal_type: "password" });
    expect(out.warnings).toEqual([
      `input ${id(2)}: default_value withheld (password2)`,
      `output ${id(4)}: default_value withheld (masked)`,
    ]);
    // The source document is left as it was.
    expect(source.inputs[0].fields.default_value).toBe("placeholder-secret");
    expect(source.warnings).toEqual([]);
  });

  it("withholds secret-typed values inside decoded payloads, at any depth", () => {
    const values = [
      { name: "user", value: "admin", parameter: { type: "string" } },
      { name: "secret", value: "placeholder-1", displayValue: "placeholder-1", parameter: { type: "password2" } },
      { name: "nested", value: "", children: [{ name: "key", internal_type: "glide_encrypted", display_value: "x" }] },
      { name: "typed", type: "encrypted_text", default_value: "placeholder-2", value: null },
    ];
    const inner = step(7, { values: { format: "json", value: values } });
    const out = redactFlowSecrets(doc({ steps: [step(6, undefined, [inner])] }));
    const redacted = out.steps[0].children[0].payloads?.values.value as typeof values;
    expect(redacted[0]).toEqual(values[0]);
    expect(redacted[1]).toEqual({
      name: "secret",
      value: "<redacted:password2>",
      displayValue: "<redacted:password2>",
      parameter: { type: "password2" },
    });
    expect(redacted[2].children).toEqual([
      { name: "key", internal_type: "glide_encrypted", display_value: "<redacted:glide_encrypted>" },
    ]);
    expect(redacted[3]).toEqual({ name: "typed", type: "encrypted_text", default_value: "<redacted:encrypted_text>", value: null });
    expect(out.warnings).toEqual([`action ${id(7)}: 4 secret value(s) withheld from values`]);
  });

  it("leaves undecoded and secret-free payloads as they are", () => {
    const unknown = { format: "unknown" as const, value: '{"type":"password","value":"raw"}', reason: "not JSON" };
    const plain = { format: "json" as const, value: { name: "label", value: "Hi" } };
    const flow = record(1, { name: "Example flow" }, { unknown, plain });
    const out = redactFlowSecrets(doc({ flow, triggers: [record(8, {})], stages: [record(9, {})] }));
    expect(out.flow.payloads?.unknown).toBe(unknown);
    expect(out.flow.payloads?.plain).toBe(plain);
    expect(out.triggers[0]).toEqual(record(8, {}));
    expect(out.warnings).toEqual([]);
  });

  it("keeps the warnings the assembler already reported", () => {
    const out = redactFlowSecrets(
      doc({ warnings: ["earlier"], inputs: [record(2, { internal_type: "password", default_value: "p" })] })
    );
    expect(out.warnings).toEqual(["earlier", `input ${id(2)}: default_value withheld (password)`]);
  });

  it("withholds an older-model input value whose input is secret-typed", () => {
    const value = (n: number, element: string, internalType: string, v: string): FlowRecord =>
      record(n, { "variable.element": element, "variable.internal_type": internalType, value: v });
    const plain = value(21, "table_name", "table_name", "incident");
    const owner: FlowStep = { ...step(20, undefined), variableValues: [plain, value(22, "api_key", "password2", "s3cret")] };
    const trigger: FlowRecord = { ...record(23, {}), variableValues: [value(24, "token", "masked", "")] };
    const out = redactFlowSecrets(doc({ steps: [owner], triggers: [trigger] }));
    expect(out.steps[0].variableValues?.[0]).toBe(plain);
    expect(out.steps[0].variableValues?.[1].fields.value).toBe(redactedMarker("password2"));
    expect(JSON.stringify(out)).not.toContain("s3cret");
    expect(out.warnings).toEqual([
      `trigger ${id(23)}: input token withheld (masked)`,
      `action ${id(20)}: input api_key withheld (password2)`,
    ]);
  });

  it("withholds a secret default or input value that was decoded as a gzip payload", () => {
    const zipped = (v: unknown) => ({ format: "base64-gzip-json" as const, value: v });
    const input = record(30, { internal_type: "password2" }, { default_value: zipped({ secret: "hunter2" }) });
    const legacy = record(32, { "variable.element": "key", "variable.internal_type": "masked" }, { value: zipped("hunter3") });
    const owner: FlowStep = { ...step(31, undefined), variableValues: [legacy] };
    const out = redactFlowSecrets(doc({ inputs: [input], steps: [owner] }));
    expect(out.inputs[0].fields.default_value).toBe(redactedMarker("password2"));
    expect(out.inputs[0]).not.toHaveProperty("payloads");
    expect(out.steps[0].variableValues?.[0].fields.value).toBe(redactedMarker("masked"));
    expect(JSON.stringify(out)).not.toMatch(/hunter[23]/);
    expect(out.warnings).toEqual([
      `input ${id(30)}: default_value withheld (password2)`,
      `action ${id(31)}: input key withheld (masked)`,
    ]);
  });
});
