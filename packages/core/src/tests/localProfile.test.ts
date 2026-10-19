// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

export {};

// DX7: .syncrona-local can set a default instance profile; an explicit
// --instance-profile flag still wins.

jest.unstable_mockModule("../snClient.js", () => ({
  setActiveInstanceProfile: jest.fn(),
}));
jest.unstable_mockModule("../appUtils.js", () => ({}));

import { resolveInstanceProfile } from "../commandHelpers.js";

describe("resolveInstanceProfile (DX7 .syncrona-local)", () => {
  const originalCwd = process.cwd();
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-local-"));
    process.chdir(dir);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it("returns undefined when there is no .syncrona-local and no flag", () => {
    expect(resolveInstanceProfile({})).toBeUndefined();
  });

  it("reads instanceProfile from .syncrona-local when no flag is given", () => {
    fs.writeFileSync(path.join(dir, ".syncrona-local"), JSON.stringify({ instanceProfile: "dev" }));
    expect(resolveInstanceProfile({})).toBe("dev");
  });

  it("lets an explicit --instance-profile flag win over .syncrona-local", () => {
    fs.writeFileSync(path.join(dir, ".syncrona-local"), JSON.stringify({ instanceProfile: "dev" }));
    expect(resolveInstanceProfile({ instanceProfile: "prod" })).toBe("prod");
  });

  it("reads a .syncrona-local saved with a UTF-8 byte order mark", () => {
    // Notepad and PowerShell redirection write one; ignoring the file would
    // silently send the command to the base instance instead of this profile.
    fs.writeFileSync(path.join(dir, ".syncrona-local"), `\uFEFF${JSON.stringify({ instanceProfile: "dev" })}`);
    expect(resolveInstanceProfile({})).toBe("dev");
  });

  it("ignores a malformed .syncrona-local", () => {
    fs.writeFileSync(path.join(dir, ".syncrona-local"), "{ not json");
    expect(resolveInstanceProfile({})).toBeUndefined();
  });
});
