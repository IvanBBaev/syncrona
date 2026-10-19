// SPDX-License-Identifier: GPL-3.0-or-later
//
// Assessment() → asmt_metric_type and RiskAssessment() → change_risk_asmt, each
// with its categories (asmt_metric_category), metrics (asmt_metric) and metric
// definitions (asmt_metric_definition). A scored Assessment also generates its
// trigger, delete and user-field business rules (sys_script) and, when
// scheduled, the job that creates the assessments (sys_trigger); a
// RiskAssessment carries its thresholds (change_risk_asmt_threshold).

import type { FluentValue } from "../evaluate";
import { isGUID } from "../keys";
import { CData, type CompiledRecord, type FieldValue, type RecordId } from "../record";
import { formatDuration, parseDuration, type DurationData } from "../time";
import { lookup, type ArtefactSpec, type BuildContext, type Options } from "./shared";

const TYPE_TABLE = "asmt_metric_type";
const RISK_TABLE = "change_risk_asmt";
const RISK_ASSESSMENT_TABLE = "change_request";
const DEFAULT_EVALUATION_METHOD = "assessment";
const DEFAULT_DURATION = "1970-01-15 00:00:00";
const DOMAIN = { sys_domain: "global", sys_domain_path: "/" };

const SCORING_TYPES: Record<string, string> = { percentage: "percent", allOrNothing: "absolute" };
const SCHEDULE_PERIODS: Record<string, string> = { noLimit: "0", onlyOnce: "2", weekly: "3", monthly: "4", yearly: "6", daily: "11" };
const DATATYPES: Record<string, string> = {
  dateTime: "datetime",
  imageScale: "imagescale",
  likertScale: "scale",
  multipleSelection: "multiplecheckbox",
  number: "long",
  numericScale: "numericscale",
  ratings: "rating",
  yesNo: "boolean",
};
const PLUGINS: Record<string, string> = {
  "Software Asset Management": "com.snc.software_asset_management",
  Core: "com.snc.core",
  CMDB: "com.snc.cmdb",
  Procurement: "com.snc.procurement",
  "Cost Management": "com.snc.cost_management",
  "Asset Management": "com.snc.asset_management",
};
const COND_QUESTIONS: Record<string, string> = { ifFieldEmpty: "emptyfield", ifScriptEmpty: "emptyscript" };
const METHODS: Record<string, string> = { defaultAnswerFromField: "condfield", defaultAnswerFromScript: "condscript" };
const STRING_OPTIONS: Record<string, string> = { singleLine: "short", singleLineWide: "wide" };
const RISK_LEVELS: Record<string, string> = { high: "2", moderate: "3", low: "4" };
const SCRIPT_METHODS = ["script", "defaultAnswerFromScript"];

const BASE_PROPERTIES = [
  "name",
  "description",
  "introduction",
  "endNote",
  "hideSurveyIntroductionNotes",
  "active",
  "sourceTable",
  "condition",
  "scoringType",
  "scaleFactor",
  "scheduleType",
  "schedulePeriod",
  "assessmentDuration",
  "allowRetake",
  "anonymizeResponses",
  "roles",
  "userField",
  "filterField",
  "returnUrl",
  "liveFeed",
  "chatSurvey",
  "oneClickSurvey",
  "portalPagination",
  "owners",
  "sendNotifications",
  "notifyIfOverdue",
  "assessmentManager",
  "signature",
  "enforceCondition",
  "displayAllFilters",
  "filterCondition",
  "defaultMatrixFilter",
  "state",
  "sampleMetric",
  "categories",
  "allowPublic",
  "businessRule",
  "deleteBusinessRule",
  "scheduleJob",
  "userFieldBusinessRule",
];
const CATEGORY_PROPERTIES = [
  "$id",
  "name",
  "description",
  "details",
  "weight",
  "order",
  "scoringType",
  "roles",
  "filter",
  "createStakeholders",
  "metrics",
  "questionBankEvaluationMethod",
];
const METRIC_PROPERTIES = [
  "$id",
  "name",
  "question",
  "description",
  "details",
  "dataType",
  "scored",
  "weight",
  "order",
  "mandatory",
  "readOnly",
  "active",
  "allowNotApplicable",
  "allowAdditionalInformation",
  "additionalInformationLabel",
  "hideLabel",
  "dependentPlugin",
  "dependsOn",
  "condQuestion",
  "displayedWhen",
  "displayedWhenYesNo",
  "displayedWhenCheckbox",
  "displayedWhenTemplate",
  "condition",
  "sourceField",
  "script",
  "defaultAnswer",
  "method",
  "fieldValidation",
  "maximumNormalizationInput",
  "valueParameters",
  "context",
  "maxWeight",
  "definitions",
  "stringOption",
  "referenceTable",
  "scaleDefinition",
  "correctAnswerChoice",
  "randomizeAnswers",
  "correctAnswerCheckbox",
  "correctAnswerYesNo",
  "template",
  "correctAnswerTemplate",
  "duration",
  "customMetric",
  "min",
  "max",
  "correctAnswer",
];
const DEFINITION_PROPERTIES = ["label", "order", "normalizationInput", "selectedImage", "unselectedImage"];
const THRESHOLD_PROPERTIES = ["$id", "risk", "scoreGreaterThan"];

/** An encoded query ending in the `^EQ` terminator. */
function withTerm(query: string): string {
  return query && !query.endsWith("^EQ") ? `${query}^EQ` : query;
}

/** A value inside a single-quoted script literal. */
function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/'/g, "\\'");
}

/** A field as written: a string, number or boolean, or the record of another API call. */
function value(o: Options, ctx: BuildContext, key: string): FieldValue | CompiledRecord {
  const v = o.get(key);
  if (v === undefined) return undefined;
  if (v.kind === "string" || v.kind === "number" || v.kind === "boolean") return v.value;
  if (v.kind === "call") return ctx.recordOf(v);
  return o.error(`${o.call.api}(): '${o.path}${key}' must be a string, number, boolean or record.`, v);
}

/** A string mapped through `map` (unknown values kept as written); empty or absent gives `fallback`. */
function mapped(o: Options, key: string, map: Record<string, string>, fallback: string): string {
  const v = o.string(key);
  return v ? (lookup(map, v) ?? v) : (v ?? fallback);
}

/** A list of names (`byId` false) or sys_ids as the platform stores it: unique, comma-separated. Not a list gives ''. */
function referenceList(o: Options, ctx: BuildContext, key: string, byId: boolean): string {
  const v = o.get(key);
  if (v?.kind !== "array") return "";
  const values = v.items.map((item) => {
    if (item.kind === "string" || item.kind === "number" || item.kind === "boolean") return String(item.value);
    if (item.kind === "call") {
      const record = ctx.recordOf(item);
      return byId ? record.id.getValue() : String(record.fields.get("name"));
    }
    return o.error(`${o.call.api}(): '${o.path}${key}' must hold strings or records.`, item);
  });
  return [...new Set(values)].join(",");
}

/** A sys_id string or a record, as a reference; absent gives ''. */
function reference(o: Options, ctx: BuildContext, key: string): string | CompiledRecord {
  const v = o.get(key);
  if (v === undefined) return "";
  if (v.kind === "string") return v.value;
  if (v.kind === "call") return ctx.recordOf(v);
  return o.error(`${o.call.api}(): '${o.path}${key}' must be a sys_id or a record.`, v);
}

/** `assessmentDuration`: `Duration()`, a `{ days, hours, minutes, seconds }` object or a glide_duration string. */
function duration(o: Options): string {
  const v = o.get("assessmentDuration");
  if (v === undefined) return DEFAULT_DURATION;
  if (v.kind === "helper" && v.name === "Duration") return formatDuration(v.fields);
  if (v.kind === "string") return parseDuration(v.value) ?? o.error(`Invalid duration value: ${v.value}`, v);
  if (v.kind !== "object") return o.error(`${o.call.api}(): 'assessmentDuration' must be Duration(), an object or a string.`, v);
  const data: DurationData = {};
  for (const name of ["days", "hours", "minutes", "seconds"] as const) {
    const field = v.props.get(name);
    if (field === undefined || field.kind === "undefined") continue;
    if (field.kind !== "number") o.error(`fields in Duration object can only contain numbers, got ${field.kind}`, field);
    data[name] = field.value;
  }
  return formatDuration(data);
}

/** The fields Assessment() and RiskAssessment() share. */
function baseFields(o: Options, ctx: BuildContext): Record<string, FieldValue | CompiledRecord> {
  const condition = o.string("condition");
  return {
    name: value(o, ctx, "name"),
    table: value(o, ctx, "table") ?? "",
    description: new CData(o.string("description") ?? ""),
    introduction: new CData(o.string("introduction") ?? ""),
    end_note: new CData(o.string("endNote") ?? ""),
    not_show_intro_note: value(o, ctx, "hideSurveyIntroductionNotes") ?? false,
    active: value(o, ctx, "active") ?? true,
    source_table: value(o, ctx, "sourceTable") ?? "",
    condition: condition ? withTerm(condition) : "",
    scoring_type: mapped(o, "scoringType", SCORING_TYPES, "percent") || "percent",
    scale_factor: value(o, ctx, "scaleFactor") ?? 0,
    schedule_type: o.string("scheduleType") === "onDemand" ? "on_demand" : (o.string("scheduleType") ?? "on_demand"),
    schedule_period: mapped(o, "schedulePeriod", SCHEDULE_PERIODS, "0"),
    allow_retake: value(o, ctx, "allowRetake") ?? false,
    anonymize: value(o, ctx, "anonymizeResponses") ?? false,
    roles: referenceList(o, ctx, "roles", false),
    user_field: value(o, ctx, "userField") ?? "",
    display_field: value(o, ctx, "filterField") ?? "",
    url: value(o, ctx, "returnUrl") ?? "",
    live_feed: value(o, ctx, "liveFeed") ?? false,
    chat_survey: value(o, ctx, "chatSurvey") ?? false,
    one_click_survey: value(o, ctx, "oneClickSurvey") ?? false,
    portal_pagination: value(o, ctx, "portalPagination") ?? "category",
    survey_owners: referenceList(o, ctx, "owners", true),
    notify_user: value(o, ctx, "sendNotifications") ?? true,
    notify_if_overdue: value(o, ctx, "notifyIfOverdue") ?? false,
    overdue_notify_user: reference(o, ctx, "assessmentManager"),
    signature: reference(o, ctx, "signature"),
    enforce_condition: value(o, ctx, "enforceCondition") ?? false,
    display_all_filters: value(o, ctx, "displayAllFilters") ?? false,
    filter_condition: value(o, ctx, "filterCondition") ?? "",
    default_filter: value(o, ctx, "defaultMatrixFilter") ?? "",
    publish_state: value(o, ctx, "state") ?? "draft",
    sample_metric: reference(o, ctx, "sampleMetric"),
    allow_public: value(o, ctx, "allowPublic") ?? false,
  };
}

/** The categories and their metrics, each read with its own properties. */
function categories(o: Options): { category: Options; metrics: Options[] }[] {
  return (o.array("categories") ?? []).map((item, i) => {
    const category = o.sub(item, `categories[${i}].`, CATEGORY_PROPERTIES);
    const metrics = (category.array("metrics") ?? []).map((metric, j) => category.sub(metric, `metrics[${j}].`, METRIC_PROPERTIES));
    return { category, metrics };
  });
}

/** The SDK's publish check: a published scored assessment needs categories, each with a metric. */
function validatePublishState(o: Options, ctx: BuildContext, list: { category: Options; metrics: Options[] }[]): void {
  const state = o.get("state");
  if ((o.string("evaluationMethod") ?? DEFAULT_EVALUATION_METHOD) !== DEFAULT_EVALUATION_METHOD || state?.kind !== "string" || state.value !== "published") return;
  if (list.length === 0) {
    ctx.report("error", "An assessment must have at least one category before it can be published.", state.loc);
    return;
  }
  for (const { category, metrics } of list) {
    if (metrics.length === 0) {
      ctx.report(
        "error",
        "Each category must have at least one metric before the assessment can be published.",
        (category.get("metrics") ?? category.object).loc,
      );
    }
  }
}

function createCategory(
  ctx: BuildContext,
  o: Options,
  { category: c, metrics }: { category: Options; metrics: Options[] },
  type: CompiledRecord,
  table: string,
): CompiledRecord {
  const filter = c.string("filter");
  const record = ctx.factory.createRecord({
    table: "asmt_metric_category",
    source: o.call.loc,
    installCategory: o.installCategory,
    explicitId: c.explicitId(),
    fields: {
      name: value(c, ctx, "name"),
      description: value(c, ctx, "description") ?? "",
      details: new CData(c.string("details") ?? ""),
      ...DOMAIN,
      weight: value(c, ctx, "weight") ?? 10,
      order: value(c, ctx, "order") ?? 1,
      scoring_type: mapped(c, "scoringType", SCORING_TYPES, "percent") || "percent",
      roles: referenceList(c, ctx, "roles", false),
      filter: filter ? withTerm(filter) : "",
      create_stakeholders: value(c, ctx, "createStakeholders") ?? false,
      qb_evaluation_method: value(c, ctx, "questionBankEvaluationMethod") ?? "",
      total_metrics: metrics.length,
      table,
      metric_type: type.id,
    },
  });
  record.children.push(...metrics.map((m) => createMetric(ctx, o, m, record, type)));
  return record;
}

/** `dependsOn`: a `Now.ID` key, a sys_id, a metric record or a `Now.ref()`. */
function dependsOn(m: Options, ctx: BuildContext): RecordId | CompiledRecord | "" {
  const v: FluentValue | undefined = m.get("dependsOn");
  if (v === undefined) return "";
  if (v.kind === "call") return ctx.recordOf(v);
  if (v.kind === "ref" && v.guid !== undefined && v.keys === undefined) return ctx.factory.createReference(v.table, v.guid);
  const key = v.kind === "nowId" ? v.key : v.kind === "string" ? v.value : m.error(`${m.call.api}(): '${m.path}dependsOn' must be Now.ID[...], a sys_id or a metric record.`, v);
  return key ? ctx.factory.createReference("asmt_metric", key) : "";
}

function createMetric(ctx: BuildContext, o: Options, m: Options, category: CompiledRecord, type: CompiledRecord): CompiledRecord {
  const datatype = mapped(m, "dataType", DATATYPES, "long");
  const record = ctx.factory.createRecord({
    table: "asmt_metric",
    source: o.call.loc,
    installCategory: o.installCategory,
    explicitId: m.explicitId(),
    fields: {
      name: value(m, ctx, "name"),
      question: value(m, ctx, "question"),
      description: value(m, ctx, "description") ?? "",
      details: new CData(m.string("details") ?? ""),
      ...DOMAIN,
      auto_gen: false,
      datatype,
      scored: m.boolean("scored") ?? false,
      weight: value(m, ctx, "weight") ?? 10,
      order: value(m, ctx, "order") ?? 100,
      mandatory: value(m, ctx, "mandatory") ?? false,
      read_only: value(m, ctx, "readOnly") ?? false,
      active: value(m, ctx, "active") ?? true,
      scale: value(m, ctx, "scaleDefinition") ?? "high",
      min: value(m, ctx, "min") ?? 0,
      max: value(m, ctx, "max") ?? 10,
      correct_answer: value(m, ctx, "correctAnswer") ?? 0,
      correct_answer_choice: referenceList(m, ctx, "correctAnswerChoice", true),
      correct_answer_template: referenceList(m, ctx, "correctAnswerTemplate", true),
      correct_answer_yesno: value(m, ctx, "correctAnswerYesNo") ?? "",
      correct_answer_checkbox: value(m, ctx, "correctAnswerCheckbox") ?? "",
      allow_not_applicable: value(m, ctx, "allowNotApplicable") ?? false,
      allow_add_info: value(m, ctx, "allowAdditionalInformation") ?? false,
      add_info_label: value(m, ctx, "additionalInformationLabel") ?? "Additional Information",
      randomize_answers: value(m, ctx, "randomizeAnswers") ?? false,
      hide_label: value(m, ctx, "hideLabel") ?? false,
      plugin: mapped(m, "dependentPlugin", PLUGINS, ""),
      depends_on: dependsOn(m, ctx),
      cond_question: mapped(m, "condQuestion", COND_QUESTIONS, "always"),
      displayed_when: referenceList(m, ctx, "displayedWhen", true),
      displayed_when_yesno: value(m, ctx, "displayedWhenYesNo") ?? "",
      displayed_when_checkbox: value(m, ctx, "displayedWhenCheckbox") ?? "",
      displayed_when_template: referenceList(m, ctx, "displayedWhenTemplate", true),
      condition: value(m, ctx, "condition") ?? "",
      reference_table: value(m, ctx, "referenceTable") ?? "",
      source_field: value(m, ctx, "sourceField") ?? "",
      template: value(m, ctx, "template") ?? "",
      script: new CData(m.string("script") ?? ""),
      default_value_field: value(m, ctx, "defaultAnswer") ?? "",
      duration: value(m, ctx, "duration") ?? "",
      method: mapped(m, "method", METHODS, "assessment"),
      string_option: mapped(m, "stringOption", STRING_OPTIONS, "short"),
      field_validation: reference(m, ctx, "fieldValidation"),
      maximum_normalization_input: value(m, ctx, "maximumNormalizationInput") ?? false,
      value_parameters: value(m, ctx, "valueParameters") ?? "",
      context: value(m, ctx, "context") ?? "",
      custom_metric: value(m, ctx, "customMetric") ?? "",
      max_weight: value(m, ctx, "maxWeight") ?? 0,
      category: category.id,
      metric_type: type.id,
    },
  });
  record.children.push(...createDefinitions(ctx, o, m, record));
  if (record.children.length === 0 && datatype === "numericscale") {
    // The platform creates one definition per integer of the scale; the SDK mirrors it.
    for (let i = m.number("min") ?? 0; i <= (m.number("max") ?? 10); i++) {
      record.children.push(
        ctx.factory.createRecord({
          table: "asmt_metric_definition",
          source: o.call.loc,
          installCategory: o.installCategory,
          fields: { metric: record, value: String(i), display: String(i), order: i, normalization_input: 0 },
        }),
      );
    }
  }
  return record;
}

/** `definitions`: `{ [value]: label | { label, order, normalizationInput, selectedImage, unselectedImage } }`. */
function createDefinitions(ctx: BuildContext, o: Options, m: Options, metric: CompiledRecord): CompiledRecord[] {
  const definitions = m.get("definitions");
  if (definitions === undefined) return [];
  if (definitions.kind !== "object") return m.error(`${m.call.api}(): '${m.path}definitions' must be an object.`, definitions);
  return [...definitions.props].map(([key, entry], index) => {
    if (!/^-?\d+$/.test(key)) {
      ctx.report(
        "error",
        `Definition key '${key}' is not a valid integer. The platform stores definition values in a numeric column, so keys must be integers.`,
        entry.loc,
      );
    }
    const config = entry.kind === "object" ? m.sub(entry, `definitions.${key}.`, DEFINITION_PROPERTIES) : undefined;
    let display: string;
    if (config) display = config.string("label") ?? "";
    else if (entry.kind === "string" || entry.kind === "number" || entry.kind === "boolean") display = String(entry.value);
    else display = m.error(`${m.call.api}(): '${m.path}definitions.${key}' must be a label or an object.`, entry);
    return ctx.factory.createRecord({
      table: "asmt_metric_definition",
      source: o.call.loc,
      installCategory: o.installCategory,
      fields: {
        metric,
        value: key,
        display,
        order: config?.number("order") ?? (index + 1) * 100,
        normalization_input: config?.number("normalizationInput") ?? 0,
        selected_image: config?.string("selectedImage") ?? "",
        unselected_image: config?.string("unselectedImage") ?? "",
        ...DOMAIN,
      },
    });
  });
}

/** `scheduleJob` / `userFieldBusinessRule`: an existing record's sys_id, or nothing to generate a new one. */
function existingGuid(o: Options, ctx: BuildContext, key: string, table: string): string | undefined {
  const v = o.get(key);
  const guid = v?.kind === "string" ? v.value : undefined;
  if (!guid) return undefined;
  if (!isGUID(guid)) {
    ctx.report("error", `'${key}' must be a valid GUID or a Record<'${table}'>. Received: '${guid}'`, v!.loc);
    return undefined;
  }
  return guid;
}

/** The SDK's checks on an Assessment(); each failure is an error diagnostic, not a stop. */
function validate(o: Options, ctx: BuildContext, list: { category: Options; metrics: Options[] }[]): void {
  if ((o.string("evaluationMethod") ?? DEFAULT_EVALUATION_METHOD) === DEFAULT_EVALUATION_METHOD) {
    if (!o.string("table")) {
      ctx.report("error", "'table' is required when 'evaluationMethod' is 'assessment' (the default).", (o.get("table") ?? o.object).loc);
    }
    const scaleFactor = o.get("scaleFactor");
    if (scaleFactor?.kind !== "number") {
      ctx.report("error", "'scaleFactor' is required when 'evaluationMethod' is 'assessment' (the default).", (scaleFactor ?? o.object).loc);
    } else if (!Number.isInteger(scaleFactor.value)) {
      ctx.report("error", "'scaleFactor' must be an integer.", scaleFactor.loc);
    }
  }
  validatePublishState(o, ctx, list);
  for (const { metrics } of list) {
    for (const m of metrics) {
      const script = m.string("script");
      const method = m.string("method");
      if (script && method && !SCRIPT_METHODS.includes(method)) {
        ctx.report("hint", "'script' is only evaluated when 'method' is 'script' or 'condscript'; it will be ignored otherwise.", m.get("script")!.loc);
      }
      if (method === "defaultAnswerFromScript") {
        if (!m.string("dependentPlugin")) {
          ctx.report("error", "A metric with method 'condscript' must also set 'dependentPlugin'.", (m.get("dependentPlugin") ?? m.object).loc);
        }
        if (!script) ctx.report("error", "A metric with method 'condscript' must also set 'script'.", (m.get("script") ?? m.object).loc);
      }
    }
  }
}

interface BusinessRule {
  key: string;
  name: string;
  when: string;
  order?: number;
  actions: Record<string, boolean>;
  condition?: string;
  description: string;
  script: string;
}

function createBusinessRule(ctx: BuildContext, o: Options, rule: BusinessRule): CompiledRecord {
  const order = rule.order ?? 100;
  const table = value(o, ctx, "table");
  return ctx.factory.createRecord({
    table: "sys_script",
    source: o.call.loc,
    installCategory: o.installCategory,
    explicitId: rule.key,
    fields: {
      name: rule.name,
      ...(table === undefined ? {} : { collection: table }),
      when: rule.when,
      active: true,
      order,
      ...rule.actions,
      description: rule.description,
      advanced: true,
      execute_function: true,
      ...(rule.condition === undefined ? {} : { condition: rule.condition }),
      script: new CData(rule.script),
      priority: order,
      access: "package_private",
    },
  });
}

export const assessment: ArtefactSpec = {
  properties: [...BASE_PROPERTIES, "table", "evaluationMethod"],
  build(o, ctx) {
    const list = categories(o);
    validate(o, ctx, list);
    const id = String(o.explicitId());
    const scored = (o.string("evaluationMethod") ?? DEFAULT_EVALUATION_METHOD) === DEFAULT_EVALUATION_METHOD;
    const scheduled = o.string("scheduleType") === "scheduled";
    const userField = o.string("userField") || "";
    const userFieldRule = scored && scheduled && userField !== "" && (o.string("state") ?? "draft") === "published";
    const jobGuid = scheduled ? existingGuid(o, ctx, "scheduleJob", "sys_trigger") : undefined;
    const jobKey = jobGuid ?? `${id}__assessment_schedule_job`;
    const ruleKey = `${id}__assessment_business_rule`;
    const deleteRuleKey = `${id}__assessment_delete_business_rule`;
    const userFieldRuleGuid = userFieldRule ? existingGuid(o, ctx, "userFieldBusinessRule", "sys_script") : undefined;
    const userFieldRuleKey = userFieldRuleGuid ?? `${id}__assessment_user_field_business_rule`;
    const type = ctx.factory.createRecord({
      table: TYPE_TABLE,
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        ...DOMAIN,
        disable_ui_action: "",
        enable_ui_action: "",
        job: scheduled ? ctx.factory.createReference("sys_trigger", jobKey) : "",
        user_field_business_rule: userFieldRule ? ctx.factory.createReference("sys_script", userFieldRuleKey) : "",
        business_rule: scored ? ctx.factory.createReference("sys_script", ruleKey) : "",
        delete_business_rule: scored ? ctx.factory.createReference("sys_script", deleteRuleKey) : "",
        ...baseFields(o, ctx),
        filter_table: value(o, ctx, "table") ?? "",
        evaluation_method: value(o, ctx, "evaluationMethod") ?? DEFAULT_EVALUATION_METHOD,
        duration: duration(o),
      },
    });
    const sysId = type.id.getValue();
    if (!scored) {
      // A survey is scoped to its own type record instead of a business rule.
      type.fields.set("table", TYPE_TABLE);
      type.fields.set("condition", withTerm(`sys_id=${sysId}`));
    }
    const table = o.string("table") || TYPE_TABLE;
    type.children.push(...list.map((c) => createCategory(ctx, o, c, type, table)));
    const name = o.string("name") ?? "";
    if (scored) {
      type.children.push(
        createBusinessRule(ctx, o, {
          key: ruleKey,
          name: `${name} Assessment Trigger`,
          when: "after",
          actions: { action_insert: true, action_update: true },
          description: `Auto-generated by the '${name}' assessment. Triggers assessment generation when the assessment's condition matches.`,
          script: `function onAfter(current, previous) {
    var AssessmentUtils = new global.AssessmentUtils();
    if (AssessmentUtils.conditionCheck(current, '${esc(withTerm(o.string("condition") ?? ""))}')) {
        AssessmentUtils.checkRecord(current, '${sysId}', true);
    }
}`,
        }),
        createBusinessRule(ctx, o, {
          key: deleteRuleKey,
          name: `${name} Assessment Delete`,
          when: "before",
          actions: { action_delete: true },
          description: `Auto-generated by the '${name}' assessment. Cleans up assessment instances when the source record is deleted.`,
          script: `function onBefore(current, previous) {
    new global.AssessmentUtils().checkDeleteRecord(current, '${sysId}', true);
}`,
        }),
      );
      if (userFieldRule && !userFieldRuleGuid) {
        const field = esc(userField);
        type.children.push(
          createBusinessRule(ctx, o, {
            key: userFieldRuleKey,
            name: `${name} Assessment User Field Update`,
            when: "after",
            order: 300,
            condition: `(new global.AssessmentUtils().conditionCheck(current, '${field}VALCHANGES^EQ'))`,
            actions: { action_update: true },
            description: `Auto-generated by the '${name}' assessment. Updates assessable record category ownership when '${userField}' changes.`,
            script: `function onAfter() {
    var asmtUtil = new global.AssessmentUtils();
    asmtUtil.updateAssessableRecordCategoryUser(current.getUniqueValue(), '${sysId}', previous.getValue('${field}'), current.getValue('${field}'));
}`,
          }),
        );
      }
    }
    if (scheduled && !jobGuid) {
      type.children.push(
        ctx.factory.createRecord({
          table: "sys_trigger",
          source: o.call.loc,
          installCategory: o.installCategory,
          explicitId: jobKey,
          fields: {
            name: "Scheduled type Assessment Creation",
            job_classification: "On Demand.Scheduled type Assessment Creation",
            job_id: "81c92ce9c0a8016400e5f0d2f784ea78",
            trigger_type: 2,
            trigger_class: "DEFAULT",
            state: 0,
            priority: 100,
            script: new CData(`(new SNC.AssessmentCreation()).createAssessments('${sysId}');`),
          },
        }),
      );
    }
    return type;
  },
};

export const riskAssessment: ArtefactSpec = {
  properties: [...BASE_PROPERTIES, "thresholds"],
  build(o, ctx) {
    const list = categories(o);
    validatePublishState(o, ctx, list);
    const type = ctx.factory.createRecord({
      table: RISK_TABLE,
      source: o.call.loc,
      installCategory: o.installCategory,
      explicitId: o.explicitId(),
      fields: {
        ...DOMAIN,
        disable_ui_action: "",
        enable_ui_action: "",
        job: "",
        user_field_business_rule: "",
        business_rule: value(o, ctx, "businessRule") ?? "",
        delete_business_rule: value(o, ctx, "deleteBusinessRule") ?? "",
        ...baseFields(o, ctx),
        table: RISK_ASSESSMENT_TABLE,
        filter_table: "",
        evaluation_method: "risk_assessment",
        duration: duration(o),
      },
    });
    const thresholds = (o.array("thresholds") ?? []).map((item, i) => {
      const t = o.sub(item, `thresholds[${i}].`, THRESHOLD_PROPERTIES);
      const risk = t.string("risk");
      return ctx.factory.createRecord({
        table: "change_risk_asmt_threshold",
        source: o.call.loc,
        installCategory: o.installCategory,
        explicitId: t.explicitId(),
        fields: {
          assessment: type.id,
          risk: risk ? (lookup(RISK_LEVELS, risk) ?? risk) : "",
          score_greater_than: t.number("scoreGreaterThan") ?? 0,
        },
      });
    });
    type.children.push(...thresholds, ...list.map((c) => createCategory(ctx, o, c, type, RISK_ASSESSMENT_TABLE)));
    return type;
  },
};
