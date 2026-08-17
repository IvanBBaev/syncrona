# Contributing to SyncroNow AI

## Prerequisites

- Node.js **22** and npm **10+** (see `.nvmrc` / `.node-version`)
- `npm install` at the repository root (npm workspaces; per-package lockfiles
  are intentionally absent — only the root `package-lock.json` is canonical)

## Repository tour

Read [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) first — it documents the
package graph, the two ServiceNow clients and their shared transport policy,
and (section 5) the **module contract**: the exact recipe for adding or
removing a CLI command (`packages/core/src/cliCommands.ts` registry) or an
MCP tool family (`packages/mcp-server/src/toolModules.ts` registry).
[docs/PRODUCT_STATE.md](docs/PRODUCT_STATE.md) tracks what is done and what
remains; `TODO` and `DONE` are the working journals.

## Quality gates — run before every change is "done"

```bash
npm run build      # build:deps (credential-store, sn-transport) + all workspaces
npm run typecheck  # tsc across core + mcp-server
npm run lint       # eslint core + mcp-server, --max-warnings=0
npm run test       # 3000+ tests: core jest (1059) + mcp node:test (1683) + shared + plugins
npm run check      # the full gate — every link below, in order
```

`npm run check` = build + typecheck + lint (incl. dependency boundaries) + all
workspace tests + coverage gates + `test:coverage:annotations` + governance gates
+ `verify:pack` (tarball contents and bin smoke) + `bench:guard` + `scan:secrets`.

Three of these links are newer than the rest and each mirrors something CI does,
so a local run and a CI run agree:

- **`bench:guard`** runs `scripts/bench.mjs --max-ms 25` over the CPU-bound
  manifest/doc path. Loose on purpose, and the ceiling comes from the median
  measured while the machine was **under load** (4.9 ms), not the idle median
  (0.97 ms) — a shared CI runner is the loaded case, and a performance gate that
  flakes gets disabled. It is a blowup detector for an accidental O(n²), not a
  microbenchmark.
- **`scan:secrets`** runs gitleaks over the working tree with the same
  `.gitleaks.toml` the CI `secret-scan` job uses. gitleaks is not an npm
  dependency; without it the step prints an explicit SKIPPED notice instead of a
  false pass (`brew install gitleaks` to get the real answer before you push).
  The CI job remains the enforcing gate — it scans the full history from a pinned
  action. A fixture value that trips a rule must be marked with an inline
  `gitleaks:allow` comment explaining why it is inert; do **not** allowlist its
  directory, and see the security note in `.gitleaks.toml` for why.
- **`test:coverage:annotations`** runs `scripts/check-coverage-annotations.mjs`,
  which compares every `// measured L/B` comment beside a coverage floor with the
  report that package actually produced. Both floor audits (core GATE-3,
  mcp-server `coverageGatePerFile.test.js`) enforce a maximum *headroom* — measured
  minus floor — against that comment, so a stale comment makes the judgement about
  whether a floor is safe to raise wrong. Ten of them had drifted when the gate
  first ran, in both directions. It takes the floor **keys** from the two configs
  by `require()`, so the audited set is by construction the enforced set, and it
  fails closed: a missing report, a stale report, a suspected partial report (an
  annotated file at 0.00% lines against a non-zero annotation — the trace of a
  filtered `--testPathPatterns` run), a floor with no annotation, or an annotation
  naming a file the report does not contain all exit non-zero rather than
  reporting "no drift". It reuses the reports the two coverage links just
  wrote, so it adds no second test run — but it must therefore stay *after* them
  in the chain.
  There is one narrow escape hatch, and only on the mcp-server side: V8 range
  coverage is not reproducible run-to-run on an unchanged tree, so an entry may
  record a **declared second reading**, `// measured L / B (also L / B: cause)`.
  Exactly the two recorded readings pass and a third is still drift — a
  declaration is not a tolerance window, which would absorb the real regressions
  this gate has caught (one moved a file by 0.42 points). The cause is mandatory,
  the *lower* reading is written first because both floor audits parse the first
  pair, and the core/istanbul target rejects a declaration outright: three full
  runs there produced a byte-identical summary, so an istanbul annotation that no
  longer matches is drift, not flicker.

Every link of the chain also runs as its own CI step, and that is enforced:
`packages/mcp-server/test/ciCheckChain.test.js` re-derives the chain from the
root `package.json` and fails the build if a link has no matching step in
`.github/workflows/ci.yml`, so the local gate and the CI gate cannot drift apart.

`npm run test:mutation` is deliberately **not** a link — a mutation run is far
too slow for a per-change gate. Run it by hand (or per package, e.g.
`npm --workspace syncrona run test:mutation`) when you change logic whose tests
you want to trust. Two things to know before you do:

- **Never hand-inject a mutant into the real source tree.** Verifying "does my test
  kill this mutant?" by editing `src/` directly means every other suite run —
  yours, another terminal's, an editor's test task — compiles and executes the
  mutant and reports failures that are not real. That has cost real debugging time
  here. Stryker itself is safe in this respect: it copies the repo into
  `.stryker-tmp/sandbox-*/` and builds that copy's own `dist/`, so the tree you
  work in is untouched (verified: the sandbox `dist/` is a real directory, rebuilt
  per mutant, while the checkout's `dist/` keeps its timestamp). If you must
  hand-inject, do it in a scratch clone, or restore and re-verify by checksum.
- **A mutation run saturates the machine** (concurrency 12 with no coverage
  analysis, since the command runner reports only a whole-suite exit code). Running
  another heavy suite alongside it does not corrupt your tree, but it can push a
  sandbox past `timeoutMS` — and Stryker scores a timeout as a **kill**, so the
  score comes out inflated. Let the run finish before you start something big.
- **A table-completeness fixture must be a literal list inside the test file.** A
  list derived by parsing the source at runtime moves *with* the mutant — the
  assertion stays true, the mutant survives, and the test measures nothing while
  looking rigorous. See `test/safetyPolicy.tableCompleteness.test.js`, which is why
  that suite spells out all 302 allowlisted git subcommand options by hand.

Both configs write a machine-readable report next to the console output
(`packages/core/reports/mutation/core.json`,
`reports/mutation/mcp-server.json` — both gitignored). Read it with:

```bash
node --max-old-space-size=8192 scripts/mutation-triage.mjs reports/mutation/mcp-server.json
```

The extra heap is not optional for a large module: the report for `safetyPolicy.ts`
alone is ~350 MB, because Stryker embeds the full source next to every one of its
1039 mutants.

It prints the score, the killed/timeout/survived/no-coverage split, and — the part
that matters — **survivors grouped by mutator**. The clear-text reporter lists
survivors in file order, which hides the only thing worth knowing: whether you are
looking at N problems or one missing kind of test. The first `safetyPolicy.ts`
measurement came back with 383 survivors, of which 327 were `StringLiteral` and most
of those the same shape — one entry emptied out of a policy table. That is a single
gap, and it took one table-completeness suite to close. Use `--mutator <name>` to
drill into one group and `--limit 0` to print them all.

### `npm run race:lock` — the collaboration-lock race harness

`npm run race:lock` builds, then spawns N real processes against one real temp
directory and releases them from a busy-wait barrier into the same millisecond:

```bash
npm run race:lock                                            # 20 rounds × 12 racers
node scripts/lock-race.mjs --rounds 20 --racers 24 --mode stale
node scripts/lock-race.mjs --racers 12 --hold-ms 0 --release 0
```

Also not a `check` link — it costs minutes and needs a quiet machine. Run it whenever
you touch `acquireCollaborationLock` / `releaseCollaborationLock` / `evictLockFile` in
`packages/core/src/pushCommand.ts`. Three things to know:

- **It must be separate processes.** The lock's two load-bearing mechanisms are
  kernel-level — `link()`'s all-or-nothing publication and `process.kill(pid, 0)`
  liveness. Neither means anything inside one Node process against a mocked
  filesystem, so the unit suites can only assert the logic *around* them. Every real
  defect this lock has had was found here and was invisible to the unit suites.
- **"One winner per round" is the wrong invariant.** The first version of this check
  used it and reported 15/15 failures against correct code: a winner that releases —
  or simply exits, freeing its lock by pid liveness — legitimately hands the lock to a
  racer still in its retry loop. Sequential handoff is the system working. The harness
  instead flags overlapping *held intervals* and, decisively, a holder that ever polls
  its own lock file and sees anything but its own pid.
- **A green run with no contention is a false green**, so the harness exits non-zero as
  `INCONCLUSIVE` when a multi-racer run records no losses and no handoffs, and rejects
  non-integer `--rounds` / `--racers` / `--hold-ms`. Both guards exist because a matrix
  run once "passed" all nine configurations instantly — zsh does not word-split
  unquoted expansions, `--rounds` parsed to `NaN`, and zero rounds ran.

### `scripts/stdio-fuzz.js` — the MCP stdio boundary harness

Unlike the two above, this one **is** in the default suite (`test/stdioFuzz.test.js`),
because it costs 221 ms. Run it standalone for a readable report:

```bash
cd packages/mcp-server && npm run build && node scripts/stdio-fuzz.js
# frames=42 messages=68 stdout=46802B violations=0
```

It spawns the compiled server as a real child process and writes 42 hostile frames
into its stdin, checking five invariants after each: stdout stays pure JSON-RPC,
the process still answers a `ping`, no response id was unrequested or reused, no
error payload leaks a stack frame or an absolute path, and the corpus never made
the server do real work. Two things to know before you add a frame:

- **Keep it non-executing.** The corpus uses tool names that do not exist and
  argument shapes the boundary rejects before dispatch. That is the whole reason it
  can live in the default suite — and it is checked, not trusted: the harness reads
  the server's own audit log at the end and fails on any `tool.call` with
  `ok: true`. The check exists because the first draft's two `timeoutMs` frames
  named the real `sync_status` tool, each spawned a 2–4 s subprocess, and the run
  became flaky under load. Prove a timeout or dispatch *semantic* in a unit test;
  prove only the *bytes* here.
- **Write non-ASCII payloads as escapes, not literals.** The bidi-override frame
  (Trojan Source, CVE-2021-42574) uses `\u202E`/`\u202C` string escapes. With the
  literal characters in the file, `grep` classifies the whole source as binary and
  silently matches nothing — which cost real time here — and the file would itself
  carry the exact bytes a source scanner exists to flag.

CI runs the same gates plus governance checks (tool-contract hash,
README/CLAUDE.md docs-drift, release checklist) — on GitHub Actions via
`.github/workflows/ci.yml` (matrix: ubuntu + macOS), with CodeQL SAST in
`.github/workflows/codeql.yml` and the owner-gated publish in
`.github/workflows/release.yml`.

The core Jest coverage floor is a ratchet in `packages/core/jest.config.cjs`:
**statements 92 / branches 79 / functions 89 / lines 92** globally, two tree-wide
globs at **81 lines / 67 branches** that catch any file drifting far below its
neighbours, plus per-file floors for the highest-risk modules (a global-only floor
lets one weak file hide behind the tree average). All of them are set just under
the measured baseline; raise, never lower. Each floor records its measurement
inline as `// measured L/B`, and those comments are machine-checked from both
sides: GATE-3 asserts the floor sits under its annotation and within the allowed
headroom, `test:coverage:annotations` asserts the annotation still equals reality.
Two mcp-server entries carry a second reading in the `(also L / B: cause)` form
described above; both floor audits read the first pair only, which is why that
pair must be the lower of the two.

Branch floors sit further under the measurement than line floors on purpose —
branch coverage is what moves between macOS and Linux CI. That used to include
`process.platform`, and it cost a red build: `mcpCommand.ts` had no named floor,
measured 83.33 / 68.18 on macOS, and failed the tree-wide line floor **by a single
line** on ubuntu (77.77 / 52.27). The fix was not a lower floor but a suite that
*pins* the platform instead of reading it. `process.platform` now appears in
exactly two source files here (`mcpCommand.ts`, `diagnosticsCommands.ts`), and
every arm of both is pinned by a test — including the arms a macOS host used to
walk into for free. Verified by re-running the whole core suite with
`process.platform` forced to `linux`: **every one of the 21 annotated files, and
both platform files, measure identically on the two platforms**, so the annotation
gate above cannot go red on one half of the CI matrix and green on the other.
Re-run that check before adding a `process.platform` branch. **A test that mirrors the source's own
`process.platform` branching to build its expectations is not a test** — on the
other OS both arms go false, the assertion loop iterates zero times, and it passes
having asserted nothing. Pin the platform and assert the behaviour.

The MCP server gate works the same way through
`packages/mcp-server/scripts/check-coverage-gate.js`: **90% line / 80% branch**
aggregate, an **80 / 45** per-file default, and named floors for the policy, audit,
transport and process-spawning modules. In both packages a floor whose pattern no
longer matches any file **fails** the gate rather than silently gating nothing — if
you rename a module, move its floor with it.

**Running a single test file:** run it from inside the package — ts-jest is
configured per-package — e.g. `cd packages/core && npx jest src/tests/foo.test.ts`,
or `npm --workspace syncrona test`. Running `npx jest <file>` from the
**repo root** falls back to Babel and fails to parse TypeScript (`as` casts);
that's a runner-resolution quirk, not a code error.

## Conventions

- **Coverage is a ratchet.** `packages/core/jest.config.cjs` thresholds may be
  raised, never lowered.
- **stdout discipline (MCP):** the MCP server speaks JSON-RPC on stdout —
  log only to stderr (`logger.ts`).
- **Transport policy lives in `@syncrona/sn-transport`** — never re-hardcode
  scoped prefixes, retry statuses, or endpoint-not-found statuses in a client.
- **Command tables drift-checked:** changing the CLI surface requires updating
  README and CLAUDE.md in the same change, or CI fails.
- **Destructive CLI actions confirm first** and support `--dry-run`/`--ci`.
- **Security:** never commit `.env` / credentials; `npm audit --omit=dev`
  should stay at 0 vulnerabilities — fix or document exceptions.
- Tests must be order-independent: restore `global.fetch`, close servers in
  `finally`, and reset module caches via the provided seams
  (`clearServiceNowSecretsCache`, `clearScopedApiPrefixCache`).
