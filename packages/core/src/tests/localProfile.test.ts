import fs from "fs";
import os from "os";
import path from "path";

export {};

// DX7: .syncrona-local can set a default instance profile; an explicit
// --instance-profile flag still wins.

jest.mock("../snClient", () => ({
  setActiveInstanceProfile: jest.fn(),
  getScopedEndpointPrefix: jest.fn(),
}));
jest.mock("../appUtils", () => ({}));

import { resolveInstanceProfile } from "../commandHelpers";

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

  it("ignores a malformed .syncrona-local", () => {
    fs.writeFileSync(path.join(dir, ".syncrona-local"), "{ not json");
    expect(resolveInstanceProfile({})).toBeUndefined();
  });
});
