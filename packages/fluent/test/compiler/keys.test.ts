// SPDX-License-Identifier: GPL-3.0-or-later

import { defaultGuid, isGUID, KeysRegistry, type KeyReference, type KeysData } from "../../src/compiler/keys";
import { counter } from "./helpers";

const G = (n: number) => n.toString(16).padStart(32, "0");
const ref = (id: string, keys?: Record<string, string>): KeyReference => ({ getValue: () => id, getKeys: () => keys });
const empty = (): KeysData => ({ explicit: {}, composite: [], deleted: {} });

describe("KeysRegistry", () => {
  it("generates 32-hex GUIDs by default", () => {
    expect(isGUID(defaultGuid())).toBe(true);
    expect(new KeysRegistry().registerExplicitId("t", "k")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("registers explicit keys from an override, a GUID key or a fresh GUID", () => {
    const registry = new KeysRegistry(empty(), counter());
    expect(registry.registerExplicitId("t", "a", G(99))).toBe(G(99));
    expect(registry.registerExplicitId("t", G(98))).toBe(G(98));
    expect(registry.registerExplicitId("t", 7)).toBe(G(1));
    expect(registry.registerExplicitId("t", 7)).toBe(G(1));
    expect(registry.queryExplicitId("other", 7)).toBeUndefined();
  });

  it("revives a deleted key and writes it back without the flag", () => {
    const data = empty();
    data.explicit.a = { table: "t", id: G(1), deleted: true };
    data.composite.push({ table: "c", id: G(2), deleted: true, key: { name: "x" } });
    const registry = new KeysRegistry(data, counter());
    registry.registerExplicitId("t", "a");
    registry.registerCompositeId("c", { name: "x" });
    expect(registry.commit()).toEqual({
      explicit: { a: { table: "t", id: G(1), deleted: false } },
      composite: [{ table: "c", id: G(2), deleted: false, key: { name: "x" } }],
    });
  });

  it("marks unused keys deleted unless their table is kept", () => {
    const data = empty();
    data.explicit = { b: { table: "keep", id: G(1) }, a: { table: "t", id: G(2) } };
    data.composite.push({ table: "c", id: G(3), key: { name: "x" } });
    data.deleted = { t: [G(9)] };
    const commit = new KeysRegistry(data).commit((t) => t === "keep");
    expect(Object.keys(commit.explicit ?? {})).toEqual(["a", "b"]);
    expect(commit).toEqual({
      explicit: { a: { table: "t", id: G(2), deleted: true }, b: { table: "keep", id: G(1) } },
      composite: [{ table: "c", id: G(3), deleted: true, key: { name: "x" } }],
      deleted: { t: [G(9)] },
    });
  });

  it("keeps no table by default", () => {
    const data = empty();
    data.explicit.a = { table: "t", id: G(1) };
    expect(new KeysRegistry(data).commit()).toEqual({ explicit: { a: { table: "t", id: G(1), deleted: true } } });
  });

  it("drops an explicit key that became a composite one", () => {
    const data = empty();
    data.explicit.r = { table: "sys_user_role", id: G(1) };
    const registry = new KeysRegistry(data);
    registry.registerCompositeId("sys_user_role", { name: "x" }, registry.queryExplicitId("sys_user_role", "r"));
    expect(registry.commit()).toEqual({ composite: [{ table: "sys_user_role", id: G(1), key: { name: "x" } }] });
  });

  it("matches composite keys by id, plain values, nested ids and nested keys", () => {
    const registry = new KeysRegistry(empty(), counter());
    const id = registry.registerCompositeId("m2m", { a: ref(G(10), { name: "x" }), b: ref(G(11)), c: "" });
    expect(registry.commit().composite?.[0].key).toEqual({ a: { id: G(10), key: { name: "x" } }, b: G(11), c: "NULL" });
    // Same nested keys, different nested id.
    expect(registry.registerCompositeId("m2m", { a: ref(G(20), { name: "x" }), b: G(11) })).toBe(id);
    // A plain id against a nested key, and a nested key against a plain id.
    expect(registry.queryCompositeId("m2m", { a: G(10), b: ref(G(11), { name: "y" }) })).toBe(id);
    // The guid override matches by id alone.
    expect(registry.registerCompositeId("m2m", { a: "zzz" }, id)).toBe(id);
    expect(registry.queryCompositeId("m2m", { a: "zzz" })).toBeUndefined();
    expect(registry.queryCompositeId("m2m", { missing: "1" })).toBeUndefined();
    expect(registry.queryCompositeId("m2m", { a: ref(G(30), { name: "other" }) })).toBeUndefined();
    expect(() => registry.registerCompositeId("m2m", {})).toThrow("Coalesce keys object is empty.");
  });

  it("resolves a legacy explicit key used as a coalesce value", () => {
    const data = empty();
    data.explicit.legacy = { table: "sys_ui_list", id: G(1) };
    data.composite.push({ table: "sys_ui_list_element", id: G(2), key: { list_id: "legacy", element: "e" } });
    const registry = new KeysRegistry(data);
    expect(registry.queryCompositeId("sys_ui_list_element", { sys_ui_list: G(1), element: "e" })).toBe(G(2));
  });

  it.each([
    ["sys_ws_query_parameter_map", "sys_ws_query_parameter"],
    ["sys_ws_header_map", "sys_ws_header"],
  ])("maps the legacy attr key on %s to %s and ignores rest", (table, target) => {
    const data = empty();
    data.composite.push({ table, id: G(1), key: { attr: G(5), rest: "r", name: "n" } });
    const registry = new KeysRegistry(data);
    expect(registry.queryCompositeId(table, { [target]: G(5), name: "n", rest: "other" })).toBe(G(1));
  });

  it("finds a reference by its keys inside other entries' nested keys", () => {
    const data = empty();
    data.composite.push(
      { table: "plain", id: G(1), key: { name: "p" } },
      { table: "acl_role", id: G(2), key: { acl: G(3), wrapper: { id: G(4), key: { sys_user_role: { id: G(5), key: { name: "itil" } } } } } },
    );
    const registry = new KeysRegistry(data);
    expect(registry.queryCompositeId("sys_user_role", { name: "itil" })).toBe(G(5));
    expect(registry.queryCompositeId("sys_user_role", { name: "admin" })).toBeUndefined();
  });
});
