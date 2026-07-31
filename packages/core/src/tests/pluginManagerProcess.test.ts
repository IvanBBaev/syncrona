// SPDX-License-Identifier: GPL-3.0-or-later
import { jest } from "@jest/globals";
import fs from "fs";
import os from "os";
import path from "path";
import vm from "node:vm";
import type { Sync } from "@syncrona/types";

// Drives PluginManager.processFile / runPlugins / getFinalFileContents against
// real on-disk plugin fixtures (built into a temp dir at runtime so the test is
// hermetic and portable) — this exercises the dynamic plugin import for real.
const FIXTURE_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-pm-"));
const SOURCE_FILE = path.join(FIXTURE_ROOT, "src", "script.js");

const writePlugin = (name: string, body: string) => {
  const dir = path.join(FIXTURE_ROOT, "node_modules", name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "index.js"), body);
};

beforeAll(() => {
  fs.mkdirSync(path.join(FIXTURE_ROOT, "src"), { recursive: true });
  fs.writeFileSync(SOURCE_FILE, 'gs.info("hello");\n');
  writePlugin(
    "okplugin",
    "module.exports = { run: async (_c, output) => ({ success: true, output: output + '\\n// transformed' }) };"
  );
  writePlugin(
    "failplugin",
    "module.exports = { run: async () => ({ success: false, output: '' }) };"
  );
  // A package that resolves and imports cleanly but is not a build plugin at
  // all — the shape mistake `npm install`ing the wrong package produces.
  writePlugin("norunplugin", "module.exports = { transform: () => 'nope' };");
});

afterAll(() => {
  fs.rmSync(FIXTURE_ROOT, { recursive: true, force: true });
});

const getConfig = jest.fn();
const getRootDir = jest.fn();

jest.unstable_mockModule("../config.js", () => ({
  getConfig: (...a: unknown[]) => getConfig(...a),
  getRootDir: (...a: unknown[]) => getRootDir(...a),
}));

const loggerWarn = jest.fn();

jest.unstable_mockModule("../Logger.js", () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: (...a: unknown[]) => loggerWarn(...a),
    error: jest.fn(),
  },
}));

const context = (filePath: string): Sync.FileContext =>
  ({
    filePath,
    tableName: "sys_script",
    sys_id: "abc",
    targetField: "script",
    name: "script",
    ext: ".js",
    scope: "x_test",
  }) as unknown as Sync.FileContext;

beforeEach(() => {
  jest.clearAllMocks();
  getRootDir.mockReturnValue(FIXTURE_ROOT);
});

describe("PluginManager.getFinalFileContents", () => {
  // `processFile: false` is how push/deploy read the file that is already built:
  // the bytes on disk must go up verbatim. Running the chain a second time would
  // double-transform (minify a minified bundle, re-prepend a banner), so the flag
  // is asserted against a rule that DOES match and DOES change the content —
  // asserting only "the raw text is still in there" would pass either way.
  it("returns raw file contents when processFile is disabled", async () => {
    getConfig.mockReturnValue({
      rules: [{ match: /\.js$/, plugins: [{ name: "okplugin", options: {} }] }],
    });
    const PluginManager = (await import("../PluginManager.js")).default;
    await PluginManager.loadPluginConfig();
    const out = await PluginManager.getFinalFileContents(context(SOURCE_FILE), false);
    expect(out).toBe('gs.info("hello");\n');
    expect(out).not.toContain("// transformed");
  });

  it("copies a file as-is when no rule matches its path", async () => {
    getConfig.mockReturnValue({ rules: [{ match: /\.ts$/, plugins: [] }] });
    const PluginManager = (await import("../PluginManager.js")).default;
    const out = await PluginManager.getFinalFileContents(context(SOURCE_FILE));
    expect(out).toContain('gs.info("hello")');
    expect(out).not.toContain("transformed");
  });

  it("runs the matched plugin chain and returns transformed output", async () => {
    getConfig.mockReturnValue({
      rules: [{ match: /\.js$/, plugins: [{ name: "okplugin", options: {} }] }],
    });
    const PluginManager = (await import("../PluginManager.js")).default;
    const out = await PluginManager.getFinalFileContents(context(SOURCE_FILE));
    expect(out).toContain("// transformed");
  });

  it("throws a build error when a plugin reports failure", async () => {
    getConfig.mockReturnValue({
      rules: [{ match: /\.js$/, plugins: [{ name: "failplugin", options: {} }] }],
    });
    const PluginManager = (await import("../PluginManager.js")).default;
    await expect(
      PluginManager.getFinalFileContents(context(SOURCE_FILE))
    ).rejects.toThrow("Failed to build sys_script=>abc");
  });

  // #2: config.ts loads sync.config.js through vm.runInNewContext, so a regex
  // literal in the config file is created with the vm realm's RegExp intrinsic.
  // `instanceof RegExp` is false cross-realm, which used to silently skip the
  // rule and disable every build transform. util.types.isRegExp is realm-safe,
  // so a cross-realm regex still matches and the plugin chain still runs.
  it("matches a cross-realm RegExp produced by vm-loaded config (#2)", async () => {
    const crossRealmRegex = vm.runInNewContext("/\\.js$/") as RegExp;
    // Sanity: this regex is a real RegExp but fails the old instanceof gate.
    expect(crossRealmRegex instanceof RegExp).toBe(false);

    getConfig.mockReturnValue({
      rules: [{ match: crossRealmRegex, plugins: [{ name: "okplugin", options: {} }] }],
    });
    const PluginManager = (await import("../PluginManager.js")).default;
    const out = await PluginManager.getFinalFileContents(context(SOURCE_FILE));
    expect(out).toContain("// transformed");
  });
});

// Rule matching answers a stateless question — "does this path belong to this
// rule?" — but `match` is user-authored, and RegExp.test() is stateful for /g
// and /y: it resumes from the regex's own lastIndex. A stray flag in
// sync.config.js therefore used to make the same rule match every other file,
// silently shipping untransformed source for the rest.
describe("PluginManager.determinePlugins with stateful user regexes", () => {
  const plugins = [{ name: "okplugin", options: {} }];

  // determinePlugins reads the rules loadPluginConfig() cached on the singleton,
  // not getConfig() directly — mock the config, then load it, or the assertion
  // silently runs against whatever rules a previous test left behind.
  const withRules = async (rules: unknown[]) => {
    getConfig.mockReturnValue({ rules });
    const PluginManager = (await import("../PluginManager.js")).default;
    await PluginManager.loadPluginConfig();
    return PluginManager;
  };

  it("matches a /g rule on every file instead of every other one", async () => {
    const match = /\.js$/g;
    const PluginManager = await withRules([{ match, plugins }]);

    for (let i = 0; i < 4; i++) {
      expect(PluginManager.determinePlugins(context(SOURCE_FILE))).toEqual(plugins);
    }
  });

  it("leaves the user's regex object untouched while matching", async () => {
    const match = /\.js$/g;
    const PluginManager = await withRules([{ match, plugins }]);

    PluginManager.determinePlugins(context(SOURCE_FILE));

    expect(match.lastIndex).toBe(0);
  });

  it("matches a sticky rule against the whole path, not only from position 0", async () => {
    // A sticky regex anchors at lastIndex, so /\.js$/y would never match a path
    // that does not START with ".js" — the rule would be dead for every file.
    const PluginManager = await withRules([{ match: /\.js$/y, plugins }]);

    expect(PluginManager.determinePlugins(context(SOURCE_FILE))).toEqual(plugins);
  });

  it("still transforms the file on a repeated build with a /g rule", async () => {
    const PluginManager = await withRules([{ match: /\.js$/g, plugins }]);

    expect(await PluginManager.getFinalFileContents(context(SOURCE_FILE))).toContain(
      "// transformed"
    );
    expect(await PluginManager.getFinalFileContents(context(SOURCE_FILE))).toContain(
      "// transformed"
    );
  });

  it("keeps a non-matching /g rule non-matching", async () => {
    const PluginManager = await withRules([{ match: /\.ts$/g, plugins }]);

    expect(PluginManager.determinePlugins(context(SOURCE_FILE))).toEqual([]);
  });
});

// sync.config.js is hand-written user code that is never type-checked, so both
// the rule list and the plugin packages it names can arrive in the wrong shape.
// A build must not die with `reg.test is not a function` or
// `plugin.run is not a function` — those name the internals, not the user's
// mistake, and the first one aborts the whole build over one bad rule.
describe("PluginManager malformed configuration", () => {
  const plugins = [{ name: "okplugin", options: {} }];

  it("skips malformed rules with a warning and still honours a later valid rule", async () => {
    getConfig.mockReturnValue({
      rules: [
        null,
        { match: "\\.js$", plugins: [{ name: "failplugin", options: {} }] },
        { match: /\.js$/, plugins },
      ],
    });
    const PluginManager = (await import("../PluginManager.js")).default;
    await PluginManager.loadPluginConfig();

    // The valid rule after the two broken ones still decides the build.
    expect(PluginManager.determinePlugins(context(SOURCE_FILE))).toEqual(plugins);
    // One warning per malformed rule: the missing rule and the string `match`.
    expect(loggerWarn).toHaveBeenCalledTimes(2);
    // The warning has to be actionable — it names the offending property and
    // the type that actually arrived, which is what points at the bad rule.
    const warnings = loggerWarn.mock.calls.map((c) => String(c[0]));
    expect(warnings[0]).toContain("match");
    expect(warnings[0]).toContain("undefined");
    expect(warnings[1]).toContain("match");
    expect(warnings[1]).toContain("string");
  });

  it("reports a plugin package that exports no run() instead of crashing on it", async () => {
    getConfig.mockReturnValue({
      rules: [{ match: /\.js$/, plugins: [{ name: "norunplugin", options: {} }] }],
    });
    const PluginManager = (await import("../PluginManager.js")).default;

    // The message must distinguish "installed but not a build plugin" from the
    // "could not be loaded / is it installed?" hint, or the user reinstalls a
    // package that was there all along.
    await expect(
      PluginManager.getFinalFileContents(context(SOURCE_FILE))
    ).rejects.toThrow(
      'Build plugin "norunplugin" does not export a run(context, content, options) function.'
    );
  });
});
