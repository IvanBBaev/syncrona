// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * Content correctness of the four derived views (§5.12, §8.1, D2, D9, D18).
 *
 * Each describe block builds its own canonical tree through the production
 * writers and asserts the EXACT rendered bytes wherever the document is small
 * enough to spell out — a derived view exists to be diffed, so the strongest
 * possible assertion is "these are the bytes". The flag tests at the end pin
 * the config contract: a disabled view's directory is absent, not stale, and a
 * disabled refs view reports zero dangling references because it looked at
 * nothing (a disabled view must cost nothing).
 */
import { sep } from "node:path";

import { generateDerivedViews } from "../src/derived/derivedViews";
import { writeShardSet } from "../src/shards/shardStore";
import {
  DerivedMemoryFs,
  ROOT,
  buildCanonicalTree,
  derivedConfig,
  sysIdFor,
} from "./derivedFixture";

const derivedPath = (...segments: string[]): string =>
  [ROOT, "_derived", ...segments].join(sep);

describe("forms view", () => {
  const F1 = sysIdFor(0x101);
  const F2 = sysIdFor(0x102);
  const F3 = sysIdFor(0x103);
  const F4 = sysIdFor(0x104);
  const F5 = sysIdFor(0x105);
  const F6 = sysIdFor(0x106);
  const F7 = sysIdFor(0x107);
  const V1 = sysIdFor(0x110);
  const MISSING_VIEW = sysIdFor(0x1ff);
  const S1 = sysIdFor(0x120);
  const S2 = sysIdFor(0x121);
  const MISSING_SECTION = sysIdFor(0x1fe);
  const J1 = sysIdFor(0x130);
  const J2 = sysIdFor(0x131);
  const J3 = sysIdFor(0x132);
  const J4 = sysIdFor(0x133);
  const J5 = sysIdFor(0x134);
  const J6 = sysIdFor(0x135);
  const J7 = sysIdFor(0x136);
  const E1 = sysIdFor(0x140);
  const E2 = sysIdFor(0x141);
  const E3 = sysIdFor(0x142);
  const E6 = sysIdFor(0x143);
  const E7 = sysIdFor(0x144);
  const E8 = sysIdFor(0x145);
  const E4 = sysIdFor(0x146);
  const E5 = sysIdFor(0x147);

  async function buildFormsTree(fs: DerivedMemoryFs): Promise<void> {
    await buildCanonicalTree(fs, [
      { table: "sys_ui_form", sysId: F1, fields: { name: "incident" } },
      { table: "sys_ui_form", sysId: F2, fields: { name: "incident", view: V1 } },
      { table: "sys_ui_form", sysId: F3, fields: { name: "incident", view: MISSING_VIEW } },
      { table: "sys_ui_form", sysId: F4, fields: { name: "incident", view: "Self-Service" } },
      { table: "sys_ui_form", sysId: F5, fields: {} },
      { table: "sys_ui_form", sysId: F6, fields: { name: "incident" } },
      { table: "sys_ui_form", sysId: F7, fields: { name: "incident", view: "SELF-SERVICE" } },
      { table: "sys_ui_view", sysId: V1, name: "Mobile", fields: { name: "Mobile" } },
      { table: "sys_ui_section", sysId: S1, fields: { caption: "Details" } },
      { table: "sys_ui_section", sysId: S2, fields: {} },
      {
        table: "sys_ui_form_section",
        sysId: J1,
        fields: { sys_ui_form: F1, sys_ui_section: S1, position: "0" },
      },
      {
        table: "sys_ui_form_section",
        sysId: J2,
        fields: { sys_ui_form: F1, sys_ui_section: S2, position: "1" },
      },
      {
        table: "sys_ui_form_section",
        sysId: J3,
        fields: { sys_ui_form: F1, sys_ui_section: MISSING_SECTION, position: "2" },
      },
      { table: "sys_ui_form_section", sysId: J4, fields: { sys_ui_form: F1 } },
      {
        table: "sys_ui_form_section",
        sysId: J5,
        fields: { sys_ui_form: F1, sys_ui_section: S1, position: "abc" },
      },
      // Two joins on the Mobile form with EQUAL positions: the join-sort's
      // sys_id tiebreak must decide, not insertion order.
      {
        table: "sys_ui_form_section",
        sysId: J6,
        fields: { sys_ui_form: F2, sys_ui_section: S1, position: "5" },
      },
      {
        table: "sys_ui_form_section",
        sysId: J7,
        fields: { sys_ui_form: F2, sys_ui_section: S2, position: "5" },
      },
      {
        table: "sys_ui_element",
        sysId: E1,
        fields: { sys_ui_section: S1, element: "number", position: "0" },
      },
      {
        table: "sys_ui_element",
        sysId: E2,
        fields: { sys_ui_section: S1, element: "priority", position: "0" },
      },
      {
        table: "sys_ui_element",
        sysId: E3,
        fields: { sys_ui_section: S1, element: "state", position: "1", type: "element" },
      },
      {
        table: "sys_ui_element",
        sysId: E6,
        fields: { sys_ui_section: S1, position: "2", type: "formatter" },
      },
      { table: "sys_ui_element", sysId: E7, fields: { sys_ui_section: S1, position: "3" } },
      {
        table: "sys_ui_element",
        sysId: E8,
        fields: { sys_ui_section: S1, element: "annotation1", position: "4", type: "annotation" },
      },
      { table: "sys_ui_element", sysId: E4, fields: {} },
      {
        table: "sys_ui_element",
        sysId: E5,
        fields: { sys_ui_section: MISSING_SECTION, element: "ghost_field" },
      },
    ]);
  }

  const S1_BLOCK = [
    `### Details — ${S1}`,
    "",
    "- `number`",
    "- `priority`",
    "- `state`",
    `- (unnamed element ${E6}, type formatter)`,
    `- (unnamed element ${E7})`,
    "- `annotation1` — annotation",
  ].join("\n");

  it("flattens the four-table graph into one exact document per (table, view)", async () => {
    const fs = new DerivedMemoryFs();
    await buildFormsTree(fs);
    const summary = await generateDerivedViews(fs, ROOT, derivedConfig());

    expect(summary.counts.formDocuments).toBe(5);
    const defaultDoc = fs.derivedFiles().get(derivedPath("forms", "incident", "Default.md"));
    expect(defaultDoc).toBe(
      [
        "# Form layout: incident — view Default",
        "",
        "Regenerated from the canonical tree alone (INV-9, §5.12). Do not edit by hand.",
        "",
        `## Form ${F1} (scope global)`,
        "",
        S1_BLOCK,
        "",
        `### (untitled section) — ${S2}`,
        "",
        `### (missing section ${MISSING_SECTION})`,
        "",
        "- `ghost_field`",
        "",
        S1_BLOCK,
        "",
        `## Form ${F6} (scope global)`,
        "",
      ].join("\n")
    );
  });

  it("labels views by reference, by raw dangling sys_id, and by literal name", async () => {
    const fs = new DerivedMemoryFs();
    await buildFormsTree(fs);
    await generateDerivedViews(fs, ROOT, derivedConfig());

    const files = fs.derivedFiles();
    const mobile = files.get(derivedPath("forms", "incident", "Mobile.md")) as string;
    expect(mobile).toContain("# Form layout: incident — view Mobile");
    expect(mobile).toContain(`## Form ${F2} (scope global)`);
    // J6 and J7 share position "5": the join sys_id tiebreak puts S1 first.
    expect(mobile.indexOf(`### Details — ${S1}`)).toBeGreaterThan(-1);
    expect(mobile.indexOf(`### Details — ${S1}`)).toBeLessThan(
      mobile.indexOf(`### (untitled section) — ${S2}`)
    );
    const dangling = files.get(derivedPath("forms", "incident", `${MISSING_VIEW}.md`));
    expect(dangling).toContain(`# Form layout: incident — view ${MISSING_VIEW}`);
  });

  it("suffixes fold-colliding view labels with their anchor sys_ids (D18)", async () => {
    const fs = new DerivedMemoryFs();
    await buildFormsTree(fs);
    await generateDerivedViews(fs, ROOT, derivedConfig());

    const files = fs.derivedFiles();
    expect(files.has(derivedPath("forms", "incident", `Self-Service_${F4}.md`))).toBe(true);
    expect(files.has(derivedPath("forms", "incident", `SELF-SERVICE_${F7}.md`))).toBe(true);
    expect(files.has(derivedPath("forms", "incident", "Self-Service.md"))).toBe(false);
  });

  it("names every skipped row in the anomaly list (R3)", async () => {
    const fs = new DerivedMemoryFs();
    await buildFormsTree(fs);
    const summary = await generateDerivedViews(fs, ROOT, derivedConfig());

    const details = summary.anomalies
      .filter((anomaly) => anomaly.source === "forms")
      .map((anomaly) => anomaly.detail);
    expect(details).toEqual([
      `sys_ui_element ${E4}: missing sys_ui_section reference; skipped`,
      `sys_ui_form ${F5}: no table name in envelope; skipped`,
      `sys_ui_form_section ${J4}: missing sys_ui_form or sys_ui_section reference; skipped`,
    ]);
  });
});

describe("workflows view", () => {
  const W1 = sysIdFor(0x201);
  const W2 = sysIdFor(0x202);
  const WV1 = sysIdFor(0x210);
  const WV2 = sysIdFor(0x211);
  const WV3 = sysIdFor(0x212);
  const WV4 = sysIdFor(0x213);
  const WV6 = sysIdFor(0x215);
  const WV7 = sysIdFor(0x216);
  const WV8 = sysIdFor(0x217);
  const WV9 = sysIdFor(0x218);
  const WV10 = sysIdFor(0x219);
  const MISSING_WORKFLOW = sysIdFor(0x2ff);
  const A1 = sysIdFor(0x220);
  const A2 = sysIdFor(0x221);
  const A3 = sysIdFor(0x222);
  const A5 = sysIdFor(0x223);
  const A4 = sysIdFor(0x224);
  const MISSING_ACTIVITY = sysIdFor(0x2fe);
  const ORPHAN_FROM = sysIdFor(0x2fd);
  const T1 = sysIdFor(0x230);
  const T2 = sysIdFor(0x231);
  const T3 = sysIdFor(0x232);
  const T4 = sysIdFor(0x233);
  const T5 = sysIdFor(0x234);
  const T6 = sysIdFor(0x235);

  async function buildWorkflowsTree(fs: DerivedMemoryFs): Promise<void> {
    await buildCanonicalTree(fs, [
      { table: "wf_workflow", sysId: W1, name: "Approval Flow", fields: { name: "Approval Flow" } },
      { table: "wf_workflow", sysId: W2, name: "Dup Flow", fields: { name: "Dup Flow" } },
      {
        table: "wf_workflow_version",
        sysId: WV1,
        fields: { workflow: W1, published: "true", version: "2", name: "Approval Flow" },
      },
      { table: "wf_workflow_version", sysId: WV2, fields: { workflow: W1, published: "false" } },
      {
        table: "wf_workflow_version",
        sysId: WV3,
        fields: { workflow: MISSING_WORKFLOW, published: "true", version: "1", name: "Orphan Flow" },
      },
      { table: "wf_workflow_version", sysId: WV4, fields: { published: "true" } },
      { table: "wf_workflow_version", sysId: WV6, fields: { workflow: W1 } },
      {
        table: "wf_workflow_version",
        sysId: WV7,
        fields: { workflow: "not-a-sysid", published: "true", version: "3", name: "Named Flow" },
      },
      { table: "wf_workflow_version", sysId: WV8, fields: { workflow: W2, published: "true", version: "1" } },
      { table: "wf_workflow_version", sysId: WV9, fields: { workflow: W2, published: "true", version: "1" } },
      { table: "wf_workflow_version", sysId: WV10, envelopeText: "not json" },
      { table: "wf_activity", sysId: A1, fields: { workflow_version: WV1, name: "Begin" } },
      { table: "wf_activity", sysId: A2, fields: { workflow_version: WV1, name: "End" } },
      { table: "wf_activity", sysId: A3, fields: { workflow_version: WV1, name: "Begin" } },
      { table: "wf_activity", sysId: A5, fields: { workflow_version: WV1 } },
      { table: "wf_activity", sysId: A4, fields: {} },
      { table: "wf_transition", sysId: T1, fields: { from: A1, to: A2 } },
      { table: "wf_transition", sysId: T2, fields: { from: A1 } },
      { table: "wf_transition", sysId: T3, fields: { from: A2, to: MISSING_ACTIVITY } },
      { table: "wf_transition", sysId: T4, fields: {} },
      { table: "wf_transition", sysId: T5, fields: { from: ORPHAN_FROM, to: A1 } },
      // A second Begin -> End edge: identical labels, so only the transition's
      // own sys_id can order the pair.
      { table: "wf_transition", sysId: T6, fields: { from: A1, to: A2 } },
    ]);
  }

  it("renders one exact ordered document per published version", async () => {
    const fs = new DerivedMemoryFs();
    await buildWorkflowsTree(fs);
    const summary = await generateDerivedViews(fs, ROOT, derivedConfig());

    expect(summary.counts.workflowDocuments).toBe(6);
    expect(summary.counts.unpublishedWorkflowVersions).toBe(2);
    const doc = fs.derivedFiles().get(derivedPath("workflows", "Approval Flow@2.md"));
    expect(doc).toBe(
      [
        "# Workflow: Approval Flow — version 2",
        "",
        "Regenerated from the canonical tree alone (INV-9, §5.12). Do not edit by hand.",
        "",
        "## Activities",
        "",
        `- ${A5}`,
        "- Begin",
        "- Begin",
        "- End",
        "",
        "## Transitions",
        "",
        "- Begin -> (no target)",
        "- Begin -> End",
        "- Begin -> End",
        `- End -> (missing activity ${MISSING_ACTIVITY})`,
        "",
      ].join("\n")
    );
  });

  it("falls back through version name and sys_id when the workflow reference tears (D2)", async () => {
    const fs = new DerivedMemoryFs();
    await buildWorkflowsTree(fs);
    const summary = await generateDerivedViews(fs, ROOT, derivedConfig());

    const files = fs.derivedFiles();
    expect(files.get(derivedPath("workflows", "Orphan Flow@1.md"))).toContain(
      "# Workflow: Orphan Flow — version 1"
    );
    expect(files.get(derivedPath("workflows", `${WV4}@${WV4}.md`))).toContain(
      `# Workflow: ${WV4} — version ${WV4}`
    );
    expect(files.get(derivedPath("workflows", "Named Flow@3.md"))).toContain(
      "# Workflow: Named Flow — version 3"
    );
    expect(
      summary.anomalies.some((anomaly) =>
        anomaly.detail.includes(`workflow reference ${MISSING_WORKFLOW} is not in the tree`)
      )
    ).toBe(true);
  });

  it("suffixes versions whose <name>@<version> labels collide (D18)", async () => {
    const fs = new DerivedMemoryFs();
    await buildWorkflowsTree(fs);
    await generateDerivedViews(fs, ROOT, derivedConfig());

    const files = fs.derivedFiles();
    expect(files.has(derivedPath("workflows", `Dup Flow@1_${WV8}.md`))).toBe(true);
    expect(files.has(derivedPath("workflows", `Dup Flow@1_${WV9}.md`))).toBe(true);
    expect(files.has(derivedPath("workflows", "Dup Flow@1.md"))).toBe(false);
  });

  it("names every skipped activity, transition and version (R3)", async () => {
    const fs = new DerivedMemoryFs();
    await buildWorkflowsTree(fs);
    const summary = await generateDerivedViews(fs, ROOT, derivedConfig());

    const details = summary.anomalies
      .filter((anomaly) => anomaly.source === "workflows")
      .map((anomaly) => anomaly.detail);
    expect(details).toEqual([
      `wf_activity ${A4}: missing workflow_version reference; skipped`,
      `wf_transition ${T4}: missing from reference; skipped`,
      `wf_transition ${T5}: from-activity ${ORPHAN_FROM} is not in the tree; skipped (D2)`,
      `wf_workflow_version ${WV3}: workflow reference ${MISSING_WORKFLOW} is not in the tree; using the version's own name (D2)`,
      `wf_workflow_version ${WV10}: unreadable envelope; skipped`,
    ]);
  });
});

describe("refs view", () => {
  const DBO_TASK = sysIdFor(0x301);
  const DBO_INCIDENT = sysIdFor(0x302);
  const DBO_DUP = sysIdFor(0x303);
  const DBO_CYCA = sysIdFor(0x304);
  const DBO_CYCB = sysIdFor(0x305);
  const DBO_USER = sysIdFor(0x306);
  const DBO_NONAME = sysIdFor(0x307);
  const DBO_CHILDX = sysIdFor(0x308);
  const DBO_CHILDY = sysIdFor(0x309);
  const DBO_CHILDZ = sysIdFor(0x30a);
  const D1 = sysIdFor(0x310);
  const D2R = sysIdFor(0x311);
  const D3 = sysIdFor(0x312);
  const D4 = sysIdFor(0x313);
  const D5 = sysIdFor(0x314);
  const D6 = sysIdFor(0x315);
  const D7 = sysIdFor(0x316);
  const D8 = sysIdFor(0x317);
  const D9R = sysIdFor(0x318);
  const D10 = sysIdFor(0x319);
  const D11 = sysIdFor(0x31a);
  const U1 = sysIdFor(0x320);
  const P1 = sysIdFor(0x330);
  const I1 = sysIdFor(0x340);
  const I2 = sysIdFor(0x341);
  const I3 = sysIdFor(0x342);
  const I4 = sysIdFor(0x343);
  const USER_MISSING = sysIdFor(0x3fd);

  async function buildRefsTree(fs: DerivedMemoryFs): Promise<void> {
    await buildCanonicalTree(
      fs,
      [
        { table: "sys_db_object", sysId: DBO_TASK, fields: { name: "task" } },
        { table: "sys_db_object", sysId: DBO_INCIDENT, fields: { name: "incident", super_class: DBO_TASK } },
        { table: "sys_db_object", sysId: DBO_DUP, fields: { name: "task" } },
        { table: "sys_db_object", sysId: DBO_CYCA, fields: { name: "cyc_a", super_class: DBO_CYCB } },
        { table: "sys_db_object", sysId: DBO_CYCB, fields: { name: "cyc_b", super_class: DBO_CYCA } },
        { table: "sys_db_object", sysId: DBO_USER, fields: { name: "sys_user" } },
        { table: "sys_db_object", sysId: DBO_NONAME, fields: {} },
        { table: "sys_db_object", sysId: DBO_CHILDX, fields: { name: "childx", super_class: DBO_NONAME } },
        { table: "sys_db_object", sysId: DBO_CHILDY, fields: { name: "childy", super_class: "task" } },
        { table: "sys_db_object", sysId: DBO_CHILDZ, fields: { name: "childz", super_class: sysIdFor(0x3ff) } },
        {
          table: "sys_dictionary",
          sysId: D1,
          fields: { internal_type: "reference", name: "task", element: "assigned_to", reference: "sys_user" },
        },
        {
          table: "sys_dictionary",
          sysId: D2R,
          fields: { internal_type: "reference", name: "incident", element: "resolved_by", reference: DBO_USER },
        },
        {
          table: "sys_dictionary",
          sysId: D3,
          fields: {
            internal_type: "reference",
            name: "incident",
            element: "inactive_col",
            reference: "sys_user",
            active: "false",
          },
        },
        {
          table: "sys_dictionary",
          sysId: D4,
          fields: { internal_type: "reference", name: "incident", element: "bad_target", reference: sysIdFor(0x3fe) },
        },
        {
          table: "sys_dictionary",
          sysId: D5,
          fields: { internal_type: "reference", name: "incident", element: "unmirrored_target", reference: "cmdb_ci" },
        },
        {
          table: "sys_dictionary",
          sysId: D6,
          fields: { internal_type: "string", name: "incident", element: "short_description" },
        },
        { table: "sys_dictionary", sysId: D7, fields: { internal_type: "reference", element: "no_table" } },
        { table: "sys_dictionary", sysId: D8, fields: { internal_type: "reference", name: "incident" } },
        {
          table: "sys_dictionary",
          sysId: D9R,
          fields: { internal_type: "reference", name: "incident", element: "incomplete_target", reference: "problem" },
        },
        {
          table: "sys_dictionary",
          sysId: D10,
          fields: { internal_type: "reference", name: "task", element: "resolved_by", reference: "task" },
        },
        { table: "sys_dictionary", sysId: D11, fields: { internal_type: "reference", name: "incident", element: "null_target" } },
        { table: "sys_user", sysId: U1, name: "Abel Tuter", fields: { name: "Abel Tuter" } },
        { table: "problem", sysId: P1, fields: {} },
        {
          table: "incident",
          sysId: I1,
          fields: {
            assigned_to: U1,
            resolved_by: USER_MISSING,
            incomplete_target: sysIdFor(0x3fc),
            unmirrored_target: sysIdFor(0x3fb),
            bad_target: sysIdFor(0x3fa),
            null_target: sysIdFor(0x3f9),
            inactive_col: sysIdFor(0x3f8),
          },
        },
        { table: "incident", sysId: I2, fields: { assigned_to: "not-a-sysid-value" } },
        { table: "incident", sysId: I3, fields: {} },
        { table: "incident", sysId: I4, scope: "x_app", fields: { assigned_to: USER_MISSING } },
      ],
      { incompleteTables: ["problem"] }
    );
    // A scope claiming a table with zero records still owns an index file.
    await writeShardSet(fs, {
      root: ROOT,
      scope: "z_empty",
      table: "incident",
      fanout: 0,
      complete: true,
      sweepId: "sweep-fixture",
      entries: new Map(),
    });
  }

  it("indexes every filed row per scope and reports exactly the provable dangling refs (D2)", async () => {
    const fs = new DerivedMemoryFs();
    await buildRefsTree(fs);
    const summary = await generateDerivedViews(fs, ROOT, derivedConfig());

    expect(summary.counts.refScopes).toBe(3);
    expect(summary.counts.refRecords).toBe(27);
    expect(summary.danglingRefs).toEqual([
      {
        scope: "global",
        table: "incident",
        sysId: I1,
        field: "resolved_by",
        targetTable: "sys_user",
        targetSysId: USER_MISSING,
      },
      {
        scope: "x_app",
        table: "incident",
        sysId: I4,
        field: "assigned_to",
        targetTable: "sys_user",
        targetSysId: USER_MISSING,
      },
    ]);

    const globalDoc = fs.derivedFiles().get(derivedPath("refs", "global.md")) as string;
    expect(globalDoc).toContain(`| ${U1} | sys_user | Abel Tuter |`);
    expect(globalDoc).toContain(`| ${I1} | incident | ${I1} |`);
    expect(globalDoc).toContain(
      `| incident | ${I1} | resolved_by | sys_user | ${USER_MISSING} |`
    );
    // 27 indexed rows minus the one x_app row: the global index carries 26.
    expect(globalDoc.split("\n").filter((line) => line.startsWith(`| ${sysIdFor(0x300).slice(0, 28)}`)).length).toBe(26);
  });

  it("renders the small scope documents byte-for-byte", async () => {
    const fs = new DerivedMemoryFs();
    await buildRefsTree(fs);
    await generateDerivedViews(fs, ROOT, derivedConfig());

    const files = fs.derivedFiles();
    expect(files.get(derivedPath("refs", "x_app.md"))).toBe(
      [
        "# Reference index: x_app",
        "",
        "Regenerated from the canonical tree alone (INV-9, §5.12). Do not edit by hand.",
        "",
        "| sys_id | table | name |",
        "| --- | --- | --- |",
        `| ${I4} | incident | ${I4} |`,
        "",
        "## Dangling references (D2: reported, never repaired)",
        "",
        "| table | sys_id | field | target table | target sys_id |",
        "| --- | --- | --- | --- | --- |",
        `| incident | ${I4} | assigned_to | sys_user | ${USER_MISSING} |`,
        "",
      ].join("\n")
    );
    expect(files.get(derivedPath("refs", "z_empty.md"))).toBe(
      [
        "# Reference index: z_empty",
        "",
        "Regenerated from the canonical tree alone (INV-9, §5.12). Do not edit by hand.",
        "",
        "| sys_id | table | name |",
        "| --- | --- | --- |",
        "",
        "## Dangling references (D2: reported, never repaired)",
        "",
        "None.",
        "",
      ].join("\n")
    );
  });

  it("orders same-scope dangling refs and same-sys_id index rows by every key", async () => {
    const DBO = sysIdFor(0x901);
    const DICT_A = sysIdFor(0x902);
    const DICT_B = sysIdFor(0x903);
    const DICT_C = sysIdFor(0x904);
    const U = sysIdFor(0x905);
    const AR1 = sysIdFor(0x910);
    const AR2 = sysIdFor(0x911);
    const BR1 = sysIdFor(0x912);
    const GONE_A = sysIdFor(0x9f1);
    const GONE_B = sysIdFor(0x9f2);
    const fs = new DerivedMemoryFs();
    await buildCanonicalTree(fs, [
      { table: "sys_db_object", sysId: DBO, fields: { name: "sys_user" } },
      {
        table: "sys_dictionary",
        sysId: DICT_A,
        fields: { internal_type: "reference", name: "alpha", element: "ref_a", reference: "sys_user" },
      },
      {
        table: "sys_dictionary",
        sysId: DICT_B,
        fields: { internal_type: "reference", name: "alpha", element: "ref_b", reference: "sys_user" },
      },
      {
        table: "sys_dictionary",
        sysId: DICT_C,
        fields: { internal_type: "reference", name: "beta", element: "ref_a", reference: "sys_user" },
      },
      { table: "sys_user", sysId: U, fields: {} },
      { table: "alpha", sysId: AR1, fields: { ref_a: GONE_A, ref_b: GONE_B } },
      { table: "alpha", sysId: AR2, fields: { ref_a: GONE_A } },
      // beta reuses AR1's sys_id: legal across tables, and the only way the
      // index-row sort ever needs its table tiebreak.
      { table: "beta", sysId: AR1, fields: { ref_a: GONE_A } },
      { table: "beta", sysId: BR1, fields: { ref_a: GONE_A } },
    ]);
    const summary = await generateDerivedViews(fs, ROOT, derivedConfig());

    expect(summary.danglingRefs.map((entry) => [entry.table, entry.sysId, entry.field])).toEqual([
      ["alpha", AR1, "ref_a"],
      ["alpha", AR1, "ref_b"],
      ["alpha", AR2, "ref_a"],
      ["beta", AR1, "ref_a"],
      ["beta", BR1, "ref_a"],
    ]);
    const globalDoc = fs.derivedFiles().get(derivedPath("refs", "global.md")) as string;
    expect(globalDoc.indexOf(`| ${AR1} | alpha | ${AR1} |`)).toBeLessThan(
      globalDoc.indexOf(`| ${AR1} | beta | ${AR1} |`)
    );
  });

  it("reports zero dangling refs when sys_dictionary is not mirrored — an honest zero", async () => {
    const fs = new DerivedMemoryFs();
    await buildCanonicalTree(fs, [
      { table: "incident", sysId: I1, fields: { assigned_to: sysIdFor(0x3f0) } },
    ]);
    const summary = await generateDerivedViews(fs, ROOT, derivedConfig());

    expect(summary.danglingRefs).toEqual([]);
    expect(summary.counts.refScopes).toBe(1);
    expect(fs.derivedFiles().get(derivedPath("refs", "global.md"))).toContain("None.");
  });
});

describe("acl matrix view", () => {
  const ACL1 = sysIdFor(0x401);
  const ACL2 = sysIdFor(0x402);
  const ACL3 = sysIdFor(0x403);
  const ACL4 = sysIdFor(0x404);
  const ACL5 = sysIdFor(0x405);
  const R1 = sysIdFor(0x410);
  const MISSING_ROLE = sysIdFor(0x4ff);
  const MISSING_ACL = sysIdFor(0x4fe);
  const JR1 = sysIdFor(0x420);
  const JR2 = sysIdFor(0x421);
  const JR3 = sysIdFor(0x422);
  const JR4 = sysIdFor(0x423);
  const JR5 = sysIdFor(0x424);

  async function buildAclTree(fs: DerivedMemoryFs): Promise<void> {
    await buildCanonicalTree(fs, [
      {
        table: "sys_security_acl",
        sysId: ACL1,
        fields: { name: "incident", type: "record", operation: "read", active: "true" },
      },
      {
        table: "sys_security_acl",
        sysId: ACL2,
        fields: { name: "incident", type: "record", operation: "read", active: "true" },
      },
      { table: "sys_security_acl", sysId: ACL3, fields: {} },
      { table: "sys_security_acl", sysId: ACL4, envelopeText: "garbage" },
      {
        table: "sys_security_acl",
        sysId: ACL5,
        fields: { name: "a|b\\c\r\nd", type: "record", operation: "write" },
      },
      { table: "sys_user_role", sysId: R1, name: "admin", fields: { name: "admin" } },
      { table: "sys_security_acl_role", sysId: JR1, fields: { sys_security_acl: ACL1, sys_user_role: R1 } },
      {
        table: "sys_security_acl_role",
        sysId: JR2,
        fields: { sys_security_acl: ACL1, sys_user_role: MISSING_ROLE },
      },
      { table: "sys_security_acl_role", sysId: JR3, fields: { sys_security_acl: MISSING_ACL, sys_user_role: R1 } },
      { table: "sys_security_acl_role", sysId: JR4, fields: {} },
      { table: "sys_security_acl_role", sysId: JR5, fields: { sys_security_acl: ACL2, sys_user_role: R1 } },
    ]);
  }

  it("renders one exact matrix row per readable ACL, roles resolved and cells escaped", async () => {
    const fs = new DerivedMemoryFs();
    await buildAclTree(fs);
    const summary = await generateDerivedViews(fs, ROOT, derivedConfig());

    expect(summary.counts.aclRules).toBe(4);
    expect(fs.derivedFiles().get(derivedPath("acl", "matrix.md"))).toBe(
      [
        "# ACL matrix (D9)",
        "",
        "Regenerated from the canonical tree alone (INV-9, §5.12). Do not edit by hand.",
        "The canonical layer stays row-by-row; this view is the join.",
        "",
        "| name | type | operation | active | roles | sys_id |",
        "| --- | --- | --- | --- | --- | --- |",
        `| (unnamed) |  |  |  |  | ${ACL3} |`,
        `| a\\|b\\\\c\\r\\nd | record | write |  |  | ${ACL5} |`,
        `| incident | record | read | true | ${MISSING_ROLE}, admin | ${ACL1} |`,
        `| incident | record | read | true | admin | ${ACL2} |`,
        "",
      ].join("\n")
    );
  });

  it("names every skipped join and unreadable ACL (R3)", async () => {
    const fs = new DerivedMemoryFs();
    await buildAclTree(fs);
    const summary = await generateDerivedViews(fs, ROOT, derivedConfig());

    const details = summary.anomalies
      .filter((anomaly) => anomaly.source === "aclMatrix")
      .map((anomaly) => anomaly.detail);
    expect(details).toEqual([
      `sys_security_acl ${ACL4}: unreadable envelope; skipped`,
      `sys_security_acl_role ${JR3}: acl ${MISSING_ACL} is not in the tree; skipped (D2)`,
      `sys_security_acl_role ${JR4}: missing sys_security_acl or sys_user_role reference; skipped`,
    ]);
  });
});

describe("config flags", () => {
  const F1 = sysIdFor(0x501);
  const W1 = sysIdFor(0x502);
  const WV1 = sysIdFor(0x503);
  const ACL1 = sysIdFor(0x504);
  const I1 = sysIdFor(0x505);
  const DBO_USER = sysIdFor(0x506);
  const DICT = sysIdFor(0x507);

  async function buildSmallTree(fs: DerivedMemoryFs): Promise<void> {
    await buildCanonicalTree(fs, [
      { table: "sys_ui_form", sysId: F1, fields: { name: "incident" } },
      { table: "wf_workflow", sysId: W1, name: "Flow", fields: { name: "Flow" } },
      {
        table: "wf_workflow_version",
        sysId: WV1,
        fields: { workflow: W1, published: "true", version: "1" },
      },
      { table: "sys_security_acl", sysId: ACL1, fields: { name: "incident" } },
      { table: "sys_db_object", sysId: DBO_USER, fields: { name: "sys_user" } },
      {
        table: "sys_dictionary",
        sysId: DICT,
        fields: { internal_type: "reference", name: "incident", element: "assigned_to", reference: "sys_user" },
      },
      { table: "sys_user", sysId: sysIdFor(0x508), fields: {} },
      { table: "incident", sysId: I1, fields: { assigned_to: sysIdFor(0x5ff) } },
    ]);
  }

  const dirFor = (name: string): string => [ROOT, "_derived", name].join(sep);

  it.each([
    ["forms", "forms"],
    ["workflows", "workflows"],
    ["refs", "refs"],
    ["aclMatrix", "acl"],
  ] as const)("flag %s off leaves its directory absent while the others build", async (flag, dirName) => {
    const fs = new DerivedMemoryFs();
    await buildSmallTree(fs);
    const summary = await generateDerivedViews(fs, ROOT, derivedConfig({ [flag]: false }));

    expect(summary.views[flag]).toBe(false);
    expect(fs.dirs.has(dirFor(dirName))).toBe(false);
    for (const other of ["forms", "workflows", "refs", "acl"].filter((d) => d !== dirName)) {
      expect(fs.dirs.has(dirFor(other))).toBe(true);
    }
    expect(fs.derivedFiles().size).toBeGreaterThan(0);
  });

  it("a disabled refs view reports zero dangling refs and zero counts", async () => {
    const fs = new DerivedMemoryFs();
    await buildSmallTree(fs);
    const summary = await generateDerivedViews(fs, ROOT, derivedConfig({ refs: false }));

    expect(summary.danglingRefs).toEqual([]);
    expect(summary.counts.refScopes).toBe(0);
    expect(summary.counts.refRecords).toBe(0);
  });

  it("turning a flag off after a full run removes the now-disabled subtree", async () => {
    const fs = new DerivedMemoryFs();
    await buildSmallTree(fs);
    await generateDerivedViews(fs, ROOT, derivedConfig());
    expect(fs.dirs.has(dirFor("forms"))).toBe(true);

    await generateDerivedViews(fs, ROOT, derivedConfig({ forms: false }));
    expect(fs.dirs.has(dirFor("forms"))).toBe(false);
    expect(fs.dirs.has(dirFor("workflows"))).toBe(true);
  });

  it("all flags off leaves _derived/ without any managed subtree", async () => {
    const fs = new DerivedMemoryFs();
    await buildSmallTree(fs);
    const summary = await generateDerivedViews(fs, ROOT, derivedConfig({
      forms: false,
      workflows: false,
      refs: false,
      aclMatrix: false,
    }));

    expect(summary.filesWritten).toEqual([]);
    expect(fs.derivedFiles().size).toBe(0);
    expect(summary.counts).toEqual({
      formDocuments: 0,
      workflowDocuments: 0,
      unpublishedWorkflowVersions: 0,
      refScopes: 0,
      refRecords: 0,
      aclRules: 0,
    });
  });
});
