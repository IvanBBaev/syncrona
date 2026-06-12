import fs from "fs";
import path from "path";
import os from "os";
import {
  formatEnvValue,
  upsertEnvVars,
  writeDotEnv,
  ensureGitignored,
} from "../envFile";

describe("envFile", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-env-"));
  });

  afterEach(async () => {
    await fs.promises.rm(tempDir, { recursive: true, force: true });
  });

  describe("formatEnvValue", () => {
    it("returns safe values verbatim", () => {
      expect(formatEnvValue("dev123.service-now.com")).toBe(
        "dev123.service-now.com"
      );
      expect(formatEnvValue("admin")).toBe("admin");
    });

    it("quotes values with spaces or special characters", () => {
      expect(formatEnvValue("p@ss word")).toBe('"p@ss word"');
      expect(formatEnvValue("has#hash")).toBe('"has#hash"');
    });

    it("escapes backslashes and double quotes", () => {
      expect(formatEnvValue('a"b\\c')).toBe('"a\\"b\\\\c"');
    });

    it("strips newlines", () => {
      expect(formatEnvValue("line1\nline2")).toBe("line1line2");
    });
  });

  describe("upsertEnvVars", () => {
    it("creates keys when file is empty", () => {
      const out = upsertEnvVars("", {
        SN_INSTANCE: "dev.service-now.com",
        SN_USER: "admin",
      });
      expect(out).toBe("SN_INSTANCE=dev.service-now.com\nSN_USER=admin\n");
    });

    it("replaces existing keys in place and preserves unrelated ones", () => {
      const existing = "SN_INSTANCE=old.com\nOTHER=keep\nSN_USER=olduser\n";
      const out = upsertEnvVars(existing, {
        SN_INSTANCE: "new.com",
        SN_USER: "newuser",
      });
      expect(out).toBe("SN_INSTANCE=new.com\nOTHER=keep\nSN_USER=newuser\n");
    });

    it("appends missing keys after preserved content", () => {
      const out = upsertEnvVars("OTHER=keep\n", { SN_PASSWORD: "secret" });
      expect(out).toBe("OTHER=keep\nSN_PASSWORD=secret\n");
    });
  });

  describe("writeDotEnv", () => {
    it("writes instance and credentials, preserving other vars", async () => {
      const envPath = path.join(tempDir, ".env");
      await fs.promises.writeFile(envPath, "SYNCRONA_OTHER=1\n");
      await writeDotEnv(envPath, {
        SN_INSTANCE: "dev.service-now.com",
        SN_USER: "admin",
        SN_PASSWORD: "secret",
      });
      const content = await fs.promises.readFile(envPath, "utf8");
      expect(content).toContain("SYNCRONA_OTHER=1");
      expect(content).toContain("SN_INSTANCE=dev.service-now.com");
      expect(content).toContain("SN_USER=admin");
      expect(content).toContain("SN_PASSWORD=secret");
    });
  });

  describe("ensureGitignored", () => {
    it("adds the entry when missing and is idempotent", async () => {
      const added = await ensureGitignored(tempDir, ".env");
      expect(added).toBe(true);
      const again = await ensureGitignored(tempDir, ".env");
      expect(again).toBe(false);
      const content = await fs.promises.readFile(
        path.join(tempDir, ".gitignore"),
        "utf8"
      );
      expect(content.split("\n").filter((l) => l.trim() === ".env")).toHaveLength(
        1
      );
    });
  });
});
