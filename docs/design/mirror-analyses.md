# Full-Instance Git Mirror — Senior Analyses

Companion to [full-instance-git-mirror.md](full-instance-git-mirror.md) (the design
document). That document says *what* the mirror is; this one records the analyses a
senior engineer runs **before** committing to an architecture: consistency semantics,
failure taxonomy, threat model, format evolution, testability, operations, empirical
probes, and prior art. Where an analysis forces a change or an addition to the design
document, the delta is listed in [§10](#10-consolidated-design-deltas).

Section references of the form "design §N" point at full-instance-git-mirror.md.

Status of empirical inputs:

| Input | Status |
|---|---|
| Instance API probe (18-question battery) | **Complete** — ran 2026-08-17 against ven01800 (1M-row vendor instance); 3 new binding findings ([§7](#7-empirical-probe-complete)) |
| Git-at-scale local benchmark (20k/100k trees) | **Complete** ([§9](#9-git-at-scale-benchmark-complete)) |
| Prior-art survey | **Complete** ([§8](#8-prior-art-survey-complete)) |

---

## 1. Consistency model — what a mirror commit actually is

A table-by-table sweep of a live instance is a **non-atomic read**. The formal
position, stated once so every later component inherits it:

- **Intra-table.** Keyset pagination (`sys_id>cursor` + `ORDERBYsys_id`) is immune to
  offset drift, but a record updated mid-sweep appears in its old or new version
  depending on page timing; a record inserted behind the cursor is missed until the
  next sync; a record deleted ahead of the cursor simply never appears. All three
  converge on the next sync. Per-table reads are *eventually consistent*.
- **Cross-table.** Graph artifacts (a form = `sys_ui_form` + sections + elements) are
  fetched at different times. A mid-sweep edit can produce a mirrored graph state
  that **never existed on the instance** (section from t1, element from t2). The
  canonical layer MUST tolerate dangling references — report them in coverage, never
  fail the sync, never "fix up" the data.
- **Definition.** A mirror commit is an *observed state*, not a transactional
  snapshot. It converges to the true instance state under quiescence.
- **Provable quiescence.** Capture per-table `MAX(sys_updated_on)` + `COUNT(*)`
  (one Aggregate call per table) before the sweep and re-check after. If unchanged,
  the commit is provably quiescent. `mirror sync --verify-quiescent` performs this
  check, sets a flag in the coverage report, and appends the commit-message trailer
  `Mirror-Consistency: quiescent`. Release baselines should be quiescent commits
  taken in an off-hours window.
- **Push-back consequence.** Because the mirror may be internally torn, graph
  push-back must go through instance-side validation (update-set preview) — never
  trust mirror-internal graph consistency. This reinforces design §12 Phase D.

## 2. Failure taxonomy and normative handling rules

Every failure the sync loop can meet, with its required behavior. "Coverage entry"
means a machine-readable reason recorded in `coverage.json` (design §11).

| # | Failure class | Detection | Action | Coverage entry | Exit |
|---|---|---|---|---|---|
| F1 | Transient transport (408/425/429/5xx) | status code | retry with backoff, honor `Retry-After` if present; exhausted → fail the table | `transient-exhausted` | 2 |
| F2 | Auth expiry mid-sweep | 401 (JSON envelope) | token refresh (existing v1 machinery), one retry; then fatal | — | 1 |
| F3 | ACL denial | 403, or row-count mismatch vs Aggregate count | mark table `partial`, continue | `acl-403` / `not-visible` | 2 |
| F4 | Instance offline / hibernated | connect error / HTML body | checkpoint + stop | `instance-unreachable` | 1 |
| F5 | Schema drift mid-sync (column vanished) | field absent in fetched row | omit the file, keep the record | `column-missing` | 2 |
| F6 | Blob parse failure (e.g. flow snapshot not valid JSON) | `JSON.parse` throws | store verbatim with `raw:` marker (design §7.2) | `parse-failure` | 2 |
| F7 | Redaction scan overflow | scan budget exceeded | redact the whole value — fail closed | `redacted-overflow` | 2 |
| F8 | Local disk / git lock failure | fs errors | checkpoint + stop; tree stays consistent (atomic writes) | — | 1 |
| F9 | Name collision after case/Unicode folding | canonical-name clash | deterministic `_<sys_id>` suffix (v1 rule) | — | 0 |

Normative rules (the architecture document turns these into invariants):

- **R1 — exit codes.** `0` = complete, `1` = fatal/incomplete stop, `2` =
  completed-with-partials. CI can distinguish "the mirror is whole" from "the mirror
  is honest but partial".
- **R2 — shard truthfulness.** A manifest shard is written only when its table's
  sweep completed; until then the checkpoint holds progress. A shard may never claim
  completeness it does not have.
- **R3 — no silent skips.** Every skip or degradation lands in `coverage.json`.
  Silence is a bug, not a policy.
- **R4 — no corrupting failures.** All writes are atomic (temp file + rename, the
  v1 pattern). Any failure leaves the tree in the pre-write or post-write state,
  never in between.

## 3. Threat model (STRIDE-lite)

Assets: (1) instance data in the mirror repo — possibly pushed to a remote,
(2) instance credentials, (3) the instance itself, (4) the mirror host.

- **T1 — Secret exfiltration into git (top risk).** Deny-by-default redaction:
  field-type deny (`password`, `password2`), key-pattern deny, value-scan
  (design §10) — plus a gitleaks tripwire in CI and a documented default that the
  mirror repo must be private. Residual risk: novel secret formats; mitigated by an
  allowlist review process and a scanner corpus that ships in `@syncrona/redaction`
  and is versioned independently of the mirror.
- **T2 — PII.** Tier-3 reference data is off by default; residual PII can still
  appear in T1/T2 free text (descriptions, user names inside metadata). Position:
  the mirror has the **same sensitivity class as an instance backup** — document
  that honestly rather than pretending redaction solves it.
- **T3 — Credential theft.** Reuse the v1 credential store (AES-GCM + OS keychain);
  CI uses `SYNCRONA_STORE_KEY` from a secrets manager (existing guidance). The
  mirror adds no new credential storage.
- **T4 — Malicious record content attacking the mirror host.** Mirrored bodies are
  untrusted input. The mirror never executes or evals mirrored content; path
  components are validated (lift of `assertSafePathComponent`); shard keys must
  match `/^[0-9a-f]{32}$/`; JSON canonicalization uses `parse`/`stringify` only.
- **T5 — Mirror tampering → push-back poisoning.** Push-back requires update-set
  preview plus an explicit confirm gate; branch protection on the mirror repo is
  recommended **before** any write-capable phase lands.
- **T6 — DoS on the instance.** Concurrency/rate cap, defensive `Retry-After`
  honoring, off-hours full sweeps, and Aggregate-first planning so empty tables are
  never row-scanned.

## 4. Format versioning and migration

- `formatVersion` is stamped in every manifest shard and in `mirror.config.js`.
  Current = 1.
- Additive fields do not bump the version. **Any byte-level change to canonical
  output for unchanged input requires a version bump** plus a `mirror migrate`
  command that rewrites the tree in a single, clearly labeled commit. A migration is
  never mixed with a sync commit — otherwise real drift becomes invisible inside
  format churn.
- Enforcement: golden-fixture byte tests (input API JSON → expected tree bytes) lock
  the serializer; CI fails on any byte drift without a version bump. This is what
  makes byte stability survive maintenance by many agents over time.

## 5. Testability strategy

The property that makes agent-driven implementation viable: every component testable
without a network.

- **FakeInstanceServer** — a local HTTP server implementing the used subset of
  Table / Aggregate / Attachment API over a deterministic fixture dataset
  (record it from ven01800 — sanitized — using the §7 probe scripts as a base;
  the wire shapes to reproduce are the measured M1–M18).
  Enables full `mirror sync` E2E, byte-stability, and reconciliation tests with zero
  network. It is the single most important test asset — **build it first**; it
  de-risks every later work package.
- **Unit**: serializer golden fixtures; redactor secret corpus (true and false
  positives); naming (collisions, Unicode NFC/NFD, case folding, Windows reserved
  names, length truncation); keyset paginator against simulated page sequences
  covering the insert/delete/update mid-sweep scenarios from §1.
- **Property tests**: serializer idempotence (`serialize ∘ parse ∘ serialize =
  serialize`); path-safety fuzzing of record names.
- **E2E invariant**: sync twice against an unchanged fake server → `git status
  --porcelain` is empty. This is byte stability as an executable test.
- **Live smoke**: opt-in via `SYNCRONA_MIRROR_SMOKE=1` + PDI credentials, tiny table
  subset, never in CI.

## 6. Operational model

- **Cadence**: incremental sync every 15–60 min; full reconciliation nightly or
  every N=10 syncs; `mirror verify` weekly; full sweeps off-hours.
- **CI surface**: the exit-code contract (§2 R1) is the integration point; `mirror
  status` (Aggregate-only, design §9.4) is the cheap scheduled drift probe —
  the same shape as Terraform's `plan -refresh-only` cadence (§8.4).
- **Recovery**: checkpoint resume for interrupted syncs. Catastrophic local
  corruption → delete the tree and run a full sweep: the instance is the source of
  truth and the mirror repo's git history is its own backup.
- **Multi-instance**: one branch per instance in one mirror repo (`mirror/dev`,
  `mirror/test`, `mirror/prod`). Because sys_ids are preserved by update-set /
  app-repo migration, cross-branch `git diff` is a meaningful environment-drift
  report for migrated artifacts. Caveat: legitimately instance-specific values
  (properties, connection records) always differ — maintain a small
  **expected-drift ignore list** in config, applied to the *diff report only*,
  never to the mirror itself.

## 7. Empirical probe (complete)

**Status 2026-08-17: complete.** The battery ran against
`ven01800.service-now.com` — a Nuvolo vendor instance with **1,002,700
`sys_metadata` rows**, i.e. the "1M+ scale extreme" of design §15.2 is not a
hypothetical, it is the instance we test against. 36 GET requests at ~3 req/s,
read-only. (History: the original target `dev408269` PDI was reclaimed after
inactivity and its credentials rejected; the probe aborted there after two
attempts for lockout safety. Its three salvaged measurements — JSON error
envelope, no rate-limit headers by default, tri-state reachability — are all
**re-confirmed** on ven01800.)

### 7.1 Measurements

| # | Question | Measured answer |
|---|---|---|
| M1 | Error envelope | `{"error":{"message","detail"},"status":"failure"}` on 400 and 401; `detail` can be `null`. Classify on the envelope, not the status code alone (D5). |
| M2 | Rate-limit headers | None on default responses (re-confirmed) — `Retry-After` honoring stays defensive (D6). |
| M3 | Aggregate API | Available: COUNT + MAX(`sys_updated_on`) in one call. **Counts arrive as strings** (`"1002700"`) — parse at the client boundary. |
| M4 | Instance scale | `sys_metadata` 1,002,700; `sys_db_object` 8,665; `sys_dictionary` 188,114; `sys_scope` **806**; `sys_choice` 22,400; `sys_attachment` 5,755. |
| M5 | T1 closure signal | 1,877 tables directly extend `sys_metadata` (full transitive closure is larger). Dynamic discovery is mandatory at this fan-out. |
| M6 | Keyset pagination | `sys_id>cursor^ORDERBYsys_id` verified: strictly increasing, zero overlap across pages. |
| M7 | Reference wire format | Default: `{link, value}` object per reference field. With `sysparm_exclude_reference_link=true`: plain value string. The fetch contract uses the latter. |
| M8 | Empty fields | Arrive as `""`, never absent — the drop-empties serializer rule operates on empty string. |
| M9 | Date format | `YYYY-MM-DD HH:MM:SS` (no timezone suffix; instance-UTC by platform convention). |
| M10 | `password2` wire behavior | **The API returns the ciphertext** — a 106-char string on `sys_update_set_source.password`. See finding P1. |
| M11 | `sys_choice` scope column | **Does not exist in the schema** (18 columns enumerated; no `sys_scope`, no `sys_package`). Design risk §15.5 resolved: choices land under `global` with a manifest note — there is nothing to attribute by. |
| M12 | Invalid query fields | Querying `sys_choice` by the nonexistent `sys_scope` matched **all 22,400 rows** — invalid query fields are silently dropped (`glide.invalid_query.returns_no_rows` unset). See finding P2. |
| M13 | Flow storage | Flow model is **normalized across `sys_hub_*` T1 tables** on this release; `sys_hub_flow_snapshot` owns only 3 dictionary rows yet returns 44 wire fields (inheritance) and carries caches (`label_cache` ~3.9 KB JSON-ish), not a monolithic model blob. See finding P3. |
| M14 | `internal_type` inventory | 168 distinct types; top: string 64,728; reference 30,364; glide_date_time 18,351; integer 14,331; boolean 13,790; GUID 8,539; collection 8,497; domain_id 2,939. SN_TYPE_MAP covers the long tail via the `raw` fallback. |
| M15 | Name lengths | `sys_metadata.sys_name` sample (n=994): p50 = 10 B, p95 = 50 B, p99 = 66 B, max = 92 B. `MAX_NAME_BYTES = 200` (D18) has >2× headroom over the observed maximum. |
| M16 | Attachments | 5,755 records; largest **76.8 MB**; 452 exceed the 256 KB LFS threshold. LFS-for-attachments is confirmed necessary on real data (D15/§9.4). |
| M17 | `sysparm_display_value=all` | Returns `{display_value, value, link}` per field — the derived-layer input shape is confirmed available. |
| M18 | Script fields | Large scripts (22 KB sampled) arrive LF-only — no CRLF normalization pass needed for API-sourced content. |

### 7.2 Findings that change the design (→ §10)

- **P1 — field-type deny is load-bearing (D19).** The design assumed password
  fields "return nothing usable" (design §6); measured reality is that
  `password2` returns the *encrypted ciphertext* over the Table API. Without the
  type-deny rule the mirror would commit secret material (ciphertext is still
  secret) to git on every sync. The redaction layer's field-type deny is
  therefore a correctness requirement, not defense in depth.
- **P2 — the planner must validate query fields (D20).** Invalid fields in
  `sysparm_query` are silently ignored and the query matches everything. A typo
  in a generated query turns a watermark-filtered incremental fetch into a
  full-table download, and — worse — makes a reconcile believe every row
  matched its filter. Every planner-generated query field must exist in the
  catalog's effective field set, or the sync aborts with an internal error.
- **P3 — the catalog must resolve inherited fields (D21).** A table's own
  `sys_dictionary` rows are a fraction of its wire fields
  (`sys_hub_flow_snapshot`: 3 own rows, 44 wire fields). The field catalog must
  union dictionary rows along the full `super_class` chain, or extraction,
  noise-suppression, and redaction silently miss most fields of derived tables.

The battery is re-runnable in ~4 minutes (36 GETs at ~3 req/s); the scripts live
in the session scratchpad (`ven-probe/probe*.mjs`) and read credentials from an
untracked local file.

## 8. Prior-art survey (complete)

Full source list at the end of this section. Findings are grouped by family; each
ends with what it means for this design.

### 8.1 ServiceNow native source control (Studio / app repo)

The unit of versioning is the *application*, never the instance; the repo content is
raw record-unload XML per file, checksum-guarded, explicitly "not meant to be edited
outside the instance"; there is no repo-side merge (pulls are stash → apply →
re-stash, with documented failure modes); global scope was excluded because branch
switching applies git state onto the **live** instance (pulling `instance_id` can
brick it), and the Paris "global app bundles" workaround requires manual claiming
with a conflict-resolution engine.

**Consequences.** (a) Instance-granularity versioning is genuinely unsolved by the
vendor — the mirror's "scope is a directory level, not a project root" (design §8.1)
is differentiated, not a reinvention. (b) "Faithful" and "reviewable" are proven to
be different requirements — hence the two-layer split of verbatim `record.json` +
extracted native files (design §7.1). (c) The entire global-scope failure class
exists only because their model writes git state back to a live instance;
a read-only mirror (design §12 Phase A) sidesteps it — the strongest argument for
keeping push-back out of the MVP. (d) Partitioning global config "by owning app" is
inherently ambiguous (claims model); partitioning by the row's own `sys_scope` is
the right call.

### 8.2 ServiceNow CI/CD ecosystem

The CICD REST API moves whole app versions (publish/install/rollback/scan) — the
correct Phase-4 vehicle, useless as a mirror transport. Update-set exporters (Git My
Stuff, bmoers/sn-cicd) prove update-set XML as a *transactional write vehicle*
(preview, collision detection, commit) and disprove it as a *storage format* (opaque
blob per changeset — backup and provenance, never reviewable state).
sn-scriptsync validates field-level extraction to native files as the ergonomic
core, and shares the gap every tool in this family has: **no accounting of what was
not synced**. The new ServiceNow SDK / Fluent keeps raw XML as canonical interchange
and remains scoped-app-only — the structural gap the mirror targets is still open in
2026. Commercial offerings (xtype, DevOps Change Velocity) prove enterprise demand
for cross-instance visibility but live inside the platform; git-native diff/review
workflows remain unserved.

**Consequences.** Table API + Attachment API stay the read plane; update-set XML is
generated on demand for push-back, never stored as state; the fidelity/coverage
layer (design §11) is the differentiator, not file extraction; commit metadata
(which tables, which scopes) should be structured from day one so mirror commits can
later feed change-management tooling.

### 8.3 Salesforce DX — the mature analog

The decade-validated pattern set: **two formats** (API-faithful metadata format vs
human-oriented decomposed source format, with lossless deterministic conversion);
**decomposition by child identity** (each field/rule/view its own file — "a new
field diffs as that field and nothing else"), retrofitted late and painfully for the
types that launched as monoliths; **noise suppression by omission** (source files
simply contain no audit fields; churn lives in the org-side `SourceMember` feed +
a local watermark); and the **profile disaster**: 50k-line XMLs whose retrieve
output *depends on what else was in the request* — the industry's canonical example
of context-dependent, non-deterministic export. Delta deployment (`sfdx-git-delta`)
became the CI standard *outside* the vendor, and works only because file paths map
deterministically to component identities.

**Consequences.** (a) The canonical/derived split (design §7.3/§8.3) is the
metadata-format/source-format pattern — keep conversion deterministic for anything
claimed round-trippable. (b) Per-row storage gives us child-identity decomposition
natively — an accidental structural advantage; any artifact class stored as a
monolith (flow snapshots) must carry an explicit `not-decomposed` coverage marker so
the debt is visible. (c) **Export output must be a pure function of instance
state, never of request shape** — per-row Table API fetches with explicit
`sysparm_fields` satisfy this; any future composite/export endpoint must be audited
for context sensitivity before adoption. (d) The ACL corpus (`sys_security_acl` +
role relations) is our profile analog: mirror it row-by-row like everything else,
and give it a *derived-layer matrix view* instead of ever serializing an aggregate.
(e) An incremental feed is an optimization over reconciliation, never truth —
Salesforce's tracking desyncs are a whole genre of CLI issues; our
`sys_updated_on` watermarks stay bounded by periodic full sweeps (design §9.1).

### 8.4 Adjacent analogs

**Terraform** separates desired config (reviewed, in git) from observed state (never
hand-edited), and drift detection is a cheap read-only scheduled operation with
remediation as an explicit human choice. Endorses the `.mirror/state/` vs
`instance/` split and the `mirror status` fast path; watermarks/checkpoints stay out
of the reviewable tree (shards are committed only because they double as the
deletion baseline).

**Argo CD** normalizes before diffing (strips server-generated fields), does
three-way diffs to distinguish drift from legitimate controller writes, and exposes
*user-configurable* ignore rules — whose misconfiguration is the #1 source of both
false alarms and silently missed real changes. Two ideas adopted: a per-table
`ignoreFields` knob in `mirror.config.js` (custom churn columns exist in the wild),
and the rule that **every active suppression is declared** — enumerated in
`coverage.json` so an invisible ignore rule cannot eat a real change.

**Sincronia** (the ancestor) confirms design §3.2: single-scope, script-field-centric
is a *design axis* of this tool family, not an implementation gap — which is why the
mirror is a new project type, not a v1 stretch.

### 8.5 Top transferable lessons (ranked)

1. Export output must be a pure function of instance state, never of request shape.
2. Suppress noise by omission at serialization time; make every suppression
   declared and user-extensible.
3. Read-only-first eliminates the failure class that kept ServiceNow's own source
   control out of global scope.
4. Decompose ordered/graph artifacts into child-identity files; monolith blobs
   forfeit git's merge machinery.
5. Keep observed state separate from the reviewable tree; drift detection is a
   cheap read-only scheduled command.
6. An incremental change feed is an optimization over reconciliation, never a
   replacement.
7. Keep a canonical machine layer and a generated human layer with deterministic
   conversion; the derived layer must never become an editable second source of
   truth.
8. Preserve a mechanical path ↔ sys_id ↔ table mapping so git diffs can be compiled
   into deployment artifacts (`diff two mirror commits → update-set XML`).
9. Write back through the platform's transactional import machinery
   (`sys_remote_update_set`, CICD API) — never raw row writes for graphs.
10. Completeness accounting is the differentiator no existing tool has.

**Sources** (fetched 2026-08-17): ServiceNow community — Studio source-control
walkthrough, Studio repo structure thread, Paris global-app source control, global
scope discussion, no-merge thread, stash-handling threads, update-sets guide, Git My
Stuff; GitHub — sncicd_githubworkflow, bmoers/sn-cicd, arnoudkooi/sn-scriptsync,
nuvolo/sincronia, scolladon/sfdx-git-delta, mcarvin8/sf-decomposer, ServiceNow/sdk;
Salesforce — SFDX dev guide (source format, decomposed types, source tracking),
developer blog (source-tracking deep dive, delta deployments), Gearset/Copado format
comparisons, Salto metadata-retrieval guide; HashiCorp — refresh-only tutorial;
Spacelift drift guide; Argo CD diffing docs and diff-engine internals; xtype;
ServiceNow Store — DevOps Change Velocity.

## 9. Git-at-scale benchmark (complete)

Local empirical spike, 2026-08-17: synthetic mirror trees per design §8 (8 scopes,
120 tables, Zipf skew, realistic ~1.0–1.6 KB `record.json` + ~3.2 KB avg `script.js`,
seeded PRNG), at two tiers. Environment: macOS/APFS (case-insensitive), git 2.50.1,
Node 22.

### 9.1 Measurements

| Measurement | T1 — 20k records / 40k files / 183 MB | T2 — 100k records / 200k files / 912 MB |
|---|---|---|
| Tree generation | 2.9 s | 14.0 s |
| `git add -A` / initial commit | 19.6 s / 8.1 s | 116.7 s / 51.8 s |
| Loose `.git` after import → after gc | 249 MB → 32 MB | 1.23 GB → 158 MB (gc 125 s) |
| `git status` (cold / warm) | 0.57 / 0.53 s | 2.67 / 2.34 s |
| Incremental sync commit (1% mod, 0.2% del, 0.5% add) | ~1.5 s total; +7.4 MB loose | ~9.4 s total; +40 MB loose |
| Same sync, packed growth after repack | — | **~0.7 MB** (120.4 → 121.1 MB pack) |
| Per-file `git log` | 0.01 s | 0.01 s |
| `gc --aggressive` vs plain gc | 9.5 s | 52 s wall / 388 s CPU; saves ~0.7 MB over plain — **not worth 6.5× CPU** |
| Monolithic manifest vs per-table shards, diff | same review volume, both fast | same; mono file is 36.3 MB at 100k |
| Same-shard merge, two branches, different keys | **clean ort auto-merge**, even adjacent entries | clean, 2.39 s |

Headlines: packed-repo : working-tree ratio is a stable **~1 : 7.6** at both tiers;
after repack, a full incremental sync commit deltas away almost completely. The
cost center is **interim loose-object growth**, i.e. a *maintenance-scheduling*
problem, not a storage problem.

### 9.2 macOS/APFS quirks (measured)

- **Unicode**: APFS is normalization-insensitive; Apple Git defaults
  `core.precomposeunicode=true` and stores NFC. The hazard is macOS↔Linux tree
  exchange → **normalize record names to NFC at serialization time**.
- **Name length**: APFS caps a path component at 255 *characters*; ext4 at 255
  *bytes*. A >127-char Cyrillic name works on macOS and fails checkout on Linux
  CI → enforce a **byte-length cap (~200 UTF-8 bytes)**.
- **Case-only collisions**: git commits `CaseDir/` + `casedir/`; APFS checkout
  silently collapses them — last writer wins and `git status` reports a
  **permanent phantom modification**, with no warning outside fresh clones. This
  is a real ServiceNow scenario ("Set Priority" / "set priority") → the
  case-insensitive uniqueness check with sys_id-suffix fallback is mandatory, not
  defensive.

### 9.3 Analytical (industry thresholds)

Vanilla git is comfortable into the low hundreds of thousands of files;
FSMonitor/untracked-cache from ~100k files, sparse-checkout + partial clone
(`--filter=blob:none`) for multi-hundred-MB checkouts, Scalar-class tooling from
~500k–1M files. LFS below ~1 MB/file is a **loss** for text (forfeits delta
compression exactly where it wins — see the 0.7 MB sync delta); it is for binaries
only. GitHub: 50 MB blob warning / **100 MB hard limit** — the monolithic manifest
crosses these at ~140k / ~275k records, a full-instance non-starter on its own.

### 9.4 Design impact (binding)

1. **Sharded manifests confirmed; no monolithic manifest file, ever.** Merge and
   diff behavior were a wash (both clean), so the rationale is the O(instance)
   rewrite per sync, the GitHub blob wall, and diff locality. Keep shard entries
   pretty-printed one-field-per-line — that is what makes same-shard merges clean.
2. **Sub-shard large tables**: hex-prefix fan-out once a table exceeds ~16k
   records; a 1M-row table at one file would extrapolate to ~70 MB.
3. **Explicit maintenance, plain gc**: `mirror init` provisions
   `git maintenance start`; the baseline sweep ends with a full repack;
   `--aggressive` is rejected (6.5× CPU for ~nothing).
4. **`mirror init` git config**: `feature.manyFiles=true`, `core.fsmonitor=true`,
   `core.precomposeunicode=true`, `.gitattributes` with `* text=auto eol=lf`,
   `_derived/** linguist-generated`, LFS patterns only under attachment paths.
5. **Record naming gets three guards** (tightens design §7.4): NFC normalization,
   ≤200-UTF-8-byte cap, case-insensitive per-directory uniqueness with sys_id
   suffix.
6. **1M-record instances fit one repo**: bot writer is fine (add ~10–20 min for
   the one-time baseline); human consumers use partial clone + cone-mode sparse
   checkout — which the `instance/<scope>/<table>/` hierarchy already makes
   natural. Repo splitting not required; one repo, one lock, one checkpoint.

## 10. Consolidated design deltas

Adjustments these analyses force on top of the design document — the architecture
document treats them as binding:

| # | Delta | Source |
|---|---|---|
| D1 | `mirror sync --verify-quiescent`: Aggregate pre/post check, coverage flag, commit trailer `Mirror-Consistency: quiescent` | §1 |
| D2 | Canonical layer tolerates dangling graph references; reported in coverage, never repaired | §1 |
| D3 | Exit-code contract 0/1/2 and failure taxonomy F1–F9 are normative | §2 |
| D4 | Tri-state reachability diagnosis (auth / down / hibernating) is first-class in the transport client | §7 |
| D5 | Error classification reads the JSON error envelope, not only the HTTP status | §7 |
| D6 | `Retry-After` honoring is defensive — the header is usually absent | §7 |
| D7 | Per-table `ignoreFields` in `mirror.config.js`; **all** active suppressions (built-in + user) enumerated in `coverage.json` | §8.4 |
| D8 | Monolithic blob classes carry an explicit `not-decomposed` coverage marker | §8.3 |
| D9 | ACL corpus gets a derived-layer matrix view; canonical stays row-by-row | §8.3 |
| D10 | Structured commit metadata (tables/scopes touched) from the first sync commit | §8.2 |
| D11 | `formatVersion` + `mirror migrate`; byte change ⇒ version bump; golden-fixture CI gate | §4 |
| D12 | FakeInstanceServer is the first implementation work package | §5 |
| D13 | Expected-drift ignore list applies to the cross-instance diff report only, never to the mirror | §6 |
| D14 | Transport must audit any future composite/export endpoint for request-shape-dependent output before adopting it | §8.3 |
| D15 | No monolithic manifest file exists in any form; shard entries are pretty-printed one-field-per-line | §9.4 |
| D16 | Hex-prefix shard fan-out for tables above ~16k records; fan-out choice is sticky per table (changed only via `mirror migrate`) | §9.4 |
| D17 | `mirror init` provisions git config (`feature.manyFiles`, `core.fsmonitor`, `core.precomposeunicode`, `.gitattributes`) and `git maintenance start`; baseline sweep ends with a full repack; `gc --aggressive` banned | §9.4 |
| D18 | Record naming: NFC normalization + ≤200-UTF-8-byte cap + case-insensitive per-directory uniqueness with sys_id suffix | §9.2 |
| D19 | Field-type deny (`password`/`password2`) is a correctness requirement — the Table API returns ciphertext for such fields, which must never reach git | §7.2 P1 |
| D20 | Every planner-generated `sysparm_query` field must exist in the catalog's effective field set before the request is issued — invalid fields silently match all rows | §7.2 P2 |
| D21 | The field catalog must union `sys_dictionary` rows along the full `super_class` chain — a table's own rows cover only a fraction of its wire fields | §7.2 P3 |
