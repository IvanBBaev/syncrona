// SPDX-License-Identifier: GPL-3.0-or-later

import type { CompileFluentResult } from "../../src/compiler/compile";
import { compile, messages, only } from "./helpers";

const GUID = "0123456789abcdef0123456789abcdef";
const form = (props: string) => `Form({ table: 'x_snc_bprobe_t', ${props} })\n`;
const section = (content: string, caption = "Main") => `{ caption: '${caption}', content: [${content}] }`;
const column = (elements: string) => `{ layout: 'one-column', elements: [${elements}] }`;
const withElements = (elements: string, props = "view: default_view") =>
  form(`${props}, sections: [${section(column(elements))}]`);

function files(result: CompileFluentResult): Record<string, string> {
  return Object.fromEntries(result.files.map((f) => [f.path, f.content]));
}

/** The content of the only file whose name starts with `prefix`. */
function file(result: CompileFluentResult, prefix: string): string {
  const matches = result.files.filter((f) => f.path.startsWith(`update/${prefix}`));
  expect(matches).toHaveLength(1);
  return matches[0]!.content;
}

/** The `<element>` values of the section file, in order. */
function elements(result: CompileFluentResult): string[] {
  return [...file(result, "sys_ui_section_").matchAll(/<element>([^<]*)<\/element>|<element\/>/g)].map((m) => m[1] ?? "");
}

function tag(content: string, name: string): string[] {
  return [...content.matchAll(new RegExp(`<${name}>([^<]*)</${name}>|<${name}/>`, "g"))].map((m) => m[1] ?? "");
}

describe("Form()", () => {
  it("writes the form and each section as composite files, not as record updates", () => {
    const result = compile(withElements("{ type: 'table_field', field: 'a' }"));
    expect(messages(result)).toEqual([]);
    expect(messages(result, "warning")).toEqual([]);
    for (const table of ["sys_ui_form", "sys_ui_section", "sys_ui_form_section", "sys_ui_element"]) {
      expect(only(result, table)).toEqual([]);
    }
    expect(Object.keys(files(result)).map((p) => p.replace(/[0-9a-f]{32}/, "<id>")).sort()).toEqual([
      "update/sys_ui_form_sections_<id>.xml",
      "update/sys_ui_section_<id>.xml",
    ]);
    const formFile = file(result, "sys_ui_form_sections_");
    expect(formFile).toContain('<view name="NULL" display_value="Default view">Default view</view>');
    expect(file(result, "sys_ui_section_")).toContain('sys_domain="global" table="x_snc_bprobe_t" view="">');
  });

  it("takes the view from a name, a Record() or Now.ref()", () => {
    const byName = file(compile(withElements("", "view: 'v1'")), "sys_ui_form_sections_");
    expect(byName).toMatch(/<view name="v1" display_value="v1">[0-9a-f]{32}<\/view>/);
    const record = compile(
      "const v = Record({ $id: Now.ID['v'], table: 'sys_ui_view', data: { name: 'v2', title: 'View 2' } })\n" +
        "const w = Record({ $id: Now.ID['w'], table: 'sys_ui_view', data: { title: 'Untitled' } })\n" +
        "const u = Record({ $id: Now.ID['u'], table: 'sys_ui_view', data: { name: 'v3', title: '' } })\n" +
        withElements("", "view: v") +
        form("view: w, sections: []") +
        form("view: u, sections: []") +
        "const x = Record({ $id: Now.ID['x'], table: 'sys_ui_view', data: { name: 'v5' } })\n" +
        form("view: x, sections: []"),
    );
    const formFiles = record.files.filter((f) => f.path.includes("form_sections")).map((f) => f.content);
    expect(formFiles[0]).toMatch(/<view name="v2" display_value="View 2">/);
    expect(formFiles[1]).toMatch(/<view>[0-9a-f]{32}<\/view>/);
    expect(formFiles[2]).toMatch(/<view name="v3" display_value="v3">/);
    expect(formFiles[3]).toMatch(/<view name="v5" display_value="v5">/);
    const byKeys = compile(withElements("", "view: Now.ref('sys_ui_view', { name: 'v4' })"));
    expect(file(byKeys, "sys_ui_section_")).toContain('view="v4">');
    const bySysId = compile(withElements("", `view: Now.ref('sys_ui_view', '${GUID}')`));
    expect(file(bySysId, "sys_ui_form_sections_")).toContain(`<view>${GUID}</view>`);
    expect(file(compile(withElements("", "view: 1")), "sys_ui_form_sections_")).toContain(">Default view</view>");
  });

  it("refuses the hard-coded default view and non-string Now.ref() keys", () => {
    const result = compile(withElements("", "view: 'Default view'"));
    expect(messages(result)).toEqual([
      "Do not use the hard-coded string 'Default view' as the view. Use the exported 'default_view' identifier instead: view: default_view",
    ]);
    expect(result.files).toEqual([]);
    expect(messages(compile(withElements("", "view: Now.ref('sys_ui_view', { name: Now.ref('x', 'y') })")))).toEqual([
      "Form(): Now.ref() keys of 'view' must be strings.",
    ]);
  });

  it("joins the roles and writes the user", () => {
    const result = compile(
      "const r = Role({ name: 'x_snc_bprobe.r' })\n" +
        withElements("", "view: default_view, user: 'abel', roles: ['a', r, { name: 'b' }, {}, 1, 'a']"),
    );
    const content = file(result, "sys_ui_form_sections_");
    expect(tag(content, "roles")).toEqual(["a,x_snc_bprobe.r,b,a"]);
    expect(tag(content, "sys_user")).toEqual(["abel"]);
    expect(tag(file(compile(withElements("", "view: default_view, user: 1")), "sys_ui_form_sections_"), "sys_user")).toEqual([""]);
  });

  it("writes two-column blocks between split markers", () => {
    const result = compile(
      form(
        `view: default_view, sections: [${section(
          "{ layout: 'two-column', leftElements: [{ type: 'table_field', field: 'a' }], rightElements: [{ type: 'table_field', field: 'b' }] }",
        )}]`,
      ),
    );
    expect(elements(result)).toEqual([".begin_split", "a", ".split", "b", ".end_split"]);
    expect(tag(file(result, "sys_ui_section_"), "type")).toEqual([".begin_split", "", ".split", "", ".end_split"]);
  });

  it("warns about empty forms, sections, captions and column sides", () => {
    expect(messages(compile(form("view: default_view")), "warning")).toEqual([
      "Form does not have any sections. Add at least one section.",
    ]);
    expect(messages(compile(form("view: default_view, sections: [{}]")), "warning")).toEqual([
      "Section caption cannot be empty.",
      "Section '' has no content blocks. The section will be empty on the form.",
    ]);
    expect(
      messages(compile(form(`view: default_view, sections: [${section("{ layout: 'two-column' }")}]`)), "warning"),
    ).toEqual([
      "Two-column layout block at index 0 in section 'Main' has empty 'leftElements'. Consider using a one-column layout instead.",
      "Two-column layout block at index 0 in section 'Main' has empty 'rightElements'. Consider using a one-column layout instead.",
    ]);
  });

  it("reports invalid sections, blocks and elements", () => {
    expect(messages(compile(form(`view: default_view, sections: [${section("")}, ${section("")}]`)))[0]).toBe(
      "Duplicate section caption 'Main'. Each section must have a unique caption.",
    );
    expect(messages(compile(form(`view: default_view, sections: [${section("1, {}, { layout: 'x' }")}]`)))).toEqual([
      "Content block at index 0 in section 'Main' must be an object.",
      "Layout block requires 'layout' property set to 'one-column' or 'two-column'.",
      "Layout block requires 'layout' property set to 'one-column' or 'two-column'.",
    ]);
    expect(
      messages(compile(form(`view: default_view, sections: [${section("{ layout: 'two-column', leftElements: [1], rightElements: [2] }")}]`))),
    ).toEqual([
      "Invalid element in two-column leftElements of section 'Main'. Each element must be an object.",
      "Invalid element in two-column rightElements of section 'Main'. Each element must be an object.",
    ]);
    expect(messages(compile(withElements("1, {}, { type: 'x' }")))).toEqual([
      "Invalid element in one-column block of section 'Main'. Each element must be an object.",
      "Invalid type ''. Valid types are: 'table_field', 'annotation', 'formatter', 'list'",
      "Invalid type 'x'. Valid types are: 'table_field', 'annotation', 'formatter', 'list'",
    ]);
  });

  it("checks table fields within and across sections", () => {
    expect(messages(compile(withElements("{ type: 'table_field' }")))).toEqual([
      "Table field element requires a 'field' property.",
    ]);
    expect(messages(compile(withElements("{ type: 'table_field', field: 'a' }, { type: 'table_field', field: 'a' }")))).toEqual([
      "Duplicate field 'a' in section 'Main'. Each field should only appear once per section.",
    ]);
    const field = column("{ type: 'table_field', field: 'a' }");
    const across = compile(form(`view: default_view, sections: [${section(field, "One")}, ${section(field, "Two")}]`));
    expect(messages(across)).toEqual([]);
    expect(messages(across, "warning")).toEqual([
      "Field 'a' already appears in another section. Duplicate fields across sections may cause unexpected behavior on the form.",
    ]);
  });

  it("writes annotations with their type", () => {
    const result = compile(
      `const t = Record({ $id: Now.ID['t'], table: 'sys_ui_annotation_type', data: { name: 'T' } })\n` +
        withElements(
          [
            "{ type: 'annotation', annotationId: Now.ID['a1'], text: 'x', isPlainText: false, annotationType: AnnotationType.Info_Box_Red }",
            "{ type: 'annotation', annotationId: Now.ID['a2'], annotationType: 'Section_Details' }",
            `{ type: 'annotation', annotationId: Now.ID['a3'], annotationType: '${GUID}' }`,
            "{ type: 'annotation', annotationId: Now.ID['a4'], annotationType: t }",
          ].join(", "),
        ),
    );
    expect(messages(result)).toEqual([]);
    const content = file(result, "sys_ui_section_");
    expect(tag(content, "is_plain_text")).toEqual(["false", "true", "true", "true"]);
    expect(tag(content, "text")).toEqual(["x", "", "", ""]);
    const types = tag(content, "type");
    expect(types.slice(0, 3)).toEqual(["823f88a80f930000b12e6903cfe01209", "19756e5ec3313000bac1addbdfba8f18", GUID]);
    expect(types.slice(4)).toEqual(["annotation", "annotation", "annotation", "annotation"]);
    expect(types[3]).toMatch(/^[0-9a-f]{32}$/);
  });

  it("reports invalid annotations", () => {
    expect(messages(compile(withElements("{ type: 'annotation', annotationId: 'a' }, { type: 'annotation' }")))).toEqual([
      "'annotationId' must be a Now.ID['...'] reference.",
      "'annotationId' must be a Now.ID['...'] reference.",
    ]);
    const result = compile(withElements("{ type: 'annotation', annotationId: Now.ID['a'], annotationType: 'nope' }"));
    expect(messages(result)).toEqual(["'annotationType' must be a valid GUID or a Record<'sys_ui_annotation_type'>. Received: 'nope'"]);
    expect(tag(file(result, "sys_ui_section_"), "type")).toEqual(["", "annotation"]);
  });

  it("writes formatters by name, record, constant or sys_id", () => {
    const result = compile(
      "const f = Record({ $id: Now.ID['f'], table: 'sys_ui_formatter', data: { formatter: 'mine.xml' } })\n" +
        "const g = Record({ $id: Now.ID['g'], table: 'sys_ui_formatter', data: { name: 'G' } })\n" +
        withElements(
          [
            "{ type: 'formatter', formatterRef: 'Activities_Filtered' }",
            "{ type: 'formatter', formatterRef: Formatter.Attached_Knowledge }",
            `{ type: 'formatter', formatterRef: '${GUID}', formatterName: 'custom.xml' }`,
            `{ type: 'formatter', formatterRef: '${GUID}' }`,
            "{ type: 'formatter', formatterRef: f }",
            "{ type: 'formatter', formatterRef: g }",
            "{ type: 'formatter', formatterName: 'bare.xml' }",
          ].join(", "),
        ),
    );
    expect(messages(result)).toEqual([]);
    const content = file(result, "sys_ui_section_");
    expect(elements(result)).toEqual(["activity.xml", "attached_knowledge", "custom.xml", "", "mine.xml", "", "bare.xml"]);
    expect(tag(content, "sys_ui_formatter").slice(0, 4)).toEqual([
      "444ea5c6bf310100e628555b3f0739d6",
      "cfa76e850a0a0b1f01446f67c8538d00",
      GUID,
      GUID,
    ]);
    expect(tag(content, "sys_ui_formatter")[6]).toBe("");
  });

  it("reports an invalid formatter reference and keeps the element", () => {
    const result = compile(withElements("{ type: 'formatter', formatterRef: 'nope' }"));
    expect(messages(result)).toEqual(["'formatterRef' must be a valid GUID or a Record<'sys_ui_formatter'>. Received: 'nope'"]);
    expect(tag(file(result, "sys_ui_section_"), "type")).toEqual(["formatter"]);
  });

  it("writes 12M, M2M and custom lists", () => {
    const result = compile(
      "const rel = Record({ $id: Now.ID['rel'], table: 'sys_relationship', data: { name: 'R' } })\n" +
        withElements(
          [
            "{ type: 'list', listType: '12M', listRef: 'task_sla.task' }",
            "{ type: 'list', listType: 'M2M', listRef: 'm.p' }",
            "{ type: 'list', listType: 'custom', listRef: rel }",
            `{ type: 'list', listType: 'custom', listRef: '${GUID}' }`,
          ].join(", "),
        ),
    );
    expect(messages(result)).toEqual([]);
    const names = elements(result);
    expect(names.slice(0, 2)).toEqual(["12M.x_snc_bprobe_t.task_sla.task", "M2M.x_snc_bprobe_t.m.p"]);
    expect(names[2]).toMatch(/^REL\.x_snc_bprobe_t\.REL:[0-9a-f]{32}$/);
    expect(names[3]).toBe(`REL.x_snc_bprobe_t.REL:${GUID}`);
  });

  it("reports invalid lists", () => {
    expect(
      messages(
        compile(
          withElements(
            [
              "{ type: 'list', listType: 'x' }",
              "{ type: 'list' }",
              "{ type: 'list', listType: 'custom', listRef: 'nope' }",
              "{ type: 'list', listType: 'custom' }",
              "{ type: 'list', listType: '12M', listRef: 1 }",
              "{ type: 'list', listType: 'M2M', listRef: 'a.b.c' }",
              "{ type: 'list', listType: 'M2M', listRef: '.b' }",
              "{ type: 'list', listType: 'M2M', listRef: 'a.' }",
            ].join(", "),
          ),
        ),
      ),
    ).toEqual([
      "List element requires 'listType' set to '12M', 'M2M', or 'custom'.",
      "List element requires 'listType' set to '12M', 'M2M', or 'custom'.",
      "'listRef' must be a valid GUID or a Record<'sys_relationship'>. Received: 'nope'",
      "Custom list requires 'listRef' with a Record<'sys_relationship'> reference or a sys_relationship sys_id string (GUID).",
      "List element requires 'listRef' as a dot-notation string '<table_name>.<column_name>' for '12M' type.",
      "Invalid 'listRef' format 'a.b.c'. Expected '<table_name>.<column_name>' (e.g., 'task_sla.task').",
      "Invalid 'listRef' format '.b'. Expected '<table_name>.<column_name>' (e.g., 'task_sla.task').",
      "Invalid 'listRef' format 'a.'. Expected '<table_name>.<column_name>' (e.g., 'task_sla.task').",
    ]);
  });
});

describe("SDK constants", () => {
  it("refuses an unknown member", () => {
    expect(messages(compile(withElements("{ type: 'formatter', formatterRef: Formatter.Nope }")))).toEqual([
      "'Formatter.Nope' is not a known Formatter value.",
    ]);
  });

  it("does not treat a local object or another expression as a constant", () => {
    for (const ref of ["names.field", "(names).field", "Record.field"]) {
      const result = compile("const names = { field: 'a' }\n" + withElements(`{ type: 'formatter', formatterRef: ${ref} }`));
      expect(messages(result)).toEqual(["Only `Now.ID[...]` member access is supported in Fluent sources."]);
    }
  });
});
