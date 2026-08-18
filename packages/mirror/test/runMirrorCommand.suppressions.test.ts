// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * D7 — the suppression manifest in `coverage.json` (WP-M8).
 *
 * D7's bargain: the mirror may hold fields back from `record.json` — engine
 * noise, user-configured ignores, redaction denials — but every withheld field
 * is ENUMERATED in the coverage report, with its source named. A diff reader
 * who wonders why a field never changes must be able to look it up rather than
 * discover the suppression by induction.
 *
 * The run here exercises all three sources at once against the fixture corpus:
 *
 *  - `builtin-noise`: the three engine-noise fields appear ONCE each, under the
 *    wildcard table `"*"` — and never again per table, because a manifest that
 *    repeated `sys_updated_on` for every discovered table would bury the rows a
 *    reader actually needs;
 *  - `config-ignore`: a per-table `ignoreFields` entry from the loaded config;
 *  - `redaction-deny`: the corpus's `sys_update_set_source.password` column,
 *    whose `password2` type the redactor refuses on sight.
 *
 * The assertions read the manifest from the FILE on disk, not just the returned
 * object — D7 is a promise to the repository's readers, and the file is what
 * they read.
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { LFS_THRESHOLD_BYTES } from "../src/constants";
import type { CoverageReport, MirrorConfig } from "../src/contracts";
import { MirrorHttpClient } from "../src/http/client";
import { COVERAGE_REL_PATH } from "../src/report/coverageReport";
import { runMirrorCommand } from "../src/runMirrorCommand";
import { nodeWriterFs } from "../src/write/fs";
import {
  BULK_TABLE_NAME,
  DEFAULT_CREDENTIALS,
  FakeInstanceServer,
  loadCommittedCorpus,
} from "./fakeInstance";

const FROZEN_NOW = "2026-03-01T10:00:00.000Z";
const SWEEP_ID = "sweep-suppress-0001";

const basicAuth = (): string =>
  `Basic ${Buffer.from(`${DEFAULT_CREDENTIALS.username}:${DEFAULT_CREDENTIALS.password}`, "utf8").toString("base64")}`;

const configOf = (): MirrorConfig => ({
  formatVersion: 1,
  scopes: "all",
  tiers: { referenceData: false },
  tables: {
    include: [],
    exclude: [BULK_TABLE_NAME, "sys_ui_action"],
    perTable: { sys_script: { ignoreFields: ["description"] } },
  },
  attachments: { enabled: false, lfsThresholdBytes: LFS_THRESHOLD_BYTES },
  redaction: { propertyAllowlist: [] },
  derived: { forms: false, workflows: false, refs: false, aclMatrix: false },
  sync: { reconcileEveryNSyncs: 10, requestsPerSecond: 4, pageSize: 1000 },
  diffIgnore: [],
});

describe("runMirrorCommand suppression manifest (D7)", () => {
  it("enumerates builtin-noise, config-ignore and redaction-deny rows in coverage.json", async () => {
    const server = await FakeInstanceServer.start({ corpus: loadCommittedCorpus() });
    const root = await mkdtemp(join(tmpdir(), "syncrona-mirror-suppress-"));
    try {
      const run = await runMirrorCommand({
        config: configOf(),
        root,
        fs: nodeWriterFs(),
        now: () => FROZEN_NOW,
        newSweepId: () => SWEEP_ID,
        full: true,
        client: new MirrorHttpClient({
          instance: server.baseUrl,
          headers: { Authorization: basicAuth() },
          pageSize: 5,
          sleep: () => Promise.resolve(),
          now: () => 0,
          random: () => 0.5,
        }),
      });

      expect(run.exitCode).toBe(0);

      // The manifest is judged as READ FROM DISK — the file is the promise.
      const written = JSON.parse(
        (await readFile(join(root, COVERAGE_REL_PATH))).toString("utf8")
      ) as CoverageReport;
      expect(written.suppressions).toEqual(run.report.suppressions);
      const suppressions = written.suppressions;

      // Engine noise: once each, under the wildcard table.
      for (const field of ["sys_mod_count", "sys_updated_by", "sys_updated_on"]) {
        expect(suppressions).toContainEqual({ table: "*", field, source: "builtin-noise" });
      }
      // …and NEVER per table: the wildcard is the whole story for builtin noise.
      const builtinRows = suppressions.filter((row) => row.source === "builtin-noise");
      expect(builtinRows).toHaveLength(3);
      for (const row of builtinRows) {
        expect(row.table).toBe("*");
      }

      // The user's own ignore, named with its table and its source.
      expect(suppressions).toContainEqual({
        table: "sys_script",
        field: "description",
        source: "config-ignore",
      });

      // The redactor's denial: a password2 column never reaches record.json,
      // and D7 says so out loud.
      expect(suppressions).toContainEqual({
        table: "sys_update_set_source",
        field: "password",
        source: "redaction-deny",
      });

      // The manifest is deterministically ordered — bytewise by (table, field,
      // source) — so INV-1 holds for the report too. The joiner is NUL because it
      // cannot occur in any of the three parts, so the comparison sorts on the
      // tuple rather than on an accidental run-together of adjacent fields.
      const keys = suppressions.map((row) => `${row.table}\u0000${row.field}\u0000${row.source}`);
      expect(keys).toEqual([...keys].sort());

      server.assertNoViolations();
    } finally {
      await server.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30000);
});
