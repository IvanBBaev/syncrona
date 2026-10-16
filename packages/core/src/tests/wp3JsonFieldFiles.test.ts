// SPDX-License-Identifier: GPL-3.0-or-later
//
// WP3: JSON columns as `.json` field files — the presets that opt tables in, the
// lossless pretty/minify pair, and the credential guard on download.
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import { validateConfigShape } from "../config.js";
import { writeSNFileCurry } from "../FileUtils.js";
import {
  findSecretJsonPaths,
  formatJsonFieldForDisk,
  jsonFieldForInstance,
} from "../jsonFieldFiles.js";
import { logger } from "../Logger.js";
import {
  TABLE_PRESETS,
  TABLE_PRESET_NAMES,
  getJsonFileTables,
  isTablePresetName,
} from "../tablePresets.js";

const COMPOSITION = { root: { component: "now-heading", props: { label: "Hi" } }, items: [1, 2] };

describe("table presets", () => {
  it("names the three presets and recognises only them", () => {
    expect(TABLE_PRESET_NAMES).toEqual(["uib", "workspace", "ai"]);
    expect(isTablePresetName("uib")).toBe(true);
    expect(isTablePresetName("toString")).toBe(false);
    expect(isTablePresetName(1)).toBe(false);
  });

  it("never lists a per-user or analytics table", () => {
    for (const preset of Object.values(TABLE_PRESETS)) {
      for (const table of Object.keys(preset)) {
        expect(table).not.toMatch(/^sys_uxa_|^sys_ux_user_override$|^sys_ux_diagnostic_rule_dismiss$/);
      }
    }
  });

  it("never lists the generated UI Builder snapshot table", () => {
    for (const preset of Object.values(TABLE_PRESETS)) {
      expect(Object.keys(preset)).not.toContain("sys_uxf_snapshot");
    }
  });

  it("maps the enabled presets' tables to their JSON string columns", () => {
    const tables = getJsonFileTables({ tablePresets: ["uib", "ai"] });
    expect(tables.get("sys_ux_macroponent")).toEqual(
      expect.arrayContaining(["composition", "props", "root_component_config"])
    );
    expect(tables.get("sn_aia_tool")).toEqual([]);
    expect(tables.has("sys_ux_app")).toBe(false);
  });

  it("is empty by default and ignores names it does not know", () => {
    expect(getJsonFileTables(undefined).size).toBe(0);
    expect(getJsonFileTables({ tablePresets: [] }).size).toBe(0);
    expect(getJsonFileTables({ tablePresets: ["nope"] }).size).toBe(0);
  });

  it("is refused by config validation when it names an unknown preset", () => {
    expect(() =>
      validateConfigShape({ tablePresets: ["uib", "flows"] }, "/p/sync.config.js")
    ).toThrow(/"tablePresets" must list preset names .*invalid: .*flows/);
    expect(() =>
      validateConfigShape({ tablePresets: ["uib", "workspace"] }, "/p/sync.config.js")
    ).not.toThrow();
  });
});

describe("formatJsonFieldForDisk", () => {
  it("pretty-prints a canonical minified value", () => {
    const raw = JSON.stringify(COMPOSITION);
    expect(formatJsonFieldForDisk(raw)).toBe(JSON.stringify(COMPOSITION, null, 2));
  });

  it.each([
    ["an indented value", JSON.stringify(COMPOSITION, null, 4)],
    ["a value with spacing", "{ }"],
    ["escaped unicode", '{"a":"\\u00e9"}'],
    ["a number past double precision", '{"n":12345678901234567890}'],
    ["text that is not JSON", "not json"],
    ["an empty value", ""],
  ])("writes %s byte for byte", (_label, raw) => {
    expect(formatJsonFieldForDisk(raw)).toBe(raw);
  });
});

describe("jsonFieldForInstance", () => {
  it("minifies exactly what download wrote, with or without a trailing newline", () => {
    const pretty = JSON.stringify(COMPOSITION, null, 2);
    expect(jsonFieldForInstance(pretty, "f.json")).toBe(JSON.stringify(COMPOSITION));
    expect(jsonFieldForInstance(`${pretty}\n`, "f.json")).toBe(JSON.stringify(COMPOSITION));
  });

  it("round-trips a minified value with no change", () => {
    const raw = JSON.stringify(COMPOSITION);
    expect(jsonFieldForInstance(formatJsonFieldForDisk(raw), "f.json")).toBe(raw);
  });

  it("sends any other valid JSON as it is", () => {
    const fourSpace = JSON.stringify(COMPOSITION, null, 4);
    expect(jsonFieldForInstance(fourSpace, "f.json")).toBe(fourSpace);
    expect(jsonFieldForInstance('{"a":1}', "f.json")).toBe('{"a":1}');
  });

  it("sends an empty file as an empty column", () => {
    expect(jsonFieldForInstance("", "f.json")).toBe("");
    expect(jsonFieldForInstance("\n", "f.json")).toBe("\n");
  });

  it("refuses a file that is not JSON, naming the file", () => {
    expect(() => jsonFieldForInstance('{\n  "a": 1,\n}', "src/t/r/props.json")).toThrow(
      /src\/t\/r\/props\.json is not valid JSON/
    );
  });

  it("names the line and column of a parse error once", () => {
    let message = "";
    try {
      jsonFieldForInstance('{\n  "a": 1,\n}', "props.json");
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toMatch(/line 3 column 1/);
    expect(message.match(/\bline \d+/g)).toHaveLength(1);
  });
});

describe("findSecretJsonPaths", () => {
  it("finds credential keys at any depth, in any case style", () => {
    const raw = JSON.stringify({
      endpoint: "https://x",
      auth: { apiKey: "k1", nested: [{ client_secret: "s" }] },
      Password: "p",
      "access-token": "t",
    });
    expect(findSecretJsonPaths(raw).sort()).toEqual(
      ["Password", "access-token", "auth.apiKey", "auth.nested[0].client_secret"].sort()
    );
  });

  it("ignores empty values, non-strings and look-alike keys", () => {
    const raw = JSON.stringify({
      password: "",
      api_key: null,
      secret: { ref: "cred-1" },
      secretary: "Ann",
      token_count: "3",
    });
    expect(findSecretJsonPaths(raw)).toEqual([]);
  });

  it("finds an Authorization header's value", () => {
    const raw = JSON.stringify({ headers: { Authorization: "Bearer live", Accept: "x" } });
    expect(findSecretJsonPaths(raw)).toEqual(["headers.Authorization"]);
  });

  it("finds a credential inside a JSON document held as a string", () => {
    const raw = JSON.stringify({
      props: JSON.stringify({ label: "Hi", auth: { api_key: "live-key" } }),
      items: [JSON.stringify([{ password: "p" }])],
      note: "{ not json",
    });
    expect(findSecretJsonPaths(raw).sort()).toEqual(
      ["items[0][0].password", "props.auth.api_key"].sort()
    );
  });

  it("finds nothing in a value that is not JSON", () => {
    expect(findSecretJsonPaths("password=hunter2")).toEqual([]);
  });
});

describe("writeSNFileCurry with a JSON field", () => {
  const tempRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-json-field-"));

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("writes a minified column pretty-printed", async () => {
    const root = tempRoot();
    await writeSNFileCurry(false)(
      { name: "composition", type: "json", content: JSON.stringify(COMPOSITION) } as never,
      root
    );
    expect(fs.readFileSync(path.join(root, "composition.json"), "utf8")).toBe(
      JSON.stringify(COMPOSITION, null, 2)
    );
  });

  it("leaves the sidecar alone", async () => {
    const root = tempRoot();
    const raw = JSON.stringify({ active: "true" });
    await writeSNFileCurry(false)({ name: ".meta", type: "json", content: raw } as never, root);
    expect(fs.readFileSync(path.join(root, ".meta.json"), "utf8")).toBe(raw);
  });

  it("withholds a column that holds a credential, and says where", async () => {
    const root = tempRoot();
    const warn = jest.spyOn(logger, "warn").mockImplementation(() => undefined);
    await writeSNFileCurry(false)(
      {
        name: "tool_attributes",
        type: "json",
        content: JSON.stringify({ headers: { Authorization: "x", api_key: "live-key" } }),
      } as never,
      root
    );
    expect(fs.existsSync(path.join(root, "tool_attributes.json"))).toBe(false);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("headers.api_key"));
  });
});
