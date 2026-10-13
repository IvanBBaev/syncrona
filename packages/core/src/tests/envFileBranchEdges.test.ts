// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import dotenv from "dotenv";

// Covers the edge branches of envFile that the main suite leaves out: a
// nullish value, a platform where chmod is unsupported (writeDotEnv must still
// write the file), and a .gitignore that does not end with a newline (the new
// entry must land on its own line, not be glued to the last one).

const realFs = await import("fs");
const chmod = jest.fn<(p: fs.PathLike, mode: fs.Mode) => Promise<void>>();

jest.unstable_mockModule("fs", () => {
  const promises = {
    ...realFs.promises,
    chmod: (p: fs.PathLike, mode: fs.Mode) => chmod(p, mode),
  };
  return { ...realFs, default: { ...realFs.default, promises }, promises };
});

const { formatEnvValue, upsertEnvVars, writeDotEnv, ensureGitignored } =
  await import("../envFile.js");

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-env-edges-"));
  chmod.mockReset();
  chmod.mockImplementation((p, mode) => realFs.promises.chmod(p, mode));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe("formatEnvValue — nullish input", () => {
  // Callers pass prompt answers straight through; an unanswered (undefined or
  // null) value must become an explicit empty string, never the text "undefined".
  it.each([undefined, null])("writes %p as an empty quoted value", (value) => {
    const formatted = formatEnvValue(value as unknown as string);
    expect(formatted).toBe("''");
    expect(dotenv.parse(`K=${formatted}\n`).K).toBe("");
  });

  it("quotes an empty string rather than writing a bare KEY=", () => {
    expect(formatEnvValue("")).toBe("''");
  });

  it("quotes a value that is empty once its newlines are stripped", () => {
    expect(formatEnvValue("\r\n")).toBe("''");
  });
});

describe("formatEnvValue — a value single quotes cannot carry", () => {
  // dotenv ends a single-quoted value at the first ' followed by a comment, so
  // 'p' #1' read back as "p": the stored password was silently cut short.
  it.each(["p' #1", "a'#b", "x '  # y"])("round-trips %p in another quoting", (value) => {
    const formatted = formatEnvValue(value);
    expect(dotenv.parse(`K=${formatted}\n`).K).toBe(value);
  });

  it("falls back to double quotes when the value also holds a backtick", () => {
    const value = "p' #`1";
    const formatted = formatEnvValue(value);
    expect(formatted).toBe(`"${value}"`);
    expect(dotenv.parse(`K=${formatted}\n`).K).toBe(value);
  });

  it("refuses a value that no quoting reads back verbatim", () => {
    expect(() => formatEnvValue("a' #`b\"c")).toThrow(/cannot hold verbatim/);
  });
});

describe("upsertEnvVars — line shapes", () => {
  it("leaves comments and non-assignment lines untouched while replacing a key", () => {
    const out = upsertEnvVars("# header\nnot an assignment\nA=1\n", { A: "2" });
    expect(out).toBe("# header\nnot an assignment\nA=2\n");
  });

  it("collapses several trailing blank lines before appending new keys", () => {
    const out = upsertEnvVars("A=1\n\n\n   \n", { B: "2" });
    expect(out).toBe("A=1\nB=2\n");
  });

  // dotenv lets the last assignment win: keeping a later duplicate would leave
  // the old value in force after a login or init wrote the new one.
  it("rewrites the first assignment of a duplicated key and drops the later ones", () => {
    const out = upsertEnvVars("A=1\nB=x\nA=old\nexport A=older\n", { A: "new" });
    expect(out).toBe("A=new\nB=x\n");
    expect(dotenv.parse(out).A).toBe("new");
  });

  it("leaves the duplicates of a key it does not write alone", () => {
    const out = upsertEnvVars("B=1\nB=2\n", { A: "new" });
    expect(out).toBe("B=1\nB=2\nA=new\n");
  });

  it("replaces an exported key in place and keeps its export prefix", () => {
    const out = upsertEnvVars("export A=1\nB=2\n", { A: "new" });
    expect(out).toBe("export A=new\nB=2\n");
    expect(dotenv.parse(out).A).toBe("new");
  });
});

describe("writeDotEnv — chmod unsupported", () => {
  it("still writes the variables when chmod rejects", async () => {
    const envPath = path.join(tempDir, ".env");
    chmod.mockRejectedValue(
      Object.assign(new Error("operation not permitted"), { code: "EPERM" })
    );

    await expect(
      writeDotEnv(envPath, { SN_USER: "admin", SN_PASSWORD: "p w#" })
    ).resolves.toBeUndefined();

    expect(chmod).toHaveBeenCalledWith(envPath, 0o600);
    const parsed = dotenv.parse(fs.readFileSync(envPath, "utf8"));
    expect(parsed).toEqual({ SN_USER: "admin", SN_PASSWORD: "p w#" });
  });

  it("tightens a loosely-permissioned existing file to owner-only", async () => {
    if (process.platform === "win32") return;
    const envPath = path.join(tempDir, ".env");
    fs.writeFileSync(envPath, "KEEP=me\n", { mode: 0o644 });
    fs.chmodSync(envPath, 0o644);

    await writeDotEnv(envPath, { NEW: "v" });

    expect(fs.statSync(envPath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(envPath, "utf8")).toBe("KEEP=me\nNEW=v\n");
  });
});

describe("ensureGitignored — existing file shapes", () => {
  it("puts the entry on its own line when the file lacks a trailing newline", async () => {
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "node_modules");

    await expect(ensureGitignored(tempDir, ".env")).resolves.toBe(true);

    expect(fs.readFileSync(path.join(tempDir, ".gitignore"), "utf8")).toBe(
      "node_modules\n.env\n"
    );
  });

  it("does not add a blank separator when the file already ends with a newline", async () => {
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "node_modules\n");

    await ensureGitignored(tempDir, ".env");

    expect(fs.readFileSync(path.join(tempDir, ".gitignore"), "utf8")).toBe(
      "node_modules\n.env\n"
    );
  });

  it("treats an indented entry as already present", async () => {
    fs.writeFileSync(path.join(tempDir, ".gitignore"), "  .env  \n");

    await expect(ensureGitignored(tempDir, ".env")).resolves.toBe(false);
    expect(fs.readFileSync(path.join(tempDir, ".gitignore"), "utf8")).toBe(
      "  .env  \n"
    );
  });

  it("accepts a directory given with a trailing slash", async () => {
    await expect(ensureGitignored(`${tempDir}/`, ".env")).resolves.toBe(true);
    expect(fs.readFileSync(path.join(tempDir, ".gitignore"), "utf8")).toBe(
      ".env\n"
    );
  });
});
