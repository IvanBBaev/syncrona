// SPDX-License-Identifier: GPL-3.0-or-later
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  defaultPackagePath,
  FluentNativeError,
  nativePack,
  NativeProject,
  packageInventory,
  packEntries,
  readNativeProject,
  snakeCase,
} from "../src/pack";
import { readZip } from "./helpers/zipReader";

const FIXTURE = path.join(__dirname, "fixtures", "probe-app");
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "syncrona-pack-"));
  dirs.push(dir);
  return dir;
}

/** The probe app as the SDK left it: config, package.json and the build in `dist/app`. */
function probeProject(): string {
  const dir = tempDir();
  cpSync(path.join(FIXTURE, "now.config.json"), path.join(dir, "now.config.json"));
  cpSync(path.join(FIXTURE, "package.json"), path.join(dir, "package.json"));
  cpSync(path.join(FIXTURE, "build-output"), path.join(dir, "dist", "app"), { recursive: true });
  return dir;
}

function writeJson(file: string, value: unknown): void {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, typeof value === "string" ? value : JSON.stringify(value));
}

function project(overrides: Partial<NativeProject> = {}): NativeProject {
  return {
    projectDir: "/p",
    scope: "x_acme_app",
    scopeId: "0123456789abcdef0123456789abcdef",
    appOutputDir: "dist/app",
    packOutputDir: "target",
    hostedPlugins: false,
    packageName: "acme-app",
    packageVersion: "1.2.3",
    ...overrides,
  };
}

afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

describe("nativePack against the SDK's own output", () => {
  it("reproduces the SDK archive's entries and inventory", () => {
    const dir = probeProject();
    const zipPath = nativePack(dir);
    expect(zipPath).toBe(path.join(dir, "target", "syncrona_build_probe_0_0_1.zip"));

    const entries = readZip(readFileSync(zipPath));
    // The entry list of the SDK's target/syncrona_build_probe_0_0_1.zip, leading slash included.
    expect(entries.map((e) => e.name)).toEqual([
      "/package_inventory.csv",
      "/scope/sys_app_db22ea00d7ff49d9b5d64061202ea510.xml",
      "/update/sys_module_b3c309d4ce9f4b06bc12ede9702e19eb.xml",
      "/update/sys_module_c07689764091405d8436e61a227839fa.xml",
      "/update/sys_module_e828e47a65954a458d671bdc27d54cb9.xml",
      "/update/sys_script_7639380602944de9a8d47d50c22d156f.xml",
      "/update/sys_script_client_1671293202214a138b7784b6f2fb1777.xml",
    ]);
    expect(entries[0].data.toString("utf8")).toBe(readFileSync(path.join(FIXTURE, "expected_inventory.csv"), "utf8"));
    for (const entry of entries.slice(1)) {
      expect(entry.data.equals(readFileSync(path.join(FIXTURE, "build-output", entry.name)))).toBe(true);
    }
  });

  it("is byte-identical on a repack, replaces a stale inventory and leaves the build untouched", () => {
    const dir = probeProject();
    const first = readFileSync(nativePack(dir));
    writeFileSync(path.join(dir, "dist", "app", "package_inventory.csv"), "#stale\n");
    const second = readFileSync(nativePack(dir));
    expect(second.equals(first)).toBe(true);
    expect(readFileSync(path.join(dir, "dist", "app", "package_inventory.csv"), "utf8")).toBe("#stale\n");
  });

  it("writes to an explicit path relative to the project", () => {
    const dir = probeProject();
    expect(nativePack(dir, "out/deep/app.zip")).toBe(path.join(dir, "out", "deep", "app.zip"));
    expect(readZip(readFileSync(path.join(dir, "out", "deep", "app.zip")))).toHaveLength(7);
  });
});

describe("snakeCase", () => {
  it.each([
    ["syncrona-build-probe_0.0.1", "syncrona_build_probe_0_0_1"],
    ["myApp_1.0.0-beta.2", "my_app_1_0_0_beta_2"],
    ["@acme/my-app_2.0.0", "acme_my_app_2_0_0"],
    ["x_snc_app2go_1.0.0", "x_snc_app_2_go_1_0_0"],
    ["ABCApp_1.0.0", "abc_app_1_0_0"],
    ["fooBAR_1", "foo_bar_1"],
    ["---", ""],
  ])("%s → %s", (input, expected) => {
    expect(snakeCase(input)).toBe(expected);
  });
});

describe("readNativeProject", () => {
  it("reads now.config.json with the SDK defaults", () => {
    const dir = probeProject();
    expect(readNativeProject(dir)).toEqual({
      projectDir: dir,
      scope: "x_snc_bprobe",
      scopeId: "db22ea00d7ff49d9b5d64061202ea510",
      appOutputDir: path.join("dist", "app"),
      packOutputDir: "target",
      hostedPlugins: false,
      installAs: undefined,
      packageName: "syncrona-build-probe",
      packageVersion: "0.0.1",
    });
    expect(defaultPackagePath(readNativeProject(dir))).toBe(path.join(dir, "target", "syncrona_build_probe_0_0_1.zip"));
  });

  it("falls back to package.json#now and honours the deprecated compileOutputDir", () => {
    const dir = tempDir();
    writeJson(path.join(dir, "package.json"), {
      name: "a",
      version: "1",
      now: { scope: "global", scopeId: "abc", compileOutputDir: "out", packOutputDir: "pkg", installAs: "store" },
    });
    expect(readNativeProject(dir)).toMatchObject({
      scope: "global",
      appOutputDir: "out",
      packOutputDir: "pkg",
      installAs: "store",
    });
  });

  it.each([
    [["plugin"], true],
    [[], false],
    [{ a: {} }, true],
    [{}, false],
    [true, true],
    [undefined, false],
  ])("treats hostedPlugins %j as %s", (hostedPlugins, expected) => {
    const dir = tempDir();
    writeJson(path.join(dir, "package.json"), { name: "a", version: "1" });
    writeJson(path.join(dir, "now.config.json"), { scope: "x_a", hostedPlugins });
    expect(readNativeProject(dir).hostedPlugins).toBe(expected);
  });

  it("leaves a missing scope empty for the inventory to refuse", () => {
    const dir = tempDir();
    writeJson(path.join(dir, "package.json"), { name: "a", version: "1" });
    writeJson(path.join(dir, "now.config.json"), {});
    expect(readNativeProject(dir)).toMatchObject({ scope: "", scopeId: "" });
  });

  it("refuses a missing config, unparsable JSON and an unnamed package", () => {
    const dir = tempDir();
    expect(() => readNativeProject(dir)).toThrow(expect.objectContaining({ code: "FLUENT_CONFIG_MISSING" }));
    writeJson(path.join(dir, "package.json"), { name: "a", version: "1", now: "scalar" });
    expect(() => readNativeProject(dir)).toThrow(expect.objectContaining({ code: "FLUENT_CONFIG_MISSING" }));
    writeJson(path.join(dir, "now.config.json"), "{not json");
    expect(() => readNativeProject(dir)).toThrow(/Failed to parse .*now\.config\.json/);
    writeJson(path.join(dir, "now.config.json"), "[1]");
    expect(() => readNativeProject(dir)).toThrow(expect.objectContaining({ code: "FLUENT_CONFIG_INVALID" }));
    writeJson(path.join(dir, "now.config.json"), "null");
    expect(() => readNativeProject(dir)).toThrow(expect.objectContaining({ code: "FLUENT_CONFIG_INVALID" }));
    writeJson(path.join(dir, "now.config.json"), { scope: "x_a" });
    writeJson(path.join(dir, "package.json"), { name: "a" });
    expect(() => readNativeProject(dir)).toThrow(expect.objectContaining({ code: "FLUENT_PACKAGE_INVALID" }));
    rmSync(path.join(dir, "package.json"));
    expect(() => readNativeProject(dir)).toThrow(FluentNativeError);
  });
});

describe("packageInventory", () => {
  const files = new Map([
    ["update/b.xml", Buffer.from("b")],
    ["scope/a.xml", Buffer.from("a")],
    ["nested/package_inventory.csv", Buffer.from("x")],
  ]);

  it("uses the scopeId as the build of a global app and skips nested inventories", () => {
    expect(packageInventory(project({ scope: "global", scopeId: "g1" }), files)).toBe(
      [
        "#build=g1",
        "#appVersion=1.2.3",
        "#type=global",
        "#version=1.0.0",
        "scope/a.xml;ca978112ca1bbdcafac231b39a23dc4da786eff8147c4e72b9807785afee48bb",
        "update/b.xml;3e23e8160039594a33894f6564e1b1348bbd7a0088d42c4acb73eeaed59c009d",
        "",
      ].join("\n"),
    );
  });

  it("refuses a config without a build id", () => {
    expect(() => packageInventory(project({ scope: "" }), files)).toThrow(
      "Cannot generate package_inventory.csv: missing scope or scopeId in config",
    );
    expect(() => packageInventory(project({ scope: "global", scopeId: "" }), files)).toThrow(FluentNativeError);
  });
});

describe("packEntries", () => {
  it("refuses a missing or empty build directory", () => {
    const dir = tempDir();
    expect(() => packEntries(project({ projectDir: dir }))).toThrow(
      expect.objectContaining({ code: "FLUENT_PACK_EMPTY" }),
    );
    mkdirSync(path.join(dir, "dist", "app"), { recursive: true });
    expect(() => packEntries(project({ projectDir: dir }))).toThrow(/No files found in .* to create zip/);
  });
});
