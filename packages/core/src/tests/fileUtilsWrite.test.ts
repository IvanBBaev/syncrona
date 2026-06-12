import fs from "fs";
import os from "os";
import path from "path";
import { withRetry, writeFileForce, writeSNFileCurry } from "../FileUtils";

describe("writeSNFileCurry", () => {
  it("does not overwrite existing file when checkExists=true", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-fileutils-"));
    const filePath = path.join(root, "script.js");
    fs.writeFileSync(filePath, "original");

    const writeIfMissing = writeSNFileCurry(true);
    await writeIfMissing(
      { name: "script", type: "js", content: "new-content" } as any,
      root
    );

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toBe("original");
  });

  it("overwrites existing file when checkExists=false", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-fileutils-"));
    const filePath = path.join(root, "script.js");
    fs.writeFileSync(filePath, "original");

    const writeAlways = writeSNFileCurry(false);
    await writeAlways(
      { name: "script", type: "js", content: "new-content" } as any,
      root
    );

    const content = fs.readFileSync(filePath, "utf8");
    expect(content).toBe("new-content");
  });
});

describe("withRetry", () => {
  it("retries transient failure and succeeds", async () => {
    let attempts = 0;
    const result = await withRetry(async () => {
      attempts += 1;
      if (attempts < 3) {
        throw new Error("transient");
      }
      return "ok";
    }, 3, 0);

    expect(result).toBe("ok");
    expect(attempts).toBe(3);
  });

  it("throws after retry budget is exhausted", async () => {
    await expect(
      withRetry(async () => {
        throw new Error("fail");
      }, 1, 0)
    ).rejects.toThrow("fail");
  });
});

describe("writeFileForce", () => {
  it("retries write operation on transient failure", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-fileutils-"));
    const filePath = path.join(root, "retry.txt");
    const realWriteFile = fs.promises.writeFile;
    let attempts = 0;

    const spy = jest.spyOn(fs.promises, "writeFile").mockImplementation(async (...args: any[]) => {
      attempts += 1;
      if (attempts < 2) {
        throw new Error("busy");
      }
      return realWriteFile.apply(fs.promises, args as [any, any]);
    });

    await writeFileForce(filePath, "hello");

    expect(attempts).toBe(2);
    expect(fs.readFileSync(filePath, "utf8")).toBe("hello");
    spy.mockRestore();
  });
});
