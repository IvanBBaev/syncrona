// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * INV-9 as a property, plus the reader's error stance under hostile trees.
 *
 * The first block is the invariant itself, three ways: regenerate over an
 * existing `_derived/` → identical bytes; delete `_derived/` and regenerate →
 * identical bytes; seed the same records in reverse and reverse every
 * directory listing → identical bytes. The third is the sharpest — any byte
 * that depends on enumeration order instead of `compareBytewise` shows up as a
 * diff between two trees that differ ONLY in enumeration order.
 *
 * The second block pins the error taxonomy: a corrupt shard manifest is fatal
 * (`ShardManifestCorrupt` — the index of the canonical layer is broken), while
 * a wounded `record.json` is a named per-record anomaly (R3) that must not
 * veto the run. The hostile-`instance/` cases pin which directory names are
 * skipped silently (files, staging leftovers, shard-less directories) versus
 * skipped WITH a name in the anomaly list (unsafe path components).
 *
 * The source-scan test is the bluntest INV-9 guard: no module under
 * `src/derived/` may even mention a clock, randomness, or the network.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, sep } from "node:path";

import { generateDerivedViews } from "../src/derived/derivedViews";
import { encodeUtf8 } from "../src/serialize/serializer";
import { ShardManifestCorrupt } from "../src/shards/shardLayout";
import type { FixtureRecord } from "./derivedFixture";
import {
  DerivedMemoryFs,
  ROOT,
  buildCanonicalTree,
  derivedConfig,
  reversedListingFs,
  sysIdFor,
} from "./derivedFixture";

/** A corpus that exercises all four views, including one dangling reference. */
function richCorpus(): FixtureRecord[] {
  const V = sysIdFor(0x601);
  const F1 = sysIdFor(0x602);
  const S = sysIdFor(0x604);
  const W = sysIdFor(0x610);
  const WV = sysIdFor(0x611);
  const A = sysIdFor(0x612);
  const B = sysIdFor(0x613);
  const U = sysIdFor(0x623);
  const ACL = sysIdFor(0x630);
  const R = sysIdFor(0x631);
  return [
    { table: "sys_ui_view", sysId: V, name: "Mobile", fields: { name: "Mobile" } },
    { table: "sys_ui_form", sysId: F1, fields: { name: "incident" } },
    { table: "sys_ui_form", sysId: sysIdFor(0x603), fields: { name: "incident", view: V } },
    { table: "sys_ui_section", sysId: S, fields: { caption: "Details" } },
    {
      table: "sys_ui_form_section",
      sysId: sysIdFor(0x605),
      fields: { sys_ui_form: F1, sys_ui_section: S, position: "0" },
    },
    {
      table: "sys_ui_element",
      sysId: sysIdFor(0x606),
      fields: { sys_ui_section: S, element: "number", position: "0" },
    },
    { table: "wf_workflow", sysId: W, name: "Flow", fields: { name: "Flow" } },
    {
      table: "wf_workflow_version",
      sysId: WV,
      fields: { workflow: W, published: "true", version: "1" },
    },
    { table: "wf_activity", sysId: A, fields: { workflow_version: WV, name: "Begin" } },
    { table: "wf_activity", sysId: B, fields: { workflow_version: WV, name: "End" } },
    { table: "wf_transition", sysId: sysIdFor(0x614), fields: { from: A, to: B } },
    { table: "sys_db_object", sysId: sysIdFor(0x620), fields: { name: "sys_user" } },
    { table: "sys_db_object", sysId: sysIdFor(0x621), fields: { name: "incident" } },
    {
      table: "sys_dictionary",
      sysId: sysIdFor(0x622),
      fields: { internal_type: "reference", name: "incident", element: "assigned_to", reference: "sys_user" },
    },
    { table: "sys_user", sysId: U, name: "Abel Tuter", fields: { name: "Abel Tuter" } },
    { table: "incident", sysId: sysIdFor(0x624), fields: { assigned_to: U } },
    { table: "incident", sysId: sysIdFor(0x625), fields: { assigned_to: sysIdFor(0x6ff) } },
    { table: "incident", sysId: sysIdFor(0x626), scope: "x_app", fields: {} },
    {
      table: "sys_security_acl",
      sysId: ACL,
      fields: { name: "incident", type: "record", operation: "read" },
    },
    { table: "sys_user_role", sysId: R, name: "admin", fields: { name: "admin" } },
    {
      table: "sys_security_acl_role",
      sysId: sysIdFor(0x632),
      fields: { sys_security_acl: ACL, sys_user_role: R },
    },
  ];
}

describe("INV-9 byte identity", () => {
  it("a second run over the same tree reproduces every byte and the summary", async () => {
    const fs = new DerivedMemoryFs();
    await buildCanonicalTree(fs, richCorpus());
    const first = await generateDerivedViews(fs, ROOT, derivedConfig());
    const firstFiles = fs.derivedFiles();
    expect(firstFiles.size).toBeGreaterThan(0);
    expect(first.danglingRefs).toHaveLength(1);

    const second = await generateDerivedViews(fs, ROOT, derivedConfig());
    expect(fs.derivedFiles()).toEqual(firstFiles);
    expect(second).toEqual(first);
  });

  it("deleting _derived/ and regenerating reproduces every byte (§5.12)", async () => {
    const fs = new DerivedMemoryFs();
    await buildCanonicalTree(fs, richCorpus());
    await generateDerivedViews(fs, ROOT, derivedConfig());
    const firstFiles = fs.derivedFiles();

    await fs.removeRecursive([ROOT, "_derived"].join(sep));
    expect(fs.derivedFiles().size).toBe(0);
    await generateDerivedViews(fs, ROOT, derivedConfig());
    expect(fs.derivedFiles()).toEqual(firstFiles);
  });

  it("reversed seeding order plus reversed directory listings changes nothing", async () => {
    const straight = new DerivedMemoryFs();
    await buildCanonicalTree(straight, richCorpus());
    const straightSummary = await generateDerivedViews(straight, ROOT, derivedConfig());

    const reversed = new DerivedMemoryFs();
    await buildCanonicalTree(reversed, [...richCorpus()].reverse());
    const reversedSummary = await generateDerivedViews(
      reversedListingFs(reversed),
      ROOT,
      derivedConfig()
    );

    expect(reversed.derivedFiles()).toEqual(straight.derivedFiles());
    expect(reversedSummary).toEqual(straightSummary);
  });

  it("a hand-parked file directly under _derived/ survives regeneration", async () => {
    const fs = new DerivedMemoryFs();
    await buildCanonicalTree(fs, richCorpus());
    const notesPath = [ROOT, "_derived", "notes.md"].join(sep);
    await fs.makeDir([ROOT, "_derived"].join(sep));
    await fs.writeFile(notesPath, encodeUtf8("keep me\n"));

    await generateDerivedViews(fs, ROOT, derivedConfig());
    expect(new TextDecoder().decode(fs.files.get(notesPath))).toBe("keep me\n");
  });

  it("no module under src/derived/ mentions a clock, randomness, or the network", async () => {
    const dir = join(__dirname, "..", "src", "derived");
    const names = (await readdir(dir)).filter((name) => name.endsWith(".ts"));
    expect(names.length).toBeGreaterThanOrEqual(6);
    for (const name of names) {
      const source = await readFile(join(dir, name), "utf8");
      for (const forbidden of ["Date.now", "new Date(", "Math.random", "fetch("]) {
        expect(`${name}: ${source.includes(forbidden)}`).toBe(`${name}: false`);
      }
    }
  });
});

describe("hostile trees", () => {
  it("a corrupt shard manifest is fatal: ShardManifestCorrupt propagates", async () => {
    const fs = new DerivedMemoryFs();
    await buildCanonicalTree(fs, richCorpus());
    const manifestPath = [ROOT, "instance", "global", "incident", ".shards", "all.json"].join(sep);
    expect(fs.files.has(manifestPath)).toBe(true);
    fs.files.set(manifestPath, encodeUtf8("garbage"));

    await expect(generateDerivedViews(fs, ROOT, derivedConfig())).rejects.toThrow(
      ShardManifestCorrupt
    );
  });

  it("wounded record.json files are named per-record anomalies, never a veto", async () => {
    const MISSING = sysIdFor(0x701);
    const UNPARSEABLE = sysIdFor(0x702);
    const NUMBER = sysIdFor(0x703);
    const NULL = sysIdFor(0x704);
    const ARRAY = sysIdFor(0x705);
    const NON_STRING = sysIdFor(0x706);
    const fs = new DerivedMemoryFs();
    await buildCanonicalTree(fs, [
      { table: "sys_db_object", sysId: MISSING, omitEnvelope: true },
      { table: "sys_db_object", sysId: UNPARSEABLE, envelopeText: "not-json{{" },
      { table: "sys_db_object", sysId: NUMBER, envelopeText: "42" },
      { table: "sys_db_object", sysId: NULL, envelopeText: "null" },
      { table: "sys_db_object", sysId: ARRAY, envelopeText: "[]" },
      // A parsed JSON-blob column is not a wound: the non-string value is
      // simply not a flat field, and the row reads fine.
      {
        table: "sys_db_object",
        sysId: NON_STRING,
        envelopeText: `{"sys_id":"${NON_STRING}","name":"blobbed","blob":{"nested":1}}`,
      },
    ]);
    const summary = await generateDerivedViews(fs, ROOT, derivedConfig());

    // Every wounded record still participates through its shard entry.
    expect(summary.counts.refRecords).toBe(6);
    expect(summary.counts.refScopes).toBe(1);
    const details = summary.anomalies
      .filter((anomaly) => anomaly.source === "tree")
      .map((anomaly) => anomaly.detail);
    expect(details).toHaveLength(5);
    expect(details).toEqual(
      expect.arrayContaining([
        expect.stringContaining(`sys_db_object/${MISSING} (global): record.json missing under `),
        expect.stringContaining(`sys_db_object/${UNPARSEABLE} (global): record.json does not parse: `),
        `sys_db_object/${NUMBER} (global): record.json is not a JSON object envelope`,
        `sys_db_object/${NULL} (global): record.json is not a JSON object envelope`,
        `sys_db_object/${ARRAY} (global): record.json is not a JSON object envelope`,
      ])
    );
  });

  it("an empty-string field means absent — the serializer never writes one (§7.2)", async () => {
    const F = sysIdFor(0x710);
    const fs = new DerivedMemoryFs();
    await buildCanonicalTree(fs, [
      {
        table: "sys_ui_form",
        sysId: F,
        envelopeText: `{"sys_id":"${F}","name":"incident","view":""}`,
      },
    ]);
    const summary = await generateDerivedViews(fs, ROOT, derivedConfig());

    expect(summary.counts.formDocuments).toBe(1);
    const doc = fs
      .derivedFiles()
      .get([ROOT, "_derived", "forms", "incident", "Default.md"].join(sep));
    expect(doc).toContain(`## Form ${F} (scope global)`);
  });

  it("a sys_id claimed by two scopes is reported, indexed in both, deduped for lookups", async () => {
    const DUP = sysIdFor(0x700);
    const fs = new DerivedMemoryFs();
    await buildCanonicalTree(fs, [
      { table: "incident", sysId: DUP, scope: "a_scope", name: "from-a", fields: {} },
      { table: "incident", sysId: DUP, scope: "b_scope", name: "from-b", fields: {} },
    ]);
    const summary = await generateDerivedViews(fs, ROOT, derivedConfig());

    expect(
      summary.anomalies.filter((anomaly) => anomaly.source === "tree").map((a) => a.detail)
    ).toEqual([
      `incident/${DUP}: claimed by shard sets of both a_scope and b_scope; derived lookups use a_scope`,
    ]);
    expect(summary.counts.refRecords).toBe(2);
    const files = fs.derivedFiles();
    expect(files.get([ROOT, "_derived", "refs", "a_scope.md"].join(sep))).toContain(
      `| ${DUP} | incident | from-a |`
    );
    expect(files.get([ROOT, "_derived", "refs", "b_scope.md"].join(sep))).toContain(
      `| ${DUP} | incident | from-b |`
    );
  });

  it("hostile instance/ children: unsafe names are named, the rest skipped silently", async () => {
    const fs = new DerivedMemoryFs();
    await buildCanonicalTree(fs, [{ table: "incident", sysId: sysIdFor(0x720), fields: {} }]);
    await fs.writeFile([ROOT, "instance", "stray.txt"].join(sep), encodeUtf8("x"));
    await fs.makeDir([ROOT, "instance", ".mirror-tmp-x"].join(sep));
    await fs.makeDir([ROOT, "instance", "..."].join(sep));
    await fs.writeFile([ROOT, "instance", "global", "stray2.txt"].join(sep), encodeUtf8("x"));
    await fs.makeDir([ROOT, "instance", "global", ".mirror-tmp-y"].join(sep));
    await fs.makeDir([ROOT, "instance", "global", "..."].join(sep));
    await fs.makeDir([ROOT, "instance", "global", "notatable"].join(sep));
    const summary = await generateDerivedViews(fs, ROOT, derivedConfig());

    expect(summary.anomalies).toEqual([
      {
        source: "tree",
        detail: 'instance/ contains a directory whose name is not a safe path component: "..."; not treated as a scope',
      },
      {
        source: "tree",
        detail: 'scope global contains a directory whose name is not a safe path component: "..."; not treated as a table',
      },
    ]);
    expect(summary.counts.refRecords).toBe(1);
  });

  it("an empty repo yields exactly the empty ACL matrix and all-zero counts", async () => {
    const fs = new DerivedMemoryFs();
    const summary = await generateDerivedViews(fs, ROOT, derivedConfig());

    expect(summary.filesWritten).toEqual(["_derived/acl/matrix.md"]);
    expect(summary.counts).toEqual({
      formDocuments: 0,
      workflowDocuments: 0,
      unpublishedWorkflowVersions: 0,
      refScopes: 0,
      refRecords: 0,
      aclRules: 0,
    });
    expect(summary.danglingRefs).toEqual([]);
    expect(summary.anomalies).toEqual([]);
  });
});
