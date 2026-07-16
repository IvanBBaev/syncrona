// SPDX-License-Identifier: GPL-3.0-or-later
import fs from "fs";
import path from "path";
import os from "os";
import dotenv from "dotenv";
import {
  formatEnvValue,
  upsertEnvVars,
  writeDotEnv,
  ensureGitignored,
} from "../envFile.js";

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

    it("wraps values with spaces or special characters in single quotes", () => {
      expect(formatEnvValue("p@ss word")).toBe("'p@ss word'");
      expect(formatEnvValue("has#hash")).toBe("'has#hash'");
    });

    // Single-quoted dotenv values are literal: dotenv does NOT un-escape
    // backslashes inside them, so a backslash-bearing value must NOT be escaped.
    it("wraps backslash- and quote-bearing values in single quotes without escaping", () => {
      expect(formatEnvValue('a"b\\c')).toBe("'a\"b\\c'");
      expect(formatEnvValue("Win\\2026")).toBe("'Win\\2026'");
    });

    it("strips newlines", () => {
      expect(formatEnvValue("line1\nline2")).toBe("line1line2");
    });

    // The whole point of the quoting scheme is that a value written to a .env
    // parses back to the exact original. dotenv (v17) treats double-quoted
    // values as escape-expanding (\n, \r) and only single-quoted values as
    // fully literal, so we verify the real parser round-trips each tricky case.
    it("round-trips every value type through dotenv.parse", () => {
      const cases = [
        "Win\\2026",
        'a"b',
        "a'b",
        "p@ss word",
        "has#hash",
        "back\\slashes",
        "plain-value",
      ];
      for (const original of cases) {
        const line = `SN_VALUE=${formatEnvValue(original)}`;
        const parsed = dotenv.parse(line);
        expect(parsed.SN_VALUE).toBe(original);
      }
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

    // chmod is a no-op on Windows; the .env carries plaintext credentials, so on
    // POSIX it must end up owner-only (0o600) even when the file pre-existed with
    // looser permissions.
    const itPosix = process.platform === "win32" ? it.skip : it;
    itPosix("restricts an existing .env to owner-only (0o600)", async () => {
      const envPath = path.join(tempDir, ".env");
      await fs.promises.writeFile(envPath, "SYNCRONA_OTHER=1\n", { mode: 0o644 });
      await fs.promises.chmod(envPath, 0o644); // ensure loose perms regardless of umask
      await writeDotEnv(envPath, { SN_PASSWORD: "secret" });
      const mode = (await fs.promises.stat(envPath)).mode & 0o777;
      expect(mode).toBe(0o600);
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
