// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";

// R7: spreading the real ../config.js ESM module throws under this Node, so the
// factory lists only the explicit path helpers the SUT hard-links. graph-complete
// fills in any other config name the FileUtils graph links.
jest.unstable_mockModule("../config.js", () => ({
  getSourcePath: jest.fn(),
  getBuildPath: jest.fn(),
}));

// R1: jest.unstable_mockModule does not hoist, so the SUT and the mocked config
// namespace are imported dynamically in beforeAll, after the mock registers.
let getPathsInPath: typeof import("../FileUtils.js").getPathsInPath;
let ConfigManager: typeof import("../config.js");

beforeAll(async () => {
  ({ getPathsInPath } = await import("../FileUtils.js"));
  ConfigManager = await import("../config.js");
});

describe("getPathsInPath depth guard", () => {
  it("does not traverse deeper than 20 levels", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-depth-"));

    (ConfigManager.getSourcePath as unknown as jest.Mock).mockReturnValue(root);
    (ConfigManager.getBuildPath as unknown as jest.Mock).mockReturnValue(root);

    const shallowFile = path.join(root, "level0.txt");
    fs.writeFileSync(shallowFile, "ok", "utf8");

    let current = root;
    for (let i = 1; i <= 25; i += 1) {
      current = path.join(current, `d${i}`);
      fs.mkdirSync(current, { recursive: true });
    }

    const deepFile = path.join(current, "too-deep.txt");
    fs.writeFileSync(deepFile, "skip", "utf8");

    const found = await getPathsInPath(root);

    expect(found).toContain(path.resolve(shallowFile));
    expect(found).not.toContain(path.resolve(deepFile));
  });
});
