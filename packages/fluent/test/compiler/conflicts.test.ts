// SPDX-License-Identifier: GPL-3.0-or-later

import { compileFluentProject } from "../../src/compiler/compile";
import { counter, IMPORT, makeProject, messages } from "./helpers";

function build(files: Record<string, string>) {
  return compileFluentProject({
    projectDir: makeProject(files),
    generateGuid: counter(),
  });
}

describe("key-conflict detection", () => {
  it("reports two definitions of one record from different files", () => {
    const role = `${IMPORT}Role({ name: 'x_snc_bprobe.admin' })\n`;
    const result = build({
      "src/fluent/a.now.ts": role,
      "src/fluent/b.now.ts": `\n${role}`,
    });
    expect(result.ok).toBe(false);
    expect(result.keysText).toBeUndefined();
    const [message] = messages(result);
    expect(message).toMatch(
      /^Record "sys_user_role\.[0-9a-f]{32}" is defined 2 times in the project:\n/,
    );
    expect(message).toContain(
      "\n    1. src/fluent/a.now.ts:2\n    2. src/fluent/b.now.ts:3",
    );
  });

  it("reports one $id used twice in a table", () => {
    const source = `${IMPORT}Property({ $id: 'p', name: 'x_snc_bprobe.a', value: '1' })\nProperty({ $id: 'p', name: 'x_snc_bprobe.b', value: '2' })\n`;
    const result = build({ "src/fluent/a.now.ts": source });
    expect(result.ok).toBe(false);
    expect(messages(result)).toEqual([
      expect.stringMatching(
        /^Record "sys_properties\.[0-9a-f]{32}" is defined 2 times in the project:\n    1\. src\/fluent\/a\.now\.ts:2\n    2\. src\/fluent\/a\.now\.ts:3$/,
      ),
    ]);
  });

  it("reports one $id used for records of different tables", () => {
    const source = `${IMPORT}Property({ $id: 'k', name: 'x_snc_bprobe.a', value: '1' })\nRole({ $id: 'k', name: 'x_snc_bprobe.r' })\n`;
    const result = build({ "src/fluent/a.now.ts": source });
    expect(result.ok).toBe(false);
    expect(result.keysText).toBeUndefined();
    expect(messages(result)).toEqual([
      'Explicit key "k" is defined multiple times in the project:\n    1. [sys_properties] src/fluent/a.now.ts:2\n    2. [sys_user_role] src/fluent/a.now.ts:3',
    ]);
  });

  it("does not flag distinct records or the children of one call", () => {
    const source = `${IMPORT}Role({ name: 'x_snc_bprobe.a' })\nRole({ name: 'x_snc_bprobe.b' })\nAcl({ $id: 'acl', type: 'record', operation: 'read', table: 'incident', roles: ['x_snc_bprobe.a', 'x_snc_bprobe.a', 'x_snc_bprobe.b'] })\n`;
    const result = build({ "src/fluent/a.now.ts": source });
    expect(messages(result)).toEqual([]);
    expect(result.ok).toBe(true);
    expect(result.keysText).toBeDefined();
  });
});
