// SPDX-License-Identifier: GPL-3.0-or-later

import { KeysRegistry } from "../../src/compiler/keys";
import {
  CData,
  RecordFactory,
  RecordId,
  toRecordUpdate,
} from "../../src/compiler/record";
import { counter } from "./helpers";

const G = (n: number) => n.toString(16).padStart(32, "0");
const source = { file: "/app.now.ts", line: 1, column: 1 };

function setup() {
  const registry = new KeysRegistry(undefined, counter());
  return {
    registry,
    factory: new RecordFactory(registry, "x_app", G(100), () => G(200)),
  };
}

describe("RecordFactory", () => {
  it("uses a GUID $id as the sys_id", () => {
    const { factory } = setup();
    const record = factory.createRecord({
      table: "t",
      source,
      installCategory: "update",
      explicitId: G(5),
      fields: {},
    });
    expect(record.id.getValue()).toBe(G(5));
    expect(record.fields.get("sys_update_name")).toBe(`t_${G(5)}`);
  });

  it("coalesces empty values as NULL and keeps a registered $id on a coalesced table", () => {
    const { registry, factory } = setup();
    registry.registerExplicitId("sys_user_role", "r", G(7));
    const role = factory.createRecord({
      table: "sys_user_role",
      source,
      installCategory: "update",
      explicitId: "r",
      fields: { name: "" },
    });
    expect(role.id.getValue()).toBe(G(7));
    expect(role.id.keys).toEqual({ name: "NULL" });
    const contains = factory.createRecord({
      table: "sys_user_role_contains",
      source,
      installCategory: "update",
      fields: { role },
    });
    expect(contains.id.keys).toEqual({ role: role.id, contains: "NULL" });
    const fresh = factory.createRecord({
      table: "sys_user_role",
      source,
      installCategory: "update",
      explicitId: "new",
      fields: { name: 1 },
    });
    // The contains record above took G(1).
    expect(fresh.id.getValue()).toBe(G(2));
  });

  it("resolves references by GUID, $id key, coalesce keys or a fresh GUID", () => {
    const { registry, factory } = setup();
    registry.registerExplicitId("t", "known", G(8));
    const role = factory.createRecord({
      table: "sys_user_role",
      source,
      installCategory: "update",
      fields: { name: "x_app.r" },
    });
    expect(factory.createReference("t", G(9)).getValue()).toBe(G(9));
    expect(factory.createReference("t", "known").getValue()).toBe(G(8));
    expect(factory.createReference("t", "unknown").getValue()).toBe("unknown");
    expect(factory.createReference("t").getValue()).toBe(G(200));
    expect(
      factory
        .createReference("sys_user_role", undefined, { name: "x_app.r" })
        .getValue(),
    ).toBe(role.id.getValue());
    const contains = factory.createReference("sys_user_role_contains", G(9), {
      role,
      contains: role.id,
    });
    expect(contains.getValue()).toBe(G(9));
    expect(contains.keys).toEqual({ role: role.id, contains: role.id });
  });
});

describe("toRecordUpdate", () => {
  it("renders fields in order with CDATA, references and their key attributes", () => {
    const { factory } = setup();
    const role = factory.createRecord({
      table: "sys_user_role",
      source,
      installCategory: "unload",
      fields: { name: "x_app.r" },
    });
    const record = factory.createRecord({
      table: "t",
      source,
      installCategory: "unload",
      explicitId: "k",
      fields: {
        b: new CData("<x>"),
        a: undefined,
        plain: new RecordId("t", G(3)),
        role,
        n: 0,
      },
    });
    record.fields.set(
      "ref",
      factory.createReference("sys_user_role_contains", G(4), { role }),
    );
    const update = toRecordUpdate(record);
    // The role took G(1).
    expect(update).toMatchObject({
      table: "t",
      sysId: G(2),
      installCategory: "unload",
      action: "INSERT_OR_UPDATE",
      path: `unload/t_${G(2)}.xml`,
    });
    expect(update.fields).toEqual([
      { name: "sys_id", value: G(2) },
      {
        name: "sys_scope",
        value: G(100),
        attributes: { display_value: "x_app" },
      },
      { name: "sys_update_name", value: `t_${G(2)}` },
      { name: "a" },
      { name: "b", value: "<x>", cdata: true },
      { name: "n", value: "0" },
      { name: "plain", value: G(3) },
      { name: "ref", value: G(4), attributes: { role: role.id.getValue() } },
      {
        name: "role",
        value: role.id.getValue(),
        attributes: { name: "x_app.r" },
      },
    ]);
  });
});
