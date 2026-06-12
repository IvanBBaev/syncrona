import fs from "fs";
import os from "os";
import path from "path";
import { getPathsInPath } from "../FileUtils";
import * as ConfigManager from "../config";

jest.mock("../config", () => {
  const actual = jest.requireActual("../config");
  return {
    ...actual,
    getSourcePath: jest.fn(),
    getBuildPath: jest.fn(),
  };
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
