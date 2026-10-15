// SPDX-License-Identifier: GPL-3.0-or-later

import ts from "typescript";
import { KeysFileError, parseKeysFile, writeKeysFile } from "../../src/compiler/keysFile";

const wrap = (body: string) => `declare global { namespace Now { namespace Internal { interface Keys extends KeysRegistry { ${body} } } } }`;

describe("keys.ts reader", () => {
  it("reads explicit, composite and deleted entries", () => {
    const text = wrap(`
      explicit: { a: { table: 't'; id: '1'; deleted: false }; 'b-c': { table: 't'; id: \`2\` }; 3: { table: 't'; id: '3' } }
      composite: [{ table: 'c'; id: '4'; deleted: true; key: { name: 'x'; ref: { id: '5'; key: { name: 'y' } } } }]
      deleted: { t: ['6', '7'] }
    `);
    expect(parseKeysFile(ts, text)).toEqual({
      explicit: { a: { table: "t", id: "1", deleted: false }, "b-c": { table: "t", id: "2" }, 3: { table: "t", id: "3" } },
      composite: [{ table: "c", id: "4", deleted: true, key: { name: "x", ref: { id: "5", key: { name: "y" } } } }],
      deleted: { t: ["6", "7"] },
    });
    expect(parseKeysFile(ts, wrap(""))).toEqual({ explicit: {}, composite: [], deleted: {} });
  });

  it.each([
    ["export {}", "no `global` namespace"],
    ["declare global { namespace Now {} }", "no `Internal` namespace"],
    ["declare global { namespace Now { namespace Internal {} } }", "no `Keys` interface"],
    [wrap("m(): void"), "unsupported member in Keys"],
    [wrap("[k: string]: string"), "unsupported member in Keys"],
    [wrap("explicit"), "unsupported member in Keys"],
    [wrap("['a']: 1"), "unsupported property name in Keys"],
    [wrap("explicit: string"), "unsupported type at Keys.explicit"],
    [wrap("explicit: -1"), "unsupported type at Keys.explicit"],
    [wrap("explicit: []"), "explicit must be an object"],
    [wrap("explicit: { a: { table: 1; id: '1' } }"), "explicit.a needs a string table and id"],
    [wrap("explicit: { a: 'x' }"), "explicit.a needs a string table and id"],
    [wrap("explicit: { a: { table: 't'; id: '1'; deleted: 1 } }"), "explicit.a.deleted must be a boolean"],
    [wrap("composite: {}"), "composite must be a tuple"],
    [wrap("composite: [{ table: 't'; id: '1' }]"), "composite[0].key must be an object"],
    [wrap("composite: [{ table: 't'; id: '1'; key: { a: 1 } }]"), "composite[0].key.a must be a string or { id, key }"],
    [wrap("deleted: []"), "deleted must be an object"],
    [wrap("deleted: { t: 'x' }"), "deleted.t must be a tuple of strings"],
    [wrap("deleted: { t: [1] }"), "deleted.t must be a tuple of strings"],
  ])("rejects %s", (text, message) => {
    expect(() => parseKeysFile(ts, text)).toThrow(new KeysFileError(message));
  });

  it("names the error", () => {
    expect(new KeysFileError("x")).toMatchObject({ name: "KeysFileError", message: "Keys registry is malformed: x" });
  });
});

describe("keys.ts writer", () => {
  it("writes an empty registry", () => {
    expect(writeKeysFile({})).toContain("interface Keys extends KeysRegistry {}\n");
  });

  it("quotes and escapes strings the way prettier does", () => {
    const text = writeKeysFile({ deleted: { "a-b": ["it's", 'say "hi"', "a'b\"c'", "\\\b\f\n\r\t\v\0\x01  "], $ok_1: [] } });
    expect(text).toContain(`'a-b': ["it's", 'say "hi"', "a'b\\"c'", '\\\\\\b\\f\\n\\r\\t\\v\\0\\x01\\u2028\\u2029']`);
    expect(text).toContain("$ok_1: []");
  });

  it("wraps arrays that do not fit in 120 columns and writes non-string scalars", () => {
    const ids = Array.from({ length: 4 }, (_, i) => String(i).repeat(32));
    const text = writeKeysFile({ deleted: { t: ids, n: [1, true] as unknown as string[] }, composite: [] });
    expect(text).toContain(`t: [\n${ids.map((id) => `                        '${id}',\n`).join("")}                    ]`);
    expect(text).toContain("n: [1, true]");
    expect(text).toContain("composite: []");
  });

  it("skips undefined properties and renders an object without them as {}", () => {
    const text = writeKeysFile({ explicit: { a: { table: "t", id: "1", deleted: undefined } }, deleted: {} });
    expect(text).toContain("a: {\n                        table: 't'\n                        id: '1'\n                    }");
    expect(text).toContain("deleted: {}");
  });
});
