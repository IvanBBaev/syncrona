// SPDX-License-Identifier: GPL-3.0-or-later
//
// Form() → sys_ui_form, a sys_ui_section per section (linked by a
// sys_ui_form_section) and a sys_ui_element per field, annotation, formatter,
// list or column split, with a sys_ui_annotation per annotation. Like the SDK's
// FormPlugin, the form and its section links are written as one
// `sys_ui_form_sections_<id>` file and each section with its elements and
// annotations as one `sys_ui_section_<id>` file, not as record updates.

import { isGUID } from "../keys";
import type { FluentValue } from "../evaluate";
import { RecordId, type CompiledRecord } from "../record";
import { ANNOTATION_TYPE, FORMATTER } from "../sdkConstants";
import { attributes, element } from "./list";
import { Options, lookup, roleRecord, type ArtefactSpec, type BuildContext } from "./shared";

/** The platform's default view, the id of the `default_view` reference. */
const DEFAULT_VIEW = "Default view";
const SECTION = ["caption", "header", "title", "content"];
const BLOCK = ["layout", "elements", "leftElements", "rightElements"];
const ELEMENT = [
  "type",
  "field",
  "annotationId",
  "text",
  "isPlainText",
  "annotationType",
  "formatterName",
  "formatterRef",
  "listType",
  "listRef",
];
const ELEMENT_TYPES = ["table_field", "annotation", "formatter", "list"];
/** The element name of each predefined formatter (its `formatter` column). */
const FORMATTER_ELEMENTS: Record<string, string> = {
  [FORMATTER.Activities_Filtered!]: "activity.xml",
  [FORMATTER.Attached_Knowledge!]: "attached_knowledge",
};

type View = RecordId | CompiledRecord | string;

interface ResolvedView {
  sysId: string;
  name: string;
  displayValue: string;
}

interface Section {
  record: CompiledRecord;
  caption: string;
  elements: CompiledRecord[];
  annotations: CompiledRecord[];
}

/** The state of one Form() build: its records and the fields seen so far. */
class FormBuilder {
  readonly sections: Section[] = [];
  readonly formSections: CompiledRecord[] = [];
  private readonly formFields = new Set<string>();

  constructor(
    private readonly o: Options,
    private readonly ctx: BuildContext,
    private readonly table: string,
    private readonly view: View,
  ) {}

  private warn(message: string, at: FluentValue): void {
    this.ctx.report("warning", message, at.loc);
  }

  private fail(message: string, at: FluentValue): void {
    this.ctx.report("error", message, at.loc);
  }

  section(form: CompiledRecord, item: FluentValue, index: number, captions: Set<string>): void {
    const s = this.o.sub(item, `sections[${index}].`, SECTION);
    const caption = s.string("caption") ?? "";
    const captionAt = s.get("caption") ?? item;
    if (!caption.trim()) this.warn("Section caption cannot be empty.", captionAt);
    else if (captions.has(caption)) {
      this.fail(`Duplicate section caption '${caption}'. Each section must have a unique caption.`, captionAt);
    } else captions.add(caption);
    const record = this.ctx.factory.createRecord({
      table: "sys_ui_section",
      source: item.loc,
      installCategory: this.o.installCategory,
      emit: false,
      fields: {
        name: this.table,
        caption,
        title: s.boolean("title") ?? false,
        header: s.boolean("header") ?? false,
        view: this.view,
        sys_domain: "global",
      },
    });
    const section: Section = { record, caption, elements: [], annotations: [] };
    this.sections.push(section);
    this.formSections.push(
      this.ctx.factory.createRecord({
        table: "sys_ui_form_section",
        source: item.loc,
        installCategory: this.o.installCategory,
        emit: false,
        fields: { sys_ui_form: form, sys_ui_section: record, position: index },
      }),
    );
    const blocks = s.array("content") ?? [];
    if (blocks.length === 0) {
      this.warn(`Section '${caption}' has no content blocks. The section will be empty on the form.`, s.get("content") ?? item);
    }
    const fields = new Set<string>();
    blocks.forEach((block, i) => this.block(section, fields, block, i));
  }

  private block(section: Section, fields: Set<string>, value: FluentValue, index: number): void {
    const { caption } = section;
    if (value.kind !== "object") {
      this.fail(`Content block at index ${index} in section '${caption}' must be an object.`, value);
      return;
    }
    const b = new Options(this.o.call, value, { properties: BLOCK }, this.ctx, `content[${index}].`);
    const layout = b.get("layout");
    const elements = (key: string): FluentValue[] => {
      const v = b.get(key);
      return v?.kind === "array" ? v.items : [];
    };
    const add = (items: FluentValue[], context: string): void => {
      for (const item of items) {
        if (item.kind === "object") this.element(section, fields, item);
        else this.fail(`Invalid element in ${context} of section '${caption}'. Each element must be an object.`, item);
      }
    };
    if (layout?.kind === "string" && layout.value === "one-column") {
      add(elements("elements"), "one-column block");
    } else if (layout?.kind === "string" && layout.value === "two-column") {
      const left = elements("leftElements");
      const right = elements("rightElements");
      for (const [side, items] of [["leftElements", left], ["rightElements", right]] as const) {
        if (items.length === 0) {
          this.warn(
            `Two-column layout block at index ${index} in section '${caption}' has empty '${side}'. Consider using a one-column layout instead.`,
            b.get(side) ?? value,
          );
        }
      }
      this.uiElement(section, value, ".begin_split", ".begin_split");
      add(left, "two-column leftElements");
      this.uiElement(section, value, ".split", ".split");
      add(right, "two-column rightElements");
      this.uiElement(section, value, ".end_split", ".end_split");
    } else {
      this.fail("Layout block requires 'layout' property set to 'one-column' or 'two-column'.", layout ?? value);
    }
  }

  private uiElement(section: Section, at: FluentValue, name: string, type = "", formatter = ""): void {
    section.elements.push(
      this.ctx.factory.createRecord({
        table: "sys_ui_element",
        source: at.loc,
        installCategory: this.o.installCategory,
        emit: false,
        fields: {
          sys_ui_section: section.record,
          element: name,
          position: section.elements.length,
          type,
          sys_ui_formatter: formatter,
        },
      }),
    );
  }

  private element(section: Section, fields: Set<string>, value: FluentValue & { kind: "object" }): void {
    const e = new Options(this.o.call, value, { properties: ELEMENT }, this.ctx, "elements[].");
    const type = e.get("type");
    const typeName = type?.kind === "string" ? type.value : "";
    if (!ELEMENT_TYPES.includes(typeName)) {
      this.fail(`Invalid type '${typeName}'. Valid types are: ${ELEMENT_TYPES.map((t) => `'${t}'`).join(", ")}`, type ?? value);
      return;
    }
    const str = (key: string): string | undefined => {
      const v = e.get(key);
      return v?.kind === "string" ? v.value : undefined;
    };
    if (typeName === "table_field") {
      const field = str("field") ?? "";
      if (!field) {
        this.fail("Table field element requires a 'field' property.", e.get("field") ?? value);
        return;
      }
      if (fields.has(field)) {
        this.fail(`Duplicate field '${field}' in section '${section.caption}'. Each field should only appear once per section.`, value);
      }
      fields.add(field);
      if (this.formFields.has(field)) {
        this.warn(
          `Field '${field}' already appears in another section. Duplicate fields across sections may cause unexpected behavior on the form.`,
          value,
        );
      }
      this.formFields.add(field);
      this.uiElement(section, value, field);
    } else if (typeName === "annotation") {
      this.annotation(section, e, value);
    } else if (typeName === "formatter") {
      this.formatter(section, e, value, str("formatterName") ?? "");
    } else {
      this.list(section, e, value);
    }
  }

  private annotation(section: Section, e: Options, value: FluentValue): void {
    const id = e.get("annotationId");
    if (id?.kind !== "nowId") {
      this.fail("'annotationId' must be a Now.ID['...'] reference.", id ?? value);
      return;
    }
    const text = e.get("text");
    const plain = e.get("isPlainText");
    const record = this.ctx.factory.createRecord({
      table: "sys_ui_annotation",
      source: value.loc,
      installCategory: this.o.installCategory,
      emit: false,
      explicitId: id.key,
      fields: {
        text: text?.kind === "string" ? text.value : "",
        is_plain_text: plain?.kind === "boolean" ? plain.value : true,
        type: this.guid(e.get("annotationType"), ANNOTATION_TYPE, "annotationType", "sys_ui_annotation_type"),
      },
    });
    section.annotations.push(record);
    this.uiElement(section, value, record.id.getValue(), "annotation");
  }

  private formatter(section: Section, e: Options, value: FluentValue, explicitName: string): void {
    const ref = e.get("formatterRef");
    const formatter = this.guid(ref, FORMATTER, "formatterRef", "sys_ui_formatter");
    const recordName = ref?.kind === "call" ? this.ctx.recordOf(ref).fields.get("formatter") : undefined;
    const name =
      explicitName ||
      (typeof recordName === "string" ? recordName : "") ||
      (formatter ? (lookup(FORMATTER_ELEMENTS, formatter) ?? "") : "");
    this.uiElement(section, value, name, "formatter", formatter);
  }

  private list(section: Section, e: Options, value: FluentValue): void {
    const listType = e.get("listType");
    const kind = listType?.kind === "string" ? listType.value : "";
    if (!["12M", "M2M", "custom"].includes(kind)) {
      this.fail("List element requires 'listType' set to '12M', 'M2M', or 'custom'.", listType ?? value);
      return;
    }
    const ref = e.get("listRef");
    let name: string;
    if (kind === "custom") {
      if (ref?.kind === "call") name = `REL.${this.table}.REL:${this.ctx.recordOf(ref).id.getValue()}`;
      else if (ref?.kind === "string" && isGUID(ref.value)) name = `REL.${this.table}.REL:${ref.value}`;
      else if (ref?.kind === "string") {
        this.fail(guidMessage("listRef", "sys_relationship", ref.value), ref);
        return;
      } else {
        this.fail(
          "Custom list requires 'listRef' with a Record<'sys_relationship'> reference or a sys_relationship sys_id string (GUID).",
          ref ?? value,
        );
        return;
      }
    } else {
      if (ref?.kind !== "string") {
        this.fail(
          `List element requires 'listRef' as a dot-notation string '<table_name>.<column_name>' for '${kind}' type.`,
          value,
        );
        return;
      }
      const parts = ref.value.split(".");
      if (parts.length !== 2 || !parts[0] || !parts[1]) {
        this.fail(`Invalid 'listRef' format '${ref.value}'. Expected '<table_name>.<column_name>' (e.g., 'task_sla.task').`, ref);
        return;
      }
      name = `${kind}.${this.table}.${parts[0]}.${parts[1]}`;
    }
    this.uiElement(section, value, name, "list");
  }

  /** A sys_id given as a record, a constant's key or a GUID; anything else is ''. */
  private guid(value: FluentValue | undefined, constants: Readonly<Record<string, string>>, key: string, table: string): string {
    if (value?.kind === "call") return this.ctx.recordOf(value).id.getValue();
    if (value?.kind !== "string") return "";
    const constant = lookup(constants, value.value);
    if (constant !== undefined) return constant;
    if (isGUID(value.value)) return value.value;
    this.fail(guidMessage(key, table, value.value), value);
    return "";
  }
}

function guidMessage(key: string, table: string, value: string): string {
  return `'${key}' must be a valid GUID or a Record<'${table}'>. Received: '${value}'`;
}

function viewOf(o: Options, ctx: BuildContext): View | undefined {
  const value = o.get("view");
  switch (value?.kind) {
    case "string":
      if (value.value === DEFAULT_VIEW) {
        ctx.report(
          "error",
          `Do not use the hard-coded string '${DEFAULT_VIEW}' as the view. Use the exported 'default_view' identifier instead: view: default_view`,
          value.loc,
        );
        return undefined;
      }
      return ctx.factory.createReference("sys_ui_view", undefined, { name: value.value });
    case "call":
      return ctx.recordOf(value);
    case "ref":
      return ctx.factory.createReference(
        value.table,
        value.guid,
        value.keys &&
          Object.fromEntries(
            [...value.keys].map(([k, v]) => [k, v.kind === "string" ? v.value : o.error("Form(): Now.ref() keys of 'view' must be strings.", v)]),
          ),
      );
    default:
      return DEFAULT_VIEW;
  }
}

/** The view's sys_id, name and display value, as the SDK's `resolveView`. */
function resolveView(view: View): ResolvedView {
  if (typeof view === "string") return { sysId: DEFAULT_VIEW, name: DEFAULT_VIEW, displayValue: DEFAULT_VIEW };
  if (view instanceof RecordId) {
    const key = view.getKeys()?.name;
    const name = typeof key === "string" && !isGUID(key) ? key : "";
    return { sysId: view.getValue(), name, displayValue: name };
  }
  const name = view.fields.get("name");
  const title = view.fields.get("title");
  const viewName = typeof name === "string" ? name : "";
  return { sysId: view.id.getValue(), name: viewName, displayValue: typeof title === "string" ? title : viewName };
}

/** The attributes of a record's `view` element. */
function viewAttributes(view: ResolvedView): Record<string, string> {
  if (view.sysId === DEFAULT_VIEW) return { name: "NULL", display_value: DEFAULT_VIEW };
  return view.name ? { name: view.name, display_value: view.displayValue || view.name } : {};
}

function roles(o: Options, ctx: BuildContext): string {
  return (o.array("roles") ?? [])
    .map((item) => {
      if (item.kind === "string") return item.value;
      if (item.kind === "call") return roleRecord(o, ctx, item, "roles").name;
      const name = item.kind === "object" ? item.props.get("name") : undefined;
      return name?.kind === "string" ? name.value : "";
    })
    .filter((name) => name !== "")
    .join(",");
}

function sectionReference(section: Section, table: string, view: ResolvedView): string {
  return element(
    "      ",
    "sys_ui_section",
    section.record.id.getValue(),
    { caption: section.caption, display_value: section.caption, name: table, sys_domain: "global", view: view.sysId },
  );
}

function formFile(form: CompiledRecord, builder: FormBuilder, ctx: BuildContext, table: string, view: ResolvedView): string {
  const formId = form.id.getValue();
  const lines = ['<?xml version="1.0"?>', "<record_update>", `  <sys_ui_form_sections${attributes({ form_id: formId, sys_domain: "global", table })}>`];
  builder.formSections.forEach((link, i) => {
    lines.push(
      '    <sys_ui_form_section action="INSERT_OR_UPDATE" apply_defaults="true">',
      element("      ", "position", String(i)),
      element("      ", "sys_id", link.id.getValue()),
      element("      ", "sys_ui_form", formId, { display_value: table, name: table, sys_domain: "global", view: view.sysId }),
      sectionReference(builder.sections[i]!, table, view),
      "    </sys_ui_form_section>",
    );
  });
  lines.push(
    '    <sys_ui_form action="INSERT_OR_UPDATE" apply_defaults="true">',
    element("      ", "name", table),
    element("      ", "roles", String(form.fields.get("roles"))),
    element("      ", "sys_id", formId),
    element("      ", "sys_scope", ctx.scopeId, { display_value: ctx.scope }),
    element("      ", "sys_user", String(form.fields.get("sys_user"))),
    element("      ", "view", view.sysId, viewAttributes(view)),
    element("      ", "view_name", ""),
    "    </sys_ui_form>",
    "  </sys_ui_form_sections>",
    "</record_update>",
  );
  return lines.join("\n");
}

function sectionFile(section: Section, ctx: BuildContext, table: string, view: ResolvedView): string {
  const record = section.record;
  const sectionId = record.id.getValue();
  const lines = [
    '<?xml version="1.0"?>',
    "<record_update>",
    `  <sys_ui_section${attributes({
      caption: section.caption,
      section_id: sectionId,
      sys_domain: "global",
      table,
      view: view.sysId === DEFAULT_VIEW ? "" : view.name,
    })}>`,
  ];
  for (const annotation of section.annotations) {
    lines.push(
      '    <sys_ui_annotation action="INSERT_OR_UPDATE" apply_defaults="true">',
      element("      ", "is_plain_text", String(annotation.fields.get("is_plain_text"))),
      element("      ", "name", ""),
      element("      ", "sys_id", annotation.id.getValue()),
      element("      ", "text", String(annotation.fields.get("text"))),
      element("      ", "type", String(annotation.fields.get("type"))),
      "    </sys_ui_annotation>",
    );
  }
  for (const e of section.elements) {
    lines.push(
      '    <sys_ui_element action="INSERT_OR_UPDATE" apply_defaults="true">',
      element("      ", "element", String(e.fields.get("element"))),
      element("      ", "position", String(e.fields.get("position"))),
      element("      ", "sys_id", e.id.getValue()),
      element("      ", "sys_ui_formatter", String(e.fields.get("sys_ui_formatter"))),
      sectionReference(section, table, view),
      element("      ", "sys_user", ""),
      element("      ", "type", String(e.fields.get("type"))),
      "    </sys_ui_element>",
    );
  }
  lines.push(
    '    <sys_ui_section action="INSERT_OR_UPDATE" apply_defaults="true">',
    element("      ", "caption", section.caption),
    element("      ", "header", String(record.fields.get("header"))),
    element("      ", "name", table),
    element("      ", "roles", ""),
    element("      ", "sys_domain", "global"),
    element("      ", "sys_id", sectionId),
    element("      ", "sys_scope", ctx.scopeId, { display_value: ctx.scope }),
    element("      ", "sys_user", ""),
    element("      ", "title", String(record.fields.get("title"))),
    element("      ", "view_name", ""),
    element("      ", "view", view.sysId, viewAttributes(view)),
    "    </sys_ui_section>",
    "  </sys_ui_section>",
    "</record_update>",
  );
  return lines.join("\n");
}

export const form: ArtefactSpec = {
  properties: ["table", "view", "user", "roles", "sections"],
  build(o, ctx) {
    const table = o.requiredString("table");
    const view = viewOf(o, ctx);
    const user = o.get("user");
    const created = ctx.factory.createRecord({
      table: "sys_ui_form",
      source: o.call.loc,
      installCategory: o.installCategory,
      emit: false,
      fields: {
        name: table,
        view: view ?? DEFAULT_VIEW,
        sys_user: user?.kind === "string" ? user.value : "",
        sys_domain: "global",
        roles: roles(o, ctx),
      },
    });
    if (view === undefined) return created;
    const builder = new FormBuilder(o, ctx, table, view instanceof RecordId || typeof view === "string" ? view : view.id);
    const sections = o.array("sections") ?? [];
    if (sections.length === 0) {
      ctx.report("warning", "Form does not have any sections. Add at least one section.", (o.get("sections") ?? o.call).loc);
    }
    const captions = new Set<string>();
    sections.forEach((item, i) => builder.section(created, item, i, captions));
    for (const section of builder.sections) created.children.push(section.record, ...section.annotations, ...section.elements);
    created.children.push(...builder.formSections);
    const resolved = resolveView(view);
    ctx.emitFile(`${o.installCategory}/sys_ui_form_sections_${created.id.getValue()}.xml`, formFile(created, builder, ctx, table, resolved));
    for (const section of builder.sections) {
      ctx.emitFile(`${o.installCategory}/sys_ui_section_${section.record.id.getValue()}.xml`, sectionFile(section, ctx, table, resolved));
    }
    return created;
  },
};
