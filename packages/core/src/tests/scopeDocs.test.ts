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
} from "../scopeDocs";

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
      expect(out).toContain("# Scope: x_acme_app");
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

    const second = await generateScopeDocs(sampleManifest(), {
      outDir: tempDir,
      now: new Date("2026-02-02T03:04:05Z"),
    });
    const updated = await fs.promises.readFile(second, "utf8");
    expect(updated).toContain("## My manual section");
    expect(updated).toContain("Keep me.");
    expect(updated).toContain("2026-02-02T03:04:05.000Z");
    expect(updated).not.toContain("2026-01-02T03:04:05.000Z");
  });
});
