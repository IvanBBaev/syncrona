// SPDX-License-Identifier: GPL-3.0-or-later
//
// Interceptor() → sys_wizard (coalesced on its name) and one sys_wizard_answer
// per answer. The hints and warnings mirror the SDK's InterceptorPlugin: the
// platform validates none of these fields, so they never fail the build.

import type { FluentValue } from "../evaluate";
import { CData, type CompiledRecord, type RecordId } from "../record";
import { lookup, roleRecord, type ArtefactSpec, type BuildContext, type Options } from "./shared";

/** sys_wizard_answer.type codes; any other string is stored as given. */
const ANSWER_TYPE_CODES: Record<string, string> = {
  answer: "1",
  leadingQuestion: "2",
  multipleChoice: "3",
  yesNo: "4",
  freeformText: "5",
  button: "6",
  externalChoice: "9",
};
const DEFAULT_ORDER = 100;
const ANSWER = [
  "$id",
  "name",
  "answer",
  "type",
  "targetUrl",
  "nextQuestion",
  "buttonLabel",
  "table",
  "element",
  "dependentValue",
  "script",
  "roles",
  "order",
  "active",
  "payloadName",
];
/** Options every other API takes, which Interceptor() does not. */
const UNSUPPORTED = ["$id", "$meta"];

/** A sys_wizard reference: a sys_id string, a record, or a Now.ref(). */
function panel(o: Options, ctx: BuildContext, key: string): string | RecordId | CompiledRecord {
  const value = o.get(key);
  switch (value?.kind) {
    case undefined:
      return "";
    case "string":
      return value.value;
    case "call":
      return ctx.recordOf(value);
    case "ref":
      return ctx.factory.createReference(
        value.table,
        value.guid,
        value.keys &&
          Object.fromEntries(
            [...value.keys].map(([k, v]) =>
              v.kind === "string" ? [k, v.value] : o.error(`Interceptor(): Now.ref() keys of '${o.path}${key}' must be strings.`, v),
            ),
          ),
      );
    default:
      return o.error(`Interceptor(): '${o.path}${key}' must be a sys_id, a record or a Now.ref().`, value);
  }
}

/** Role names or Role() records, comma-separated in the given order (the SDK keeps duplicates). */
function roles(o: Options, ctx: BuildContext): string | undefined {
  return o
    .array("roles")
    ?.map((item) => {
      if (item.kind === "string") return item.value;
      if (item.kind === "call") return roleRecord(o, ctx, item, "answers[].roles").name;
      return o.error("Interceptor(): 'answers[].roles' must hold role names or Role() records.", item);
    })
    .join(",");
}

/** The SDK's hints and warnings for fields an answer's type uses or ignores. */
function checkAnswer(a: Options, ctx: BuildContext, type: string, at: FluentValue): void {
  const filled = (key: string) => (a.string(key) ?? "") !== "";
  const hint = (message: string) => ctx.report("hint", message, at.loc);
  const warn = (message: string, value: FluentValue = at) => ctx.report("warning", message, value.loc);
  if (type === "answer" && !filled("targetUrl")) {
    hint("Answer type 'answer' typically sets 'targetUrl' — this answer has none and will not navigate anywhere when selected.");
  }
  if (type === "leadingQuestion" && a.get("nextQuestion") === undefined) {
    hint("Answer type 'leadingQuestion' typically sets 'nextQuestion' — this answer has none and will not advance to another question.");
  }
  if (type === "button") {
    if (!filled("buttonLabel")) hint("Answer type 'button' typically sets 'buttonLabel' — this answer has none and will render an unlabeled button.");
    if (filled("answer")) {
      warn("The 'answer' field is stored but not displayed when type is 'button'; use 'buttonLabel' for the visible button text.", a.get("answer"));
    }
  }
  if (type === "externalChoice") {
    const table = filled("table");
    const element = filled("element");
    if (!table && !element) {
      hint("Answer type 'externalChoice' typically sets 'table' (and 'element') — this answer has none and will not source any choices.");
    } else if (table && !element) {
      hint("Answer type 'externalChoice' sets 'table' but is missing 'element'; the platform requires both to source dynamic choices.");
    } else if (!table && element) {
      warn("Answer type 'externalChoice' sets 'element' but is missing 'table'; 'element' is ignored without 'table'.");
    }
    if (filled("dependentValue") && !(table && element)) {
      warn("Answer type 'externalChoice' sets 'dependentValue' but 'table'/'element' are missing or incomplete; 'dependentValue' is ignored without both.");
    }
  }
  if ((type === "yesNo" || type === "freeformText") && !filled("payloadName")) {
    hint(`Answer type '${type}' captures user input via 'payloadName' at runtime; set 'payloadName' to a meaningful identifier so the collected value is accessible.`);
  }
  if (type === "multipleChoice") {
    hint("Answer type 'multipleChoice' has no choices in Fluent — add sys_wizard_choice records manually on the instance after deploying.");
  }
}

function answerRecord(o: Options, ctx: BuildContext, wizard: CompiledRecord, entry: FluentValue): CompiledRecord {
  const a = o.sub(entry, "answers[].", ANSWER);
  const type = a.string("type") ?? "answer";
  checkAnswer(a, ctx, type, entry);
  const answer = a.string("answer") ?? "";
  const script = a.string("script");
  return ctx.factory.createRecord({
    table: "sys_wizard_answer",
    source: entry.loc,
    installCategory: o.installCategory,
    explicitId: a.explicitId(),
    fields: {
      question: wizard,
      name: a.string("name") || answer,
      answer,
      type: lookup(ANSWER_TYPE_CODES, type) ?? type,
      target_url: a.string("targetUrl") ?? "",
      next_question: panel(a, ctx, "nextQuestion"),
      button_label: a.string("buttonLabel") ?? "",
      table: a.string("table") ?? "",
      element: a.string("element") ?? "",
      dependent_value: a.string("dependentValue") ?? "",
      script: script === undefined ? "" : new CData(script),
      roles: roles(a, ctx),
      order: a.number("order") ?? DEFAULT_ORDER,
      active: a.boolean("active") ?? true,
      payload_name: a.string("payloadName") ?? "",
    },
  });
}

/** One warning per order value that several sibling answers share, at the first of them. */
function checkOrders(o: Options, ctx: BuildContext, entries: FluentValue[]): void {
  const byOrder = new Map<number, FluentValue[]>();
  for (const entry of entries) {
    const order = o.sub(entry, "answers[].", ANSWER).get("order");
    const value = order?.kind === "number" ? order.value : DEFAULT_ORDER;
    byOrder.set(value, [...(byOrder.get(value) ?? []), order ?? entry]);
  }
  for (const [order, at] of byOrder) {
    if (at.length < 2) continue;
    ctx.report(
      "warning",
      `${at.length} answers share order ${order} — display order on the instance will be unpredictable. Set distinct order values for each sibling answer.`,
      at[0].loc,
    );
  }
}

export const interceptor: ArtefactSpec = {
  properties: ["name", "question", "backPanel", "nextPanel", "intercepts", "answers"],
  build(o, ctx) {
    for (const key of UNSUPPORTED) {
      const value = o.object.props.get(key);
      if (value !== undefined) o.error(`Interceptor() has no property '${key}'.`, value);
    }
    const wizard = ctx.factory.createRecord({
      table: "sys_wizard",
      source: o.call.loc,
      installCategory: o.installCategory,
      fields: {
        name: o.requiredString("name"),
        question: o.string("question") ?? "",
        back_panel: panel(o, ctx, "backPanel"),
        next_panel: panel(o, ctx, "nextPanel"),
        intercepts: o.string("intercepts") ?? "",
        sys_policy: o.protectionPolicy() ?? "",
      },
    });
    const entries = o.array("answers") ?? [];
    wizard.children.push(...entries.map((entry) => answerRecord(o, ctx, wizard, entry)));
    checkOrders(o, ctx, entries);
    return wizard;
  },
};
