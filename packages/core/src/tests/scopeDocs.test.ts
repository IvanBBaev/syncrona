// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import path from "path";
import os from "os";
import { SN } from "@syncrona/types";
import {
  summarizeManifest,
  buildScopeMermaid,
  buildScopeDocBody,
  upsertDocsSection,
  wrapAutoSection,
  generateScopeDocs,
  DOCS_AUTO_START,
  DOCS_AUTO_END,
} from "../scopeDocs.js";

function sampleManifest(): SN.AppManifest {
  return {
    scope: "x_acme_app",
    tables: {
      sys_script_include: {
        records: {
          Beta: {
            name: "Beta",
            sys_id: "2",
            files: [{ name: "Beta.script.js", type: "js" }],
          },
          Alpha: {
            name: "Alpha",
            sys_id: "1",
            files: [{ name: "Alpha.script.js", type: "js" }],
          },
        },
      },
      sys_script: {
        records: {
          Rule1: {
            name: "Rule1",
            sys_id: "3",
            files: [{ name: "Rule1.script.js", type: "js" }],
          },
        },
      },
    },
  } as unknown as SN.AppManifest;
}

describe("scopeDocs", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-docs-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  it("summarizes a manifest with sorted, counted tables and records", () => {
    const summary = summarizeManifest(sampleManifest());
    expect(summary.scope).toBe("x_acme_app");
    expect(summary.tableCount).toBe(2);
    expect(summary.recordCount).toBe(3);
    expect(summary.fileCount).toBe(3);
    // Tables sorted alphabetically: sys_script before sys_script_include
    expect(summary.tables.map((t) => t.table)).toEqual([
      "sys_script",
      "sys_script_include",
    ]);
    // Records sorted alphabetically within a table
    expect(summary.tables[1].records.map((r) => r.name)).toEqual([
      "Alpha",
      "Beta",
    ]);
  });

  it("sorts tables, records and files by code unit, never by the machine's locale", () => {
    // Under the "da" locale localeCompare sorts "aa" as "å", after "z".
    const key = (v: string) => v.replace(/aa/g, "\uffff");
    const spy = jest
      .spyOn(String.prototype, "localeCompare")
      .mockImplementation(function (this: string, other: string) {
        return key(this) < key(other) ? -1 : key(this) > key(other) ? 1 : 0;
      });
    try {
      const summary = summarizeManifest({
        scope: "x_acme_app",
        tables: {
          u_zzz: { records: {} },
          u_aaa: { records: {} },
          u_ab: {
            records: {
              zz: { name: "zz", sys_id: "1", files: [] },
              aab: {
                name: "aab",
                sys_id: "2",
                files: [
                  { name: "zz.js", type: "js" },
                  { name: "aa.js", type: "js" },
                ],
              },
            },
          },
        },
      } as unknown as SN.AppManifest);
      expect(summary.tables.map((t) => t.table)).toEqual(["u_aaa", "u_ab", "u_zzz"]);
      expect(summary.tables[1].records.map((r) => r.name)).toEqual(["aab", "zz"]);
      expect(summary.tables[1].records[0].files).toEqual(["aa.js", "zz.js"]);
    } finally {
      spy.mockRestore();
    }
  });

  it("names a record without a name field by its manifest key, in a deterministic order", () => {
    // The key is the record's folder name, which every other consumer falls
    // back to (`record.name || key`); an undefined name rendered an empty row
    // and compared equal to everything, so the row order followed the input.
    const manifestWith = (records: Record<string, unknown>) =>
      ({ scope: "x_acme_app", tables: { u_t: { records } } }) as unknown as SN.AppManifest;
    const a = { sys_id: "1", files: [] };
    const b = { name: "Beta", sys_id: "2", files: [] };
    const c = { sys_id: "3", files: [] };
    const names = (manifest: SN.AppManifest) =>
      summarizeManifest(manifest).tables[0].records.map((r) => r.name);
    expect(names(manifestWith({ Charlie: c, Beta: b, Alpha: a }))).toEqual(["Alpha", "Beta", "Charlie"]);
    expect(names(manifestWith({ Alpha: a, Charlie: c, Beta: b }))).toEqual(["Alpha", "Beta", "Charlie"]);
  });

  it("renders a Mermaid flowchart linking the scope to each table", () => {
    const summary = summarizeManifest(sampleManifest());
    const mermaid = buildScopeMermaid(summary);
    expect(mermaid).toContain("```mermaid");
    expect(mermaid).toContain("flowchart LR");
    expect(mermaid).toContain('scope["x_acme_app"]');
    expect(mermaid).toContain("scope --> t0");
    expect(mermaid).toContain("scope --> t1");
  });

  it("builds a doc body with overview, tables, and known descriptions", () => {
    const summary = summarizeManifest(sampleManifest());
    const body = buildScopeDocBody(summary, new Date("2026-01-02T03:04:05Z"));
    expect(body).toContain("## Overview");
    expect(body).toContain("- Scope: `x_acme_app`");
    expect(body).toContain("- Tables: 2");
    expect(body).toContain("Script Includes");
    expect(body).toContain("Business Rules");
    expect(body).toContain("2026-01-02T03:04:05.000Z");
  });

  describe("upsertDocsSection (logical update)", () => {
    const autoBlock = wrapAutoSection("AUTO CONTENT");

    it("creates a titled document when there is no existing content", () => {
      const out = upsertDocsSection("", "x_acme_app", autoBlock);
      expect(out).toContain("# Scope: x\\_acme\\_app");
      expect(out).toContain(DOCS_AUTO_START);
      expect(out).toContain("AUTO CONTENT");
    });

    it("replaces only the marked block, preserving manual content", () => {
      const existing = `# Scope: x_acme_app\n\nManual notes here.\n\n${DOCS_AUTO_START}\nOLD AUTO\n${DOCS_AUTO_END}\n\nMore manual notes.\n`;
      const out = upsertDocsSection(existing, "x_acme_app", autoBlock);
      expect(out).toContain("Manual notes here.");
      expect(out).toContain("More manual notes.");
      expect(out).toContain("AUTO CONTENT");
      expect(out).not.toContain("OLD AUTO");
    });

    it("appends the block when markers are absent but content exists", () => {
      const out = upsertDocsSection(
        "# My hand-written doc\n",
        "x_acme_app",
        autoBlock
      );
      expect(out).toContain("# My hand-written doc");
      expect(out).toContain("AUTO CONTENT");
    });

    it("ignores a marker that is not on a line of its own", () => {
      // A generated name quoting the end marker used to end the block early, so
      // the next run kept the rest of the old block as if it were manual notes.
      const existing = `${DOCS_AUTO_START}\n| \`${DOCS_AUTO_END}\` | — |\nOLD AUTO\n${DOCS_AUTO_END}\n\nManual.\n`;
      const out = upsertDocsSection(existing, "x_acme_app", autoBlock);
      expect(out).toBe(`${autoBlock}\n\nManual.\n`);
    });

    it("ends the block at the first end marker after the start marker", () => {
      // An end marker quoted in the notes above the block used to make the
      // update append a second block instead of replacing the first.
      const existing = `Notes:\n${DOCS_AUTO_END}\n\n${DOCS_AUTO_START}\nOLD AUTO\n${DOCS_AUTO_END}\n`;
      const out = upsertDocsSection(existing, "x_acme_app", autoBlock);
      expect(out).toBe(`Notes:\n${DOCS_AUTO_END}\n\n${autoBlock}\n`);
    });

    it("refuses a start marker without an end marker instead of appending a second block", () => {
      // Appending kept the orphan start, which the next run paired with the new
      // block's end marker, deleting the manual notes between them.
      const existing = `# T\n\n${DOCS_AUTO_START}\nold\n\n## Notes\nmine\n`;
      expect(() => upsertDocsSection(existing, "x_acme_app", autoBlock)).toThrow(
        `no ${DOCS_AUTO_END} line after it`
      );
    });

    it("finds markers in a CRLF file", () => {
      const existing = `Manual.\r\n${DOCS_AUTO_START}\r\nOLD AUTO\r\n${DOCS_AUTO_END}\r\n`;
      const out = upsertDocsSection(existing, "x_acme_app", autoBlock);
      expect(out).toBe(`Manual.\r\n${autoBlock}\r\n`);
    });
  });

  it("renders instance-supplied names as data, not Markdown", () => {
    const manifest: SN.AppManifest = {
      scope: "x_acme_app",
      tables: {
        "x_t|bad": {
          records: {
            r1: {
              name: "a|b\n<img src=x>*",
              sys_id: "1",
              files: [{ name: "x`|`y.js", type: "js" }],
            },
          },
        },
      },
    } as unknown as SN.AppManifest;
    const body = buildScopeDocBody(summarizeManifest(manifest), new Date(0));
    const rows = body.split("\n").filter((line) => line.startsWith("| "));
    // One row per record and per table, each still two/four cells wide.
    expect(rows).toContain("| a\\|b \\<img src=x\\>\\* | ``x`\\|`y.js`` |");
    expect(rows).toContain(
      "| `x_t\\|bad` | Records from the `x_t\\|bad` table. | 1 | 1 |"
    );
    expect(body).toContain("### `x_t|bad`");
    expect(body).not.toMatch(/(^|[^\\])<img/m);
  });

  it("writes and then logically updates the scope doc file", async () => {
    const first = await generateScopeDocs(sampleManifest(), {
      outDir: tempDir,
      now: new Date("2026-01-02T03:04:05Z"),
    });
    expect(first).toBe(path.join(tempDir, "x_acme_app.md"));

    // Add manual notes outside the auto block, then regenerate.
    const original = await fs.promises.readFile(first, "utf8");
    await fs.promises.writeFile(
      first,
      original + "\n## My manual section\nKeep me.\n"
    );

    const changed = sampleManifest();
    changed.tables.sys_script_include.records.Gamma = {
      name: "Gamma",
      sys_id: "3",
      files: [{ name: "Gamma.script.js", type: "js" }],
    } as unknown as SN.AppManifest["tables"][string]["records"][string];
    const second = await generateScopeDocs(changed, {
      outDir: tempDir,
      now: new Date("2026-02-02T03:04:05Z"),
    });
    const updated = await fs.promises.readFile(second, "utf8");
    expect(updated).toContain("## My manual section");
    expect(updated).toContain("Keep me.");
    expect(updated).toContain("2026-02-02T03:04:05.000Z");
    expect(updated).not.toContain("2026-01-02T03:04:05.000Z");
  });

  it("leaves an unchanged doc alone instead of only bumping its timestamp", async () => {
    const file = await generateScopeDocs(sampleManifest(), {
      outDir: tempDir,
      now: new Date("2026-01-02T03:04:05Z"),
    });
    const crlf = (await fs.promises.readFile(file, "utf8")).replace(/\n/g, "\r\n") + "Notes.\r\n";
    await fs.promises.writeFile(file, crlf);

    await generateScopeDocs(sampleManifest(), {
      outDir: tempDir,
      now: new Date("2026-03-02T03:04:05Z"),
    });
    expect(await fs.promises.readFile(file, "utf8")).toBe(crlf);
  });

  it("escapes emphasis and entity characters in record names", () => {
    const manifest: SN.AppManifest = {
      scope: "x_acme_app",
      tables: {
        sys_script: {
          records: { r1: { name: "_init_ &lt;", sys_id: "1", files: [] } },
        },
      },
    } as unknown as SN.AppManifest;
    const body = buildScopeDocBody(summarizeManifest(manifest), new Date(0));
    expect(body).toContain("| \\_init\\_ \\&lt; | — |");
  });

  // INJ-1: the scope comes from the manifest, i.e. ultimately from the
  // instance, and used to be interpolated straight into the filename. A scope
  // holding a separator or ".." wrote a Markdown file anywhere the process can
  // reach — outside outDir, over an existing file.
  it("fails instead of overwriting a doc it could not read", async () => {
    // A directory in the doc's place reads with EISDIR rather than ENOENT; the
    // read error used to be taken as "no doc yet" and the write attempted anyway.
    fs.mkdirSync(path.join(tempDir, "x_acme_app.md"));
    await expect(generateScopeDocs(sampleManifest(), { outDir: tempDir })).rejects.toMatchObject({
      code: "EISDIR",
      syscall: "read",
    });
  });

  it("refuses to write a doc for a scope that is not a safe filename", async () => {
    const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-docs-out-"));
    const victim = path.join(outsideDir, "escaped.md");
    try {
      for (const scope of ["../escaped", "..\\escaped", "..", "sub/escaped"]) {
        const manifest = { ...sampleManifest(), scope } as SN.AppManifest;
        await expect(generateScopeDocs(manifest, { outDir: tempDir })).rejects.toThrow(
          /unsafe scope name/
        );
      }
      expect(fs.existsSync(victim)).toBe(false);
      expect(fs.readdirSync(tempDir)).toEqual([]);
    } finally {
      fs.rmSync(outsideDir, { recursive: true, force: true });
    }
  });
});
