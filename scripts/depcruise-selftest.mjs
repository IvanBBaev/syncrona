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
 * This self-test closes that hole with two complementary checks:
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
 * Fixtures are generated at runtime in an OS temp dir (never persisted in the
 * repo) so they can never be picked up by tsc, eslint, jest or `npm pack`.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

/**
 * Materialise a throwaway fixture tree under `root` in which every forbidden
 * boundary rule is intentionally violated. Paths mirror the real workspace so
 * the rules' `^packages/...` `from` globs match; the imported `@syncrona/*`
 * specifiers deliberately do not resolve (there is no node_modules here) and are
 * recorded as raw-specifier edges the `to` globs match.
 */
export function writeViolatingFixtures(root) {
  const w = (rel, content) => {
    const abs = path.join(root, rel);
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, "utf8");
  };
  // consumers-are-siblings: a consumer importing the other consumer.
  w("packages/core/src/violation.ts", "import '@syncrona/mcp-server';\nexport const a = 1;\n");
  // foundation-no-consumers: a foundation package importing a consumer.
  w("packages/credential-store/src/violation.ts", "import '@syncrona/core';\nexport const b = 1;\n");
  // types-is-leaf: @syncrona/types importing another @syncrona package.
  w("packages/types/index.d.ts", "import { X } from '@syncrona/core';\nexport type Y = X;\n");
  // plugins-are-leaves: a build plugin importing a non-types @syncrona package.
  w("packages/babel-plugin/src/violation.ts", "import '@syncrona/core';\nexport const c = 1;\n");
  // no-circular: a genuine runtime (value) cycle between two local modules.
  w("packages/core/src/cyclea.ts", "import { b } from './cycleb';\nexport const a = b + 1;\n");
  w("packages/core/src/cycleb.ts", "import { a } from './cyclea';\nexport const b = 1;\nexport const z = a;\n");
  return root;
}

/**
 * Positive fire-check: cruise a freshly-generated violating fixture tree with
 * `rules` and return the names of any rules that did NOT fire. An empty array
 * means every rule was actually violated (good).
 */
export async function findUnfiredRules(rules, { keepFixtures = false } = {}) {
  const root = mkdtempSync(path.join(tmpdir(), "depcruise-selftest-"));
  writeViolatingFixtures(root);
  // dependency-cruiser reports module sources relative to process.cwd(); the
  // rules are anchored `^packages/...`, so we must cruise from the fixture root.
  const cwd = process.cwd();
  process.chdir(root);
  let output;
  try {
    ({ output } = await cruise(
      ["packages"],
      { validate: true, ruleSet: { forbidden: rules }, tsPreCompilationDeps: true },
    ));
  } finally {
    process.chdir(cwd);
    if (!keepFixtures) rmSync(root, { recursive: true, force: true });
  }
  const fired = new Set(
    (output.summary.violations || []).map((v) => v.rule && v.rule.name).filter(Boolean),
  );
  return rules.map((r) => r.name).filter((name) => !fired.has(name));
}

/** Run both checks. Returns a structured result; never calls process.exit. */
export async function runSelftest({ console: log = console } = {}) {
  const rules = loadForbiddenRules();

  const sources = cruiseWorkspaceSources();
  const deadRules = findDeadRules(rules, sources);
  const unfiredRules = await findUnfiredRules(rules);

  const errors = [];
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
      `depcruise self-test OK: all ${rules.length} boundary rule(s) reach at ` +
        `least one of ${sources.length} cruised modules and fire on a violating fixture.`,
    );
  }
  return { ok, deadRules, unfiredRules, ruleCount: rules.length, moduleCount: sources.length, errors };
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
