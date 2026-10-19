// SPDX-License-Identifier: GPL-3.0-or-later

import fs from "node:fs";
import path from "node:path";
import { compileFluentProject } from "../../src/compiler/compile";
import { compile, counter, IMPORT, makeProject, messages, only } from "./helpers";

const SI = (extra = "") => `ScriptInclude({ $id: Now.ID['si'], name: 'Si', script: 's'${extra} })\n`;

describe("Fluent evaluator", () => {
  it("accepts the supported expression forms", () => {
    const result = compile(
      `import type { Foo } from './types'
import './side-effect'
import { type Bar, Property as P } from '@servicenow/sdk/core'
interface Local { a: string }
type Alias = string
const name = ('x_snc_bprobe.a' as string)
const description = 'd' satisfies string
const value = <number>-1.5
export const roles = { read: ['r1', 'r1', 'r2'], 'write': [] }
P({ $id: Now.ID.p1, name, description, value: +2, isPrivate: true, ignoreCache: false, roles, choices: ['a', \`b\`] })
Property({ $id: Now.ID[7], name: 'x_snc_bprobe.b', value: value!, type: undefined })
const numbered = { 1: 'one' }
const ref = Now.ref('sys_user_role', { name: 'admin' })
const ref2 = Now.ref('sys_user_role', '0123456789abcdef0123456789abcdef')
const ref3 = Now.ref('sys_user_role', 'key', { name: 'admin' })
`,
    );
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_properties")).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "x_snc_bprobe.a", description: "d", value: "2", is_private: "true", read_roles: "r1,r2", write_roles: "", choices: "a,b" }),
      expect.objectContaining({ name: "x_snc_bprobe.b", value: "-1.5", type: "string" }),
    ]));
  });

  it.each([
    ["import P from 'x'\n", "Only named imports are supported in Fluent sources."],
    ["import * as N from 'x'\n", "Only named imports are supported in Fluent sources."],
    ["let x = 1\n", "Only `const` declarations are supported in Fluent sources."],
    ["const { a } = { a: 1 }\n", "Destructuring declarations are not supported in Fluent sources."],
    ["declare const x: string\n", "'x' has no initializer."],
    ["function f() {}\n", "Unsupported statement in a Fluent source: FunctionDeclaration."],
    ["const a = b\n", "Cannot resolve 'b'."],
    ["const a = Role\n", "'Role' is an SDK API; call it instead of referencing it."],
    ["const a = b\nconst b = a\n", "'a' refers to itself."],
    ["import { x } from 'lodash'\nconst a = x\n", "Cannot evaluate 'x' imported from 'lodash'; only project files, @servicenow/sdk/core and @servicenow/sdk/automation can be imported."],
    ["import { x } from './missing'\nconst a = x\n", "Cannot find module './missing'."],
    ["const a = ~1\n", "Unsupported expression in a Fluent source: PrefixUnaryExpression."],
    ["const a = `x${~1}`\n", "Unsupported expression in a Fluent source: PrefixUnaryExpression."],
    ["const o = { variables: { a: 1 } }\nconst a = o.variables.a\n", "Only `Now.ID[...]` member access is supported in Fluent sources."],
    ["const a = [...[1]]\n", "Spread elements and holes are not supported in Fluent arrays."],
    ["const a = [1, , 2]\n", "Spread elements and holes are not supported in Fluent arrays."],
    ["const a = { ...{} }\n", "Only plain properties are supported in Fluent objects (no spreads, methods or accessors)."],
    ["const a = { m() {} }\n", "Only plain properties are supported in Fluent objects (no spreads, methods or accessors)."],
    ["const a = { ['k']: 1 }\n", "Computed property names are not supported in Fluent objects."],
    ["const a = { b }\n", "Cannot resolve 'b'."],
    ["const a = Now.ID[true]\n", "Expected a string literal."],
    ["const a = Now.other.x\n", "Only `Now.ID[...]` member access is supported in Fluent sources."],
    ["const a = Now.include('a', 'b')\n", "Now.include() takes one string path."],
    ["const a = Now.include(1)\n", "Now.include() takes one string path."],
    ["const a = Now.include('./nope.js')\n", "Now.include(): file not found: ./nope.js"],
    ["const a = Now.ref(1)\n", "Now.ref() needs a table name as its first argument."],
    ["const a = Now.ref()\n", "Now.ref() needs a table name as its first argument."],
    ["const a = Now.ref('t', 1)\n", "Now.ref() takes (table, keys) or (table, guid, keys?)."],
    ["const a = Now.ref('t', 'g', 1)\n", "Now.ref() takes (table, keys) or (table, guid, keys?)."],
    ["const a = Now.ref('t', {}, {})\n", "Now.ref() takes (table, keys) or (table, guid, keys?)."],
    ["foo()\n", "Only calls of @servicenow/sdk/core APIs, Now.include(), Now.ref(), Now.attach() and Now.del() are supported in Fluent sources."],
    ["console.log(1)\n", "Only calls of @servicenow/sdk/core APIs, Now.include(), Now.ref(), Now.attach() and Now.del() are supported in Fluent sources."],
  ])("rejects %j", (source, message) => {
    const result = compile(source);
    expect(result.ok).toBe(false);
    expect(messages(result)).toEqual([message]);
  });

  it("reports a failed binding once and keeps compiling the rest", () => {
    const result = compile(`const a = b\nconst c = a\nconst d = a\n${SI()}`);
    expect(messages(result)).toEqual(["Cannot resolve 'b'."]);
    expect(result.diagnostics[0]).toMatchObject({ line: 2, column: 11 });
    expect(only(result, "sys_script_include")).toHaveLength(1);
  });

  it("resolves exported consts from project files", () => {
    const result = compile(
      `import { roleName } from './names'
import { script } from './more.js'
import { admin } from './shared.now'
${SI(", description: roleName")}
Role({ name: 'x_snc_bprobe.user', containsRoles: [admin] })
Property({ $id: Now.ID['p'], name: 'x_snc_bprobe.p', value: script })
`,
      {
        "src/fluent/names.ts": "export const roleName = 'from names'\n",
        "src/fluent/more.ts": "export const script = 'from more'\n",
        "src/fluent/shared.now.ts": `${IMPORT}export const admin = Role({ name: 'x_snc_bprobe.admin' })\n`,
      },
    );
    expect(messages(result)).toEqual([]);
    expect(only(result, "sys_script_include")[0].description).toBe("from names");
    expect(only(result, "sys_properties")[0].value).toBe("from more");
    // shared.now.ts is a source too, but its role is compiled once.
    expect(only(result, "sys_user_role").map((r) => r.name).sort()).toEqual(["x_snc_bprobe.admin", "x_snc_bprobe.user"]);
    expect(only(result, "sys_user_role_contains")).toHaveLength(1);
  });

  it("rejects a const another file does not export", () => {
    const result = compile("import { hidden } from './names'\nconst a = hidden\n", { "src/fluent/names.ts": "const hidden = 1\n" });
    expect(messages(result)).toEqual(["'./names' has no exported const 'hidden'."]);
  });

  it("reports a declaration error in an imported file against that file", () => {
    const result = compile("import { a } from './bad'\nconst b = a\n", { "src/fluent/bad.ts": "let x = 1\nexport const a = 1\n" });
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ message: "Only `const` declarations are supported in Fluent sources.", file: expect.stringMatching(/bad\.ts$/) }),
    ]);
  });

  it("does not swallow errors that are not compile errors", () => {
    const projectDir = makeProject({ "src/fluent/app.now.ts": "import { a } from './dir.ts'\nconst b = a\n" });
    fs.mkdirSync(path.join(projectDir, "src/fluent/dir.ts"));
    expect(() => compileFluentProject({ projectDir, generateGuid: counter() })).toThrow(/EISDIR/);
  });
});
