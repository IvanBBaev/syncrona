// SPDX-License-Identifier: GPL-3.0-or-later
/**
 * dependency-cruiser boundary self-test (guards gap-analysis #11; REV-103).
 *
 * The original `.dependency-cruiser.cjs` shipped a `types-is-leaf` rule whose
 * `from` glob (`^packages/types/src`) matched ZERO modules — `types` has no
 * `src/`, its declarations live at `packages/types/index.d.ts` — so the rule
 * could never fire and silently provided no protection. dependency-cruiser does
 * NOT treat a rule that matches no modules as an error, so this rot is invisible
 * to `npm run lint:boundaries`.
 *
 * This self-test closes that hole with three complementary checks:
 *
 *  1. Reachability (dead-rule): cruise the workspace exactly as `lint:boundaries`
 *     does and assert every boundary rule's `from` scope reaches at least one
 *     real module. Catches a `from` glob that matches nothing (or an
 *     `--include-only` glob that drops a targeted package).
 *
 *  2. Positive fire-check (REV-103): reachability alone proves a rule's `from`
 *     scope is non-empty, not that the rule can actually be VIOLATED — a `to`
 *     clause could be mistyped so the rule never fires no matter what. So this
 *     step materialises a throwaway fixture tree in which EVERY forbidden rule
 *     is intentionally violated, cruises it with the real rule set, and asserts
 *     each rule appears in the reported violations. If a config change makes a
 *     rule un-fireable, its fixture stops tripping it and this check fails —
 *     the guarantee `.dependency-cruiser.cjs` already advertises ("a fixture
 *     that intentionally violates each rule below").
 *
 *  3. Severity check (REV-132): a fired rule only BLOCKS when its severity is
 *     "error" — `depcruise` exits on `summary.error`, never on `summary.warn`.
 *     Checks 1 and 2 are severity-blind (dependency-cruiser reports violations of
 *     every severity in `summary.violations`), so downgrading a rule to "warn"
 *     used to void the architecture contract with BOTH gates still green.
 *
 * Fixtures are generated at runtime in an OS temp dir (never persisted in the
 * repo) so they can never be picked up by tsc, eslint, jest or `npm pack`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import { cruise } from "dependency-cruiser";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, "..");
const configPath = path.join(repoRoot, ".dependency-cruiser.cjs");

// The same include-only scope used by `lint:boundaries`.
const INCLUDE_ONLY = "^packages/([^/]+/src|types/)";

const require = createRequire(import.meta.url);

/** Load the forbidden-rule set from the real config so this test always tracks it. */
export function loadForbiddenRules(cfgPath = configPath) {
  const config = require(cfgPath);
  return config.forbidden || [];
}

/** Load the real cruise `options` so the fixture is filtered like the real gate. */
export function loadCruiseOptions(cfgPath = configPath) {
  const config = require(cfgPath);
  return config.options || {};
}

/**
 * Severity check (REV-132): rule names whose severity is not "error".
 *
 * `depcruise` exits non-zero on `summary.error` only (dependency-cruiser's error
 * reporter returns `exitCode: summary.error`), so a rule at "warn"/"info" is
 * reported and then ignored by the gate. Both other checks are severity-blind —
 * `summary.violations` holds violations of EVERY severity — so without this a
 * one-word edit turning the rules into warnings kept `lint:boundaries` AND this
 * self-test green while every module boundary went unenforced.
 */
export function findNonErrorRules(rules) {
  return rules.filter((rule) => rule.severity !== "error").map((rule) => rule.name);
}

/**
 * Cruise the workspace as `lint:boundaries` does and return the list of module
 * source paths. Kept on the CLI (`npx depcruise`) so the reachability check sees
 * exactly the module set the real lint gate produces.
 */
export function cruiseWorkspaceSources() {
  let raw;
  try {
    raw = execFileSync(
      "npx",
      [
        "depcruise",
        "packages",
        "--include-only",
        INCLUDE_ONLY,
        "--config",
        configPath,
        "--no-progress",
        "--output-type",
        "json",
      ],
      { cwd: repoRoot, encoding: "utf-8", maxBuffer: 32 * 1024 * 1024 },
    );
  } catch (err) {
    // depcruise exits non-zero when there ARE violations, but still prints JSON.
    raw = err.stdout;
    if (!raw) {
      const detail = String(err && err.stderr ? err.stderr : err);
      throw new Error(`depcruise self-test: could not obtain cruise output.\n${detail}`);
    }
  }
  const result = JSON.parse(raw);
  return result.modules.map((m) => m.source);
}

/** Reachability check: rule names whose `from.path` matches no cruised module. */
export function findDeadRules(rules, sources) {
  const dead = [];
  for (const rule of rules) {
    if (!rule.from || typeof rule.from.path !== "string") continue;
    const re = new RegExp(rule.from.path);
    if (!sources.some((s) => re.test(s))) dead.push(rule.name);
  }
  return dead;
}

// The fixture packages, mirroring the real workspace: directory -> package name.
// The core CLI publishes as the UNSCOPED `syncrona` (packages/core/package.json);
// `@syncrona/core` names no package anywhere and must never appear in a fixture.
const FIXTURE_PACKAGES = {
  core: "syncrona",
  "mcp-server": "@syncrona/mcp-server",
  "credential-store": "@syncrona/credential-store",
  "babel-plugin": "@syncrona/babel-plugin",
};

/**
 * Materialise a throwaway fixture tree under `root` in which every forbidden
 * boundary rule is intentionally violated. Paths mirror the real workspace so
 * the rules' `^packages/...` `from` globs match.
 *
 * REV-139: the fixture used to omit node_modules, so every `@syncrona/*` import
 * stayed unresolved and was recorded as a raw-specifier edge. That is NOT the
 * configuration users lint: after `npm install` each workspace package is
 * symlinked under node_modules, so the very same import resolves to
 * `packages/<pkg>/dist/index.js`. A rule matching the specifier form only
 * therefore fired here and was silently inert in the real repo — exactly the
 * blind spot this self-test exists to prevent. The fixture now materialises the
 * workspace symlinks (and the `dist` entry points they resolve to) so the
 * fire-check runs against resolvable specifiers.
 */
export function writeViolatingFixtures(root, { tsConfigFileName = "tsconfig.json" } = {}) {
  const w = (rel, content) => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  };
  // Package manifests + compiled entry points, so a `@syncrona/*` import resolves
  // the way it does in an installed workspace (`doNotFollow` stops the descent).
  for (const [dir, name] of Object.entries(FIXTURE_PACKAGES)) {
    w(
      `packages/${dir}/package.json`,
      `${JSON.stringify({ name, version: "0.0.0", main: "dist/index.js", types: "dist/index.d.ts" }, null, 2)}\n`,
    );
    w(`packages/${dir}/dist/index.js`, "module.exports = {};\n");
    w(`packages/${dir}/dist/index.d.ts`, "export declare const x: number;\n");
  }
  w(
    "packages/types/package.json",
    `${JSON.stringify({ name: "@syncrona/types", version: "0.0.0", types: "index.d.ts" }, null, 2)}\n`,
  );
  // `options.tsConfig` is passed through from the real config, so the fixture
  // needs a tsconfig at the same relative path or the cruise cannot start.
  w(
    tsConfigFileName,
    `${JSON.stringify({ compilerOptions: { target: "ES2022", module: "NodeNext", moduleResolution: "NodeNext" } }, null, 2)}\n`,
  );

  // consumers-are-siblings: a consumer importing the other consumer (both ways).
  w("packages/core/src/violation.ts", "import '@syncrona/mcp-server';\nexport const a = 1;\n");
  w("packages/mcp-server/src/violation.ts", "import 'syncrona';\nexport const m = 1;\n");
  // foundation-no-consumers: a foundation package importing a consumer.
  w("packages/credential-store/src/violation.ts", "import 'syncrona';\nexport const b = 1;\n");
  // types-is-leaf: @syncrona/types importing another @syncrona package.
  w("packages/types/index.d.ts", "import { X } from '@syncrona/credential-store';\nexport type Y = X;\n");
  // plugins-are-leaves: a build plugin importing a non-types @syncrona package.
  w("packages/babel-plugin/src/violation.ts", "import '@syncrona/credential-store';\nexport const c = 1;\n");
  // no-circular: a genuine runtime (value) cycle between two local modules.
  w("packages/core/src/cyclea.ts", "import { b } from './cycleb';\nexport const a = b + 1;\n");
  w("packages/core/src/cycleb.ts", "import { a } from './cyclea';\nexport const b = 1;\nexport const z = a;\n");

  // The workspace links npm creates on install — without them the fixture only
  // ever exercises the unresolved-specifier form (see REV-139 above).
  mkdirSync(path.join(root, "node_modules", "@syncrona"), { recursive: true });
  symlinkSync("../packages/core", path.join(root, "node_modules", "syncrona"), "dir");
  for (const dir of [...Object.keys(FIXTURE_PACKAGES), "types"]) {
    if (dir === "core") continue;
    symlinkSync(`../../packages/${dir}`, path.join(root, "node_modules", "@syncrona", dir), "dir");
  }
  return root;
}

/**
 * Positive fire-check: cruise a freshly-generated violating fixture tree with
 * `rules` and return the names of any rules that did NOT fire. An empty array
 * means every rule was actually violated (good).
 */
export async function findUnfiredRules(rules, { keepFixtures = false, options } = {}) {
  // REV-132: the fixture used to be cruised with a hand-written option set
  // (`tsPreCompilationDeps` only), so the real config's `exclude`, `doNotFollow`
  // and `tsConfig` never applied here — the fixture could fire a rule the real
  // gate filters away. Default to the config's own options so both cruises see
  // the same module set.
  const cruiseOptions = options || loadCruiseOptions();
  const root = mkdtempSync(path.join(tmpdir(), "depcruise-selftest-"));
  writeViolatingFixtures(root, {
    tsConfigFileName: (cruiseOptions.tsConfig && cruiseOptions.tsConfig.fileName) || "tsconfig.json",
  });
  // dependency-cruiser reports module sources relative to process.cwd(); the
  // rules are anchored `^packages/...`, so we must cruise from the fixture root.
  const cwd = process.cwd();
  process.chdir(root);
  let output;
  try {
    ({ output } = await cruise(
      ["packages"],
      { ...cruiseOptions, validate: true, ruleSet: { forbidden: rules } },
    ));
  } finally {
    process.chdir(cwd);
    if (!keepFixtures) rmSync(root, { recursive: true, force: true });
  }
  // REV-132: only "error" violations count as fired. `summary.violations` lists
  // every severity, so a rule downgraded to "warn" still showed up here and the
  // fire-check stayed green while `depcruise` (which exits on `summary.error`)
  // no longer failed the build for it.
  const fired = new Set(
    (output.summary.violations || [])
      .filter((v) => v.rule && v.rule.severity === "error")
      .map((v) => v.rule.name)
      .filter(Boolean),
  );
  return rules.map((r) => r.name).filter((name) => !fired.has(name));
}

/** Run both checks. Returns a structured result; never calls process.exit. */
export async function runSelftest({ console: log = console } = {}) {
  const rules = loadForbiddenRules();

  const sources = cruiseWorkspaceSources();
  const deadRules = findDeadRules(rules, sources);
  const nonErrorRules = findNonErrorRules(rules);
  const unfiredRules = await findUnfiredRules(rules);

  const errors = [];
  if (nonErrorRules.length > 0) {
    errors.push(
      "The following boundary rule(s) are not at severity \"error\" and therefore " +
        `do NOT fail the build when violated: ${nonErrorRules.join(", ")}. ` +
        "`depcruise` exits non-zero on error-severity violations only, so a " +
        "\"warn\"/\"info\" rule is advisory decoration, not an enforced boundary.",
    );
  }
  if (deadRules.length > 0) {
    errors.push(
      "The following boundary rule(s) match ZERO modules and can never fire " +
        `(dead rule / silent no-op): ${deadRules.join(", ")}. Fix the rule's ` +
        "`from` path, or widen the `lint:boundaries` `--include-only` glob so " +
        "the targeted package is in scope.",
    );
  }
  if (unfiredRules.length > 0) {
    errors.push(
      "The following boundary rule(s) did NOT fire on a fixture that " +
        `intentionally violates them (rule can never be enforced): ${unfiredRules.join(", ")}. ` +
        "Check the rule's `to` clause and the fixture in `writeViolatingFixtures`.",
    );
  }

  const ok = errors.length === 0;
  if (!ok) {
    log.error("depcruise self-test FAILED:");
    for (const err of errors) log.error(`  - ${err}`);
  } else {
    log.log(
      `depcruise self-test OK: all ${rules.length} boundary rule(s) are at severity ` +
        `"error", reach at least one of ${sources.length} cruised modules and fire ` +
        "on a violating fixture.",
    );
  }
  return {
    ok,
    deadRules,
    nonErrorRules,
    unfiredRules,
    ruleCount: rules.length,
    moduleCount: sources.length,
    errors,
  };
}

const isMain = import.meta.url === pathToFileURL(process.argv[1] || "").href;
if (isMain) {
  runSelftest()
    .then((result) => {
      if (!result.ok) process.exit(1);
    })
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
