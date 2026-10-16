// SPDX-License-Identifier: GPL-3.0-or-later
//
// Native build: built from the batch1 fixture, the output must match the SDK
// 4.13 build of the same probe byte for byte — the compiled records
// (`fixtures/batch1/expected`) plus the build's own `sys_app` and `sys_module`
// rows (`fixtures/batch1/build`), the SBOM differing only in its tool entry.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  FROZEN_KEYS_ERROR,
  moduleResolutionPath,
  nativeBuild,
  sbomContent,
} from "../src/build";

const FIXTURE = path.join(__dirname, "fixtures/batch1");
const SDK_TIMESTAMP = "2026-10-15T14:57:10.814Z";
const SDK_SERIAL = "fe0f4ce7-54f3-41a5-b0b2-b2486bf1995d";
const SDK_TOOL = {
  type: "library",
  name: "sdk-build-plugins",
  group: "@servicenow",
  version: "4.13.6",
  author: "ServiceNow",
};
const OWN_VERSION = (
  JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "package.json"), "utf8"),
  ) as { version: string }
).version;
const SYNCRONA_TOOL = {
  type: "library",
  name: "fluent",
  group: "@syncrona",
  version: OWN_VERSION,
  author: "syncrona",
};
const PINNED = {
  now: () => new Date(SDK_TIMESTAMP),
  serialNumber: () => SDK_SERIAL,
};

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "syncrona-build-"));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

/** A copy of the batch1 project with the probe's package.json; its server dir is not a module dir. */
function batch1Project(config: Record<string, unknown> = {}): string {
  const dir = path.join(tmp, "app");
  fs.cpSync(path.join(FIXTURE, "project"), dir, { recursive: true });
  fs.copyFileSync(
    path.join(FIXTURE, "build/probe-package.json"),
    path.join(dir, "package.json"),
  );
  const base = JSON.parse(
    fs.readFileSync(path.join(dir, "now.config.json"), "utf8"),
  ) as Record<string, unknown>;
  writeJson(path.join(dir, "now.config.json"), {
    ...base,
    serverModulesDir: "src/modules",
    ...config,
  });
  return dir;
}

/** A project without Fluent sources. */
function bareProject(
  config: Record<string, unknown> = {},
  pkg: Record<string, unknown> = {},
): string {
  const dir = path.join(tmp, "bare");
  writeJson(path.join(dir, "package.json"), {
    name: "bare-app",
    version: "1.2.3",
    ...pkg,
  });
  writeJson(path.join(dir, "now.config.json"), {
    scope: "x_acme_bare",
    scopeId: "0123456789abcdef0123456789abcdef",
    ...config,
  });
  return dir;
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function writeFile(file: string, text = ""): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
}

function filesIn(dir: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const entry of fs.readdirSync(dir, {
    recursive: true,
    withFileTypes: true,
  })) {
    if (!entry.isFile()) continue;
    const full = path.join(entry.parentPath, entry.name);
    out.set(
      path.relative(dir, full).split(path.sep).join("/"),
      fs.readFileSync(full, "utf8"),
    );
  }
  return out;
}

function sysApp(dir: string): string {
  const scope = path.join(dir, "dist/app/scope");
  const [file] = fs.readdirSync(scope);
  return fs.readFileSync(path.join(scope, file), "utf8");
}

function field(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?: [^>]*)?(?:/>|>([^<]*)</${name}>)`).exec(
    xml,
  );
  return match ? (match[1] ?? "") : undefined;
}

function moduleContent(dir: string, file: string): string {
  const xml = fs.readFileSync(path.join(dir, "dist/app/update", file), "utf8");
  return /<!\[CDATA\[([\s\S]*)\]\]><\/content>/.exec(xml)![1];
}

describe("nativeBuild golden output (SDK 4.13 probe)", () => {
  it("writes the SDK's build output byte for byte", () => {
    const dir = batch1Project();
    const keysPath = path.join(dir, "src/fluent/generated/keys.ts");
    const keysBefore = fs.readFileSync(keysPath, "utf8");

    expect(nativeBuild(dir, PINNED)).toEqual({
      success: true,
      errors: [],
      warnings: [
        "src/fluent/batch1.now.ts:39:1 - ACLs must have at least one of the following: roles, security_attribute, condition, or script",
      ],
    });

    const expected = new Map([
      ...filesIn(path.join(FIXTURE, "expected")),
      ...filesIn(path.join(FIXTURE, "build")),
    ]);
    expected.delete("probe-package.json");
    const bom = "update/sys_module_c17be2dde3604b6cb7597d7e626ef325.xml";
    const sdkTool = JSON.stringify([SDK_TOOL], null, 2).replace(
      /\n/g,
      "\n      ",
    );
    const ownTool = JSON.stringify([SYNCRONA_TOOL], null, 2).replace(
      /\n/g,
      "\n      ",
    );
    expect(expected.get(bom)).toContain(sdkTool);
    expected.set(bom, expected.get(bom)!.replace(sdkTool, ownTool));

    const actual = filesIn(path.join(dir, "dist/app"));
    expect([...actual.keys()].sort()).toEqual([...expected.keys()].sort());
    for (const [file, xml] of expected)
      expect(`${file}\n${actual.get(file)}`).toBe(`${file}\n${xml}`);
    expect(fs.readFileSync(keysPath, "utf8")).toBe(keysBefore);
  });

  it("passes a frozen-keys build whose keys.ts is current", () => {
    expect(
      nativeBuild(batch1Project(), { ...PINNED, frozenKeys: true }).success,
    ).toBe(true);
  });
});

describe("nativeBuild", () => {
  it("cleans the output directories first, unless skipClean", () => {
    const dir = bareProject({ staticContent: { buildDir: "out/static" } });
    const stale = [
      "dist/app/update/stale.xml",
      "target/old.zip",
      "out/static/old.js",
      ".now/.output/old.xml",
    ].map((file) => path.join(dir, file));
    for (const file of stale) writeFile(file);
    nativeBuild(dir, { skipClean: true });
    for (const file of stale) expect(fs.existsSync(file)).toBe(true);
    nativeBuild(dir);
    for (const file of stale) expect(fs.existsSync(file)).toBe(false);
  });

  it("cleans the default static directory", () => {
    const dir = bareProject();
    writeFile(path.join(dir, "dist/static/old.js"));
    nativeBuild(dir);
    expect(fs.existsSync(path.join(dir, "dist/static"))).toBe(false);
  });

  it("writes keys.ts with new sys_module keys, then keeps it", () => {
    const dir = bareProject();
    let n = 0;
    const generateGuid = () => `${++n}`.padStart(32, "0");
    expect(nativeBuild(dir, { generateGuid }).success).toBe(true);
    const keysPath = path.join(dir, "src/fluent/generated/keys.ts");
    const keys = fs.readFileSync(keysPath, "utf8");
    expect(keys).toContain("package_json");
    expect(keys).toContain("bom_json");
    const update = fs.readdirSync(path.join(dir, "dist/app/update")).sort();
    expect(update).toEqual([
      `sys_module_${"1".padStart(32, "0")}.xml`,
      `sys_module_${"2".padStart(32, "0")}.xml`,
    ]);
    const mtime = fs.statSync(keysPath).mtimeMs;
    expect(nativeBuild(dir, { generateGuid }).success).toBe(true);
    expect(fs.statSync(keysPath).mtimeMs).toBe(mtime);
  });

  it("refuses a frozen-keys build that would change keys.ts, writing nothing", () => {
    const dir = bareProject();
    expect(nativeBuild(dir, { frozenKeys: true })).toEqual({
      success: false,
      errors: [FROZEN_KEYS_ERROR],
      warnings: [],
    });
    expect(fs.existsSync(path.join(dir, "dist"))).toBe(false);
    expect(fs.existsSync(path.join(dir, "src"))).toBe(false);
  });

  it("stamps the SBOM with the clock and a random serial by default", () => {
    const dir = bareProject();
    nativeBuild(dir);
    const update = fs.readdirSync(path.join(dir, "dist/app/update"));
    const boms = update
      .map((file) => moduleContent(dir, file))
      .filter((content) => content.includes("CycloneDX"));
    expect(boms).toHaveLength(1);
    const bom = JSON.parse(boms[0]) as {
      serialNumber: string;
      metadata: { timestamp: string };
    };
    expect(bom.serialNumber).toMatch(/^urn:uuid:[0-9a-f-]{36}$/);
    expect(Number.isNaN(Date.parse(bom.metadata.timestamp))).toBe(false);
  });

  it("builds no scope or module records for a configuration project", () => {
    const dir = bareProject({ type: "configuration" });
    expect(nativeBuild(dir).success).toBe(true);
    expect(fs.existsSync(path.join(dir, "dist/app"))).toBe(false);
    const keys = fs.readFileSync(
      path.join(dir, "src/fluent/generated/keys.ts"),
      "utf8",
    );
    expect(keys).not.toContain("package_json");
  });

  it("reports compiler errors and warnings with their location", () => {
    const dir = bareProject();
    writeFile(
      path.join(dir, "src/fluent/bad.now.ts"),
      [
        "import { Property, Table } from '@servicenow/sdk/core'",
        "Table({ name: 'x_acme_bare_t' })",
      ].join("\n"),
    );
    const result = nativeBuild(dir);
    expect(result.success).toBe(false);
    expect(result.errors[0]).toMatch(
      /^src[/\\]fluent[/\\]bad\.now\.ts:2:1 - Table\(\) is not supported/,
    );
    expect(fs.existsSync(path.join(dir, "dist"))).toBe(false);
  });

  it("returns the compiler's failure when the project cannot be read", () => {
    const dir = bareProject({ scopeId: "" });
    const result = nativeBuild(dir);
    expect(result.success).toBe(false);
    expect(result.errors).toEqual([
      "now.config.json:1:1 - now.config.json needs a string 'scopeId'.",
    ]);
  });

  it("pins dependencies to their installed versions", () => {
    const dir = bareProject({}, { dependencies: { "left-pad": "^1.0.0" } });
    writeJson(path.join(dir, "node_modules/left-pad/package.json"), {
      name: "left-pad",
      version: "1.3.0",
    });
    expect(nativeBuild(dir).success).toBe(true);
    const update = fs.readdirSync(path.join(dir, "dist/app/update"));
    const pkg = update
      .map((file) => moduleContent(dir, file))
      .find(
        (content) =>
          content.includes('"dependencies"') &&
          !content.includes('"bomFormat"'),
      )!;
    expect(JSON.parse(pkg)).toEqual({
      name: "bare-app",
      version: "1.2.3",
      dependencies: { "left-pad": "1.3.0" },
    });
  });

  it("refuses dependencies that are not installed", () => {
    const dir = bareProject({}, { dependencies: { gone: "1", broken: "1" } });
    writeJson(path.join(dir, "node_modules/broken/package.json"), {
      name: "broken",
    });
    expect(nativeBuild(dir).errors).toEqual([
      "The dependency gone is not installed; run npm install before building.",
      "The dependency broken is not installed; run npm install before building.",
    ]);
  });

  describe("refuses what it cannot build yet", () => {
    const refusal = (what: string) =>
      `${what} is not built by syncrona's native engine yet; install @servicenow/sdk to build this project.`;

    it("server modules", () => {
      const dir = bareProject();
      writeFile(path.join(dir, "src/server/a.ts"));
      writeFile(path.join(dir, "src/server/lib/b.js"));
      writeFile(path.join(dir, "src/server/types.d.ts"));
      writeFile(path.join(dir, "src/server/a.test.ts"));
      writeFile(path.join(dir, "src/server/tsconfig.json"));
      expect(nativeBuild(dir).errors).toEqual([
        refusal("The server module a.ts (and 1 more)"),
      ]);
      fs.rmSync(path.join(dir, "src/server/lib"), { recursive: true });
      expect(nativeBuild(dir).errors).toEqual([
        refusal("The server module a.ts"),
      ]);
    });

    it("server modules in a configured directory, client content and XML metadata", () => {
      const dir = bareProject({
        serverModulesDir: "mods",
        clientDir: "ui",
        metadataDir: "meta",
      });
      writeFile(path.join(dir, "mods/x.mjs"));
      writeFile(path.join(dir, "ui/index.html"));
      writeFile(path.join(dir, "meta/update/sys_x.xml"));
      writeFile(path.join(dir, "src/server/ignored.ts"));
      expect(nativeBuild(dir)).toEqual({
        success: false,
        errors: [
          refusal("The server module x.mjs"),
          refusal("Client content (clientDir)"),
          refusal("XML metadata (metadataDir)"),
        ],
        warnings: [],
      });
    });

    it("ignores non-XML metadata files and empty policy lists", () => {
      const dir = bareProject({ networkPolicies: [] });
      writeFile(path.join(dir, "metadata/README.md"));
      expect(nativeBuild(dir).success).toBe(true);
    });

    it("runtime policies and a logo file", () => {
      const dir = bareProject({
        networkPolicies: [{}],
        wildcardPolicy: {},
        logo: "assets/logo.png",
      });
      expect(nativeBuild(dir).errors).toEqual([
        refusal(
          "The runtime policy configuration (networkPolicies, wildcardPolicy)",
        ),
        refusal("A logo file (assets/logo.png)"),
      ]);
    });
  });
});

describe("sys_app", () => {
  it("takes every field from the config", () => {
    const logo = "fedcba9876543210fedcba9876543210";
    const dir = bareProject({
      name: "Bare App",
      description: "Bare <app>",
      active: "false",
      jsLevel: "es5",
      menu: "x_acme_bare_menu",
      logo,
      guidedSetupGuid: "g",
      installedAsDependency: true,
      sysCode: "code",
      ideCreated: "studio",
      applicationRuntimePolicy: "enforcing",
      packageResolverVersion: "2.0.0",
      accessControls: {
        scopedAdministration: true,
        canEditInStudio: "no",
        restrictTableAccess: "true",
        runtimeAccessTracking: "enforcing",
        userRole: "admin",
        private: true,
        trackable: false,
        uninstallBlocked: true,
        hideOnUI: true,
      },
      licensing: {
        licensable: false,
        enforceLicense: "enforce",
        licenseModel: "per_user",
        subscriptionEntitlement: "sub",
        licenseCategory: "cat",
      },
    });
    expect(nativeBuild(dir).success).toBe(true);
    const xml = sysApp(dir);
    expect(
      Object.fromEntries(
        [
          "active",
          "application_runtime_policy",
          "can_edit_in_studio",
          "enforce_license",
          "guided_setup_guid",
          "hide_on_ui",
          "ide_created",
          "installed_as_dependency",
          "js_level",
          "licensable",
          "license_category",
          "license_model",
          "logo",
          "menu",
          "name",
          "package_json",
          "package_resolver_version",
          "private",
          "restrict_table_access",
          "runtime_access_tracking",
          "scoped_administration",
          "short_description",
          "subscription_entitlement",
          "sys_code",
          "trackable",
          "uninstall_blocked",
          "user_role",
        ].map((name) => [name, field(xml, name)]),
      ),
    ).toEqual({
      active: "false",
      application_runtime_policy: "enforcing",
      can_edit_in_studio: "true",
      enforce_license: "enforce",
      guided_setup_guid: "g",
      hide_on_ui: "true",
      ide_created: "studio",
      installed_as_dependency: "true",
      js_level: "es5",
      licensable: "false",
      license_category: "cat",
      license_model: "per_user",
      logo,
      menu: "x_acme_bare_menu",
      name: "Bare App",
      package_json: "x_acme_bare/bare-app/1.2.3/package.json",
      package_resolver_version: "2.0.0",
      private: "true",
      restrict_table_access: "true",
      runtime_access_tracking: "enforcing",
      scoped_administration: "true",
      short_description: "Bare &lt;app&gt;",
      subscription_entitlement: "sub",
      sys_code: "code",
      trackable: "false",
      uninstall_blocked: "true",
      user_role: "admin",
    });
  });

  it("names the app after the package and derives the tracking from the policy", () => {
    const dir = bareProject({ applicationRuntimePolicy: "tracking" });
    nativeBuild(dir);
    const xml = sysApp(dir);
    expect(field(xml, "name")).toBe("bare-app");
    expect(field(xml, "runtime_access_tracking")).toBe("permissive");
  });

  it("leaves the tracking empty when it is 'none'", () => {
    const dir = bareProject({
      accessControls: { runtimeAccessTracking: "none" },
    });
    nativeBuild(dir);
    expect(field(sysApp(dir), "runtime_access_tracking")).toBe("");
  });

  it("uses the global module layout for a global app", () => {
    const dir = bareProject({ scope: "global" });
    nativeBuild(dir);
    const xml = sysApp(dir);
    expect(field(xml, "package_json")).toBe(
      "/global/bare-app/1.2.3/package.json",
    );
    expect(field(xml, "package_resolver_version")).toBe("2.0.0");
  });

  it("refuses a tracking setting the runtime policy contradicts", () => {
    const dir = bareProject({
      applicationRuntimePolicy: "enforcing",
      accessControls: { runtimeAccessTracking: "permissive" },
    });
    expect(nativeBuild(dir).errors).toEqual([
      "Runtime Access Tracking is set to 'permissive' but Application Runtime Policy 'enforcing' requires 'enforcing'. " +
        "Set runtimeAccessTracking to 'enforcing' to match the Application Runtime Policy.",
    ]);
  });

  it("refuses a global app on the legacy resolver", () => {
    const dir = bareProject({
      scope: "global",
      packageResolverVersion: "1.0.0",
    });
    expect(nativeBuild(dir).errors).toEqual([
      "Global modules must use packageResolverVersion: '2.0.0' or higher",
    ]);
    expect(fs.existsSync(path.join(dir, "dist"))).toBe(false);
  });
});

describe("moduleResolutionPath", () => {
  const pkg = { name: "app", version: "1.0.0" };

  it("lays out legacy, scoped and global modules", () => {
    expect(moduleResolutionPath({ scope: "x_a" }, pkg, "f")).toBe(
      "x_a/app/1.0.0/f",
    );
    expect(
      moduleResolutionPath(
        { scope: "x_a", packageResolverVersion: "2.0.0" },
        pkg,
        "f",
      ),
    ).toBe("x_a/app/1.0.0/f");
    expect(
      moduleResolutionPath(
        { scope: "x_a", packageResolverVersion: "1.0.0" },
        pkg,
      ),
    ).toBe("x_a/app/1.0.0");
    expect(moduleResolutionPath({ scope: "global" }, pkg, "f")).toBe(
      "/global/app/1.0.0/f",
    );
  });
});

describe("sbomContent", () => {
  const stamp = {
    timestamp: new Date(SDK_TIMESTAMP),
    serialNumber: SDK_SERIAL,
  };

  it("splits a scoped package name and leaves out a missing license and scope id", () => {
    const bom = JSON.parse(
      sbomContent(
        { packageName: "@acme/app", packageVersion: "1.0.0", scopeId: "" },
        stamp,
      ),
    ) as { metadata: { component: Record<string, unknown> } };
    expect(bom.metadata.component).toEqual({
      type: "application",
      group: "@acme",
      name: "app",
      version: "1.0.0",
      "bom-ref": "pkg:servicenow/%40acme%2Fapp@1.0.0",
      purl: "pkg:servicenow/%40acme%2Fapp@1.0.0",
    });
  });
});
