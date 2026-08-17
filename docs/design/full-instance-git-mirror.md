# Full-Instance Git Mirror — Design

Status: **Draft for review** — 2026-08-12
Scope: deep analysis of the ServiceNow metadata problem and a design for mirroring an
**entire instance** (not one scoped app) into a git-committable tree, as a major
extension over syncrona v1.

---

## Table of contents

1. [Problem statement](#1-problem-statement)
2. [Goals and non-goals](#2-goals-and-non-goals)
3. [What v1 actually does today (measured baseline)](#3-what-v1-actually-does-today)
4. [The metadata universe — what "an entire instance" is](#4-the-metadata-universe)
5. [What can and cannot be exported](#5-what-can-and-cannot-be-exported)
6. [Export mechanisms — API-by-API analysis](#6-export-mechanisms)
7. [Git-stable serialization](#7-git-stable-serialization)
8. [Storage layout](#8-storage-layout)
9. [Sync model: full, incremental, deletions](#9-sync-model)
10. [Secrets and redaction](#10-secrets-and-redaction)
11. [Fidelity accounting — coverage as a first-class output](#11-fidelity-accounting)
12. [Push-back (write) semantics](#12-push-back-semantics)
13. [Integration with the v1 codebase](#13-integration-with-the-v1-codebase)
14. [Phased delivery plan](#14-phased-delivery-plan)
15. [Risks and open questions](#15-risks-and-open-questions)

---

## 1. Problem statement

ServiceNow "code" is not files — it is **rows**. Mirroring an instance into git means
resolving three impedance mismatches that v1 only solved for a narrow slice:

1. **Identity.** Records are keyed by `sys_id`; git is keyed by path. A mirror needs a
   deterministic, rename-tolerant mapping between the two.
2. **Shape.** One record mixes code fields (`script`), configuration fields
   (`when`, `order`, `condition`), reference fields (opaque sys_ids), and audit noise
   (`sys_updated_on`, `sys_mod_count`). Serialized naively, every sync produces
   meaningless diffs and every reference is unreadable.
3. **Graph.** Many artifacts are **multi-record ordered graphs**: a form layout is
   `sys_ui_form` + `sys_ui_section` + `sys_ui_element` rows whose meaning lives in
   relations and `order` columns; a legacy workflow is a `wf_workflow_version` graph;
   a Flow Designer flow is one giant JSON snapshot blob. Row-by-row storage without
   ordering discipline makes their diffs unreviewable.

v1 solves identity and (partially) shape for **code fields of one scoped app at a
time**. A full-instance mirror must solve all three, at a scale of thousands of
tables and 10⁵–10⁶ rows, without lying about completeness.

## 2. Goals and non-goals

**Goals**

- G1. Mirror **all recoverable configuration** of an instance — every scope
  including `global` — into a tree that commits cleanly to git.
- G2. **Byte-stable output**: re-running the mirror against an unchanged instance
  produces zero diff.
- G3. **Reviewable diffs**: script fields as native files; ordered, sorted, noise-free
  JSON for everything else.
- G4. **Honest coverage**: everything skipped (ACL, encryption, protection policy,
  redaction) is reported, machine-readably, in the tree itself.
- G5. **Secrets never land in git** — deny by default, fail closed.
- G6. Incremental sync cheap enough to run on a schedule (CI cron).
- G7. Reuse v1's transport policy, auth, serialization precedents, and quality gates.

**Non-goals (for this design)**

- N1. Full write-back of arbitrary artifacts (phased; graph artifacts go through
  update-set XML, never raw row PATCH — see §12).
- N2. Runtime/operational data (logs, events, stats, ECC queue, email logs).
- N3. Decrypting what the platform will not give us (password2, Column/Edge
  encryption, protected vendor apps) — see §5.3.
- N4. Replacing v1's per-scope developer workflow. The mirror is a **new project
  type** living alongside it.

## 3. What v1 actually does today

Measured baseline from the current code (all references verified 2026-08-12).

### 3.1 What works and is reusable

- **Transport policy** (`packages/sn-transport`): 20 rps cap, retryable statuses
  `[408, 425, 429, 500, 502, 503, 504]`, `escapeQueryValue`, TLS/mTLS/proxy policy,
  full auth matrix (Basic, OAuth password/client-credentials/JWT-bearer, API key).
- **Stable paging discipline**: `withStableOrder` appends `^ORDERBYsys_id` to every
  query (`packages/core/src/manifestBuilder.ts:122-132`) — the prerequisite for any
  pagination correctness.
- **Dictionary-driven file extraction**: any column whose `internal_type` is in
  `SN_TYPE_MAP` (`packages/core/src/fieldMap.ts:3-12`: css, html, html_script,
  html_template, script, script_plain, script_server, xml) becomes a native file;
  discovery walks the table hierarchy to depth 10 via `super_class`
  (`manifestBuilder.ts:389-416`).
- **Churn-free sidecar serialization**: `serializeMetaFields`
  (`packages/core/src/metaFields.ts:168-184`) — sorted keys, empty values dropped,
  reference objects unwrapped. This is the seed of §7.
- **Path hardening**: `assertSafePathComponent` (`downloadPipeline.ts:128-161`),
  containment guards (`FileUtils.ts:191-219`, `:299-330`), canonical-name folding
  for case/Unicode/Windows quirks (`repairCommand.ts:76-77`).
- **Resume machinery**: download checkpoint keyed on a fingerprint of the missing
  set (`downloadPipeline.ts:676-695`, `downloadCheckpoint.ts`).
- **Secret detection**: `isSensitiveAuditKey` (22 key regexes) and
  `looksLikeSecretValue` (JWT/PEM/AWS/Stripe/GitHub/Slack/64-hex heuristics) with a
  fail-closed scan budget (`packages/mcp-server/src/audit.ts:406`, `:492`).
- **`.meta.json` field-eligibility policy**: `sys_*` prefix rejection, 17-entry
  denylist, `password`/`password2` and journal/image types excluded
  (`metaFields.ts:69-111`).

### 3.2 The five architectural constraints (why v1 cannot be stretched)

1. **The manifest is single-scope by type.**
   `AppManifest { tables; scope: string }` (`packages/types/index.d.ts:182`), one
   `sync.manifest.json` per project root (`config.ts:421`), singleton
   `ConfigManager`, and every push resolves `const { tables, scope } = manifest`
   (`FileUtils.ts:443`). Instance-wide means N manifests plus an index, or a
   breaking schema change touching every consumer.
2. **Every discovery query is anchored to one `sys_scope`, and global is
   unreachable.** `sys_scope=<scopeId>` at `manifestBuilder.ts:265,313,337,830,986`;
   `getScopeId` hard-throws when the scope has no `sys_app` row
   (`manifestBuilder.ts:202`, `:1030-1035`); auto-provisioning filters
   `scope.startsWith("x_")` (`commands.ts:84`). The bulk of a real instance —
   business rules on `incident`, UI actions on `task`, ACLs, properties — lives in
   `global` and has **no code path at all**.
3. **Only 8 `internal_type`s become files; everything else is lossy or invisible.**
   Non-script columns flatten into `.meta.json` strings; references arrive as
   `{value, link}` objects because `tableAPIGet` never sets
   `sysparm_exclude_reference_link` (`snClient.ts:334-352`); the sidecar is
   explicitly download-only (`FileUtils.ts:436-438`). ~90 % of an instance is
   non-script data.
4. **Multi-scope init is N serial single-scope runs sharing mutable globals.**
   `initAllScopesFromEnv` does `process.chdir` + singleton reset per scope
   (`commands.ts:66-203`) — non-reentrant, no instance-level lock, checkpoint, or
   manifest.
5. **Prune safety assumes a complete manifest.** `repair --prune` deletes anything
   the manifest doesn't claim (`repairCommand.ts:138-172`, auto-confirmed under
   `--ci` at `:262-263`), while the pull path silently skips tables on 400/403/404
   (`manifestBuilder.ts:102-105`). At instance scale, ACL-variable visibility
   guarantees under-claiming; "not in manifest" must be decoupled from "delete it".

### 3.3 Transport gaps (13, measured)

No attachment/binary support (both HTTP clients are text-only — the MCP client
literally does `await response.text()`); no Aggregate API; offset-only paging;
no Batch API; `Retry-After` ignored (parsed only in the Jira client); no
delta/incremental sync (no `sys_updated_on` watermark anywhere in the pull path);
export XML limited to `export_update_set.do`; ACLs and dictionary excluded by
default (`defaultOptions.ts`); one hierarchy HTTP call per ancestor with no
cross-table cache; write side allowlist-policed; the only server-side escape hatch
is `runBackgroundScript` returning unparsed HTML.

## 4. The metadata universe

### 4.1 Tier model

An instance decomposes into five tiers with different mirroring answers:

| Tier | What | Mirror policy |
|---|---|---|
| T1 | **`sys_metadata` descendants** — the true "application files": scripts, ACLs, UI, flows, catalog, dictionary, atf, … Hundreds of classes. | Mirror fully. Discovered **dynamically**, never hardcoded (§4.2). |
| T2 | **Config tables outside `sys_metadata`** — `sys_choice`, `sys_properties`, scheduled-job runtime (`sys_trigger`), number counters (`sys_number_counter`), … | Curated list, mirrored with per-table policy (some read-only, some redacted). |
| T3 | **Foundational reference data** — users, groups, role assignments, companies, locations. | Off by default; opt-in table list (it is data, not configuration, and often PII). |
| T4 | **Runtime/operational** — logs, events, stats, ECC queue, email, rollback contexts. | Never mirrored (non-goal N2). |
| T5 | **Binaries** — `sys_attachment` (+ chunked `sys_attachment_doc`), `db_image`, certificates. | Attachment API + optional Git LFS (§8.4). |

### 4.2 Dynamic discovery, not a hardcoded table list

The single most important design decision: **compute the T1 class list from the
instance itself**. Walk `sys_db_object`, resolve each table's `super_class` chain,
and take every table whose chain reaches `sys_metadata`. This:

- automatically covers plugin/store tables we have never heard of;
- self-heals across ServiceNow releases;
- reuses the exact hierarchy-walk logic v1 already has
  (`getTableHierarchyTableNames`, `manifestBuilder.ts:619`), inverted (descendants
  of `sys_metadata` instead of ancestors of X) and cached instance-wide (one pass,
  not per-table).

Every `sys_metadata` row carries the columns that make instance-wide organization
possible: `sys_scope`, `sys_package`, `sys_policy` (protection), `sys_update_name`,
`sys_class_name`. Scope enumeration must come from **`sys_scope`** (which includes
`global` and store apps), not `sys_app` filtered to `x_*` + `active=true`.

The T2 curated list is small and explicit (initial set): `sys_choice`,
`sys_properties`, `sys_number_counter` (report-only), `v_plugin` (read-only
inventory snapshot). Each entry declares: identity key, noise fields, redaction
policy, and whether it participates in push-back (none do, initially).

### 4.3 The hard serialization classes

These are the artifacts where naive row storage fails review (mismatch #3):

- **Flow Designer** (`sys_hub_flow`, `sys_hub_action_type_definition`,
  `sys_hub_flow_logic`, snapshots): the real definition is a large JSON blob
  (latest snapshot). Mirror: pretty-print with sorted keys into
  `flow.snapshot.json`. Read-only forever via Table API; round-trip only through
  update-set/app-repo import.
- **Legacy workflows** (`wf_workflow` → published `wf_workflow_version` →
  `wf_activity` + `wf_transition`): a graph. Canonical layer stores each row
  normally; a **derived view** (§8.3) renders one ordered document per published
  version for reviewability.
- **Forms and lists** (`sys_ui_form`, `sys_ui_form_section`, `sys_ui_section`,
  `sys_ui_element`, `sys_ui_list`, `sys_ui_list_element`): order-dependent
  children. Canonical per-record storage plus a derived per-view document ordered
  by (`position`/`order`, `sys_id`).
- **UI Builder / Workspace** (`sys_ux_*` macroponents): JSON composition fields —
  same treatment as flows (pretty-printed extracted JSON).
- **Service catalog** (`sc_cat_item`, `item_option_new`, variable sets,
  `catalog_ui_policy`): multi-table cluster; canonical per-record, derived
  per-item view.
- **Notifications** (`sysevent_email_action`, `sys_email_layout`,
  `email_template`): HTML bodies extracted as `.html` files (already covered by
  `SN_TYPE_MAP`'s html types once the tables are in reach).

The invariant: **the canonical layer is always mechanical per-record storage**
(complete, diffable, syncable, prunable), and human-friendly aggregations are a
**derived, regenerable layer** clearly marked as such. Never make the canonical
layer depend on cross-record assembly — that is what breaks deletion detection
and incremental sync.

## 5. What can and cannot be exported

### 5.1 Exportable faithfully

- All T1/T2 rows visible to the mirror user's ACLs, as raw string values.
- Script/HTML/CSS/XML field bodies, byte-exact.
- Attachments, byte-exact, via the Attachment API.
- Schema itself: `sys_db_object`, `sys_dictionary`, `sys_documentation` (labels),
  `sys_choice` — i.e. the mirror can capture **both the definitions and the
  dictionary that explains them**, which v1 explicitly excludes today
  (`defaultOptions.ts` denylist).

### 5.2 Exportable with caveats

- **Reference fields** — raw `sys_id` values are faithful but unreadable; §7.3.
- **Order-dependent graphs** — faithful per-row, reviewable only via derived views.
- **`sys_trigger`** (scheduled jobs) mixes definition and runtime state
  (`next_action`); noise-field stripping must cover the runtime columns.
- **Currency/price/date-time fields** — locale/TZ sensitive; mirror always reads
  raw values (`sysparm_display_value=false`) so they are stable.

### 5.3 Not exportable (be honest, report, move on)

- **`password`/`password2` fields** — the API returns nothing usable (and we would
  refuse to store it anyway; §10). Already the v1 sidecar policy.
- **Column/Edge-encrypted fields** — ciphertext or denial, depending on config.
- **Protected vendor/store apps** (`sys_policy=protected`) — script bodies are
  withheld or encrypted. The mirror records the row's existence + protection flag.
- **maint-ACL tables** — invisible to any customer credential.
- **Anything not in tables** — node/glide.properties file config, instance
  infrastructure. Out of reach by design.

Every one of these lands in the coverage report (§11), never silently.

## 6. Export mechanisms

| Mechanism | Use in mirror | Notes |
|---|---|---|
| **Table API** | The workhorse for all row data. | Must add: **keyset pagination** (`sys_id><last>^ORDERBYsys_id` — O(1) per page vs offset's O(n) server cost, immune to insert/delete drift mid-sweep); `sysparm_exclude_reference_link=true` (halves payload, kills `link` noise); `sysparm_suppress_pagination_header=true` (skips the server-side COUNT per page); `sysparm_fields` always explicit. Raw values only (`display_value=false`) for the canonical layer. |
| **Aggregate API** (`/api/now/stats`) | Planning + verification: per-table `COUNT`, `MAX(sys_updated_on)` for cheap drift detection before any row fetch. | Missing entirely in v1 (gap #2). Row counts also drive the progress UI and the reconciliation scheduler. |
| **Attachment API** (`/api/now/attachment`) | Binary download of `sys_attachment` content. | Requires the first binary-capable code path in the transport (both clients are text-only today). Metadata row + `/file` stream. |
| **Batch API** (`/api/now/v1/batch`) | Optional optimization: multiplex many small requests (dictionary walks, per-record fetches). | Phase 3+; not required for correctness. |
| **Export XML / unload** | Fallback fidelity check; source format for **push-back** of graph artifacts (generate `sys_remote_update_set` XML; §12). | v1 already emits update-set XML in the MCP exports directory. |
| **CI/CD API** | Whole-app install/publish; relevant to push-back of scoped apps, not to mirroring. | Out of scope until Phase 4. |
| **`sys_audit_delete`** | Incremental deletion feed (§9.3). | Retention is instance-configurable — treat as an optimization over, never a replacement for, full reconciliation. |
| **Background script** | **Explicitly banned** in the mirror path. | Unauditable, HTML-scraped, admin-only. The mirror must work with a read-only user. |

Transport upgrades this implies (closing gaps from §3.3): binary response support,
keyset pagination helper in `sn-transport` (next to `withStableOrder`),
`Retry-After` honoring in the shared retry policy, Aggregate client, and an
instance-wide hierarchy cache.

## 7. Git-stable serialization

The contract: **same instance state ⇒ byte-identical tree** (goal G2).

### 7.1 Record envelope — `record.json`

- UTF-8, LF, trailing newline, 2-space indent, keys sorted bytewise.
- Values stored **verbatim as the API's raw strings** — no type coercion, no
  locale formatting.
- **Empty fields dropped** (v1 precedent — churn-free and shrinks the tree).
- **Noise fields excluded**: `sys_updated_on`, `sys_updated_by`, `sys_mod_count`
  never enter `record.json` (they live in the manifest shard as the watermark).
  Immutable provenance (`sys_created_on`, `sys_created_by`, `sys_id`,
  `sys_class_name`, `sys_scope`, `sys_package`, `sys_policy`) stays.
- **Extracted fields omitted**: any column whose `internal_type` ∈ `SN_TYPE_MAP`
  (plus per-table JSON-blob overrides like flow snapshots) is written as a
  sibling native file (`script.js`, `template.html`, `flow.snapshot.json`) and
  does not appear in `record.json`. Exactly the v1 `NON_META_INTERNAL_TYPES`
  discipline (`metaFields.ts:101-111`), generalized.
- Script files byte-exact except: normalize to LF via `.gitattributes`
  (`* text=auto eol=lf` scoped to the mirror tree), preserve everything else.

### 7.2 JSON-blob fields

Fields that hold JSON-as-string (flow snapshots, `sys_ux_*` compositions, ATF
inputs) are parsed and re-serialized canonically (sorted keys, stable indent) into
their own `.json` file. If parsing fails, store verbatim with a `raw:` marker in
the manifest shard — never guess.

### 7.3 References: readable without churn

Canonical layer stores the raw `sys_id`. Display names go **only** into the
derived layer (§8.3): a generated, clearly-marked `_derived/` tree that may churn
when referenced records rename — canonical diffs stay clean. This is the only
resolution that satisfies both "reviewable" and "byte-stable": inlining display
values into `record.json` would make every rename of a referenced record dirty
thousands of unrelated files.

### 7.4 Record naming

Same algorithm as v1 (`buildRecordName`, `manifestBuilder.ts:713-756`): display
field (per-table map + config override) → `sys_id` fallback; differentiator
suffixes; `/` → `〳`; collisions get `_<sys_id>`. Deterministic for a given record
set; renames are cheap in git (rename detection works because content moves
intact). Canonical-name folding from `repairCommand.ts:76-77` applies for
cross-platform safety.

## 8. Storage layout

### 8.1 Tree

```
<mirror-repo>/
  mirror.config.js                  # mirror project config (see §13.2)
  .gitattributes                    # eol=lf, LFS patterns, linguist-generated
  MIRROR-REPORT.md                  # human coverage report — committed (§11)
  .mirror/                          # non-instance state, mostly committed
    manifest/
      <table>.json                  # sharded per-table manifest (§8.2)
    state/
      watermarks.json               # per-table sys_updated_on + last reconcile
      coverage.json                 # machine-readable coverage (§11)
    checkpoint.json                 # resume state — gitignored
  instance/
    global/
      sys_script/
        Set Priority^incident/
          record.json
          script.js
          condition.js
      sys_security_acl/...
      sys_properties/...            # T2, redaction-gated
    x_acme_cs/
      sys_script_include/AcmeUtils/{record.json,script.js}
      sp_widget/acme-ticket-list/{record.json,template.html,css.css,...}
    sn_hr_core/                     # store scopes mirror too (rows visible to ACLs)
  attachments/
    <table>/<record-sys_id>/<attachment-sys_id>_<filename>   # LFS above threshold
  _derived/                         # regenerated views — reviewable, churn allowed
    forms/<table>/<view>.md
    workflows/<name>@<version>.md
    refs/<scope>.md                 # sys_id → display-name indexes
```

Scope is a **directory level**, not a project root — one repo, one config, one
lock, one checkpoint for the whole instance (resolving constraint #4). `src/`
naming is deliberately avoided: a mirror is not a push workspace.

### 8.2 Sharded manifests

One manifest per **table**, not one giant JSON (a 500k-record instance in a single
`sync.manifest.json` is a merge-conflict magnet and an O(instance) rewrite per
sync). Shard schema:

```json
{
  "table": "sys_script",
  "scopePartitioned": true,
  "completeness": { "status": "complete|partial", "skippedReason": null },
  "records": {
    "<sys_id>": {
      "path": "instance/global/sys_script/Set Priority^incident",
      "updated_on": "2026-08-11 14:03:22",
      "files": ["record.json", "script.js", "condition.js"],
      "hash": "sha256:..."
    }
  }
}
```

`sys_id` is the manifest key (identity truth); the path is derived. This inverts
v1's name-keyed `TableConfigRecords` and removes the rename ambiguity class.
Shards are committed: they are the deletion baseline and the drift index.

### 8.3 Derived layer

Everything under `_derived/` is regenerated on every sync from the canonical
layer, committed for reviewability, and excluded from fidelity claims. Marked
`linguist-generated` in `.gitattributes` so PR diffs collapse it by default.

### 8.4 Attachments and LFS

Attachment binaries go under `attachments/`, named
`<attachment-sys_id>_<sanitized-filename>` (sys_id prefix guarantees uniqueness
and stable identity across renames). Recommend Git LFS for files above a
configurable threshold (default 256 KB) via generated `.gitattributes` patterns;
plain git below it. Attachment **metadata** rows mirror normally under T1 rules.

## 9. Sync model

### 9.1 Full sweep (baseline + periodic reconciliation)

Per table, keyset-paginate `sys_id`-ordered pages (`sysparm_fields` = needed
columns), write records, rebuild the shard. Aggregate `COUNT` first for progress
and for the completeness check (rows fetched vs rows counted ⇒ ACL-invisible rows
become a *measured* number, not a surprise). Table-level concurrency as in v1
(default 20); instance-level checkpoint keyed per table so a killed run resumes.

Rough envelope: at v1's 20 rps cap and 500-row pages, row data for a 500k-row
instance is ~10–20 minutes of API time; attachments dominate wall-clock on
media-heavy instances.

### 9.2 Incremental sync

Per table: fetch `sys_updated_on > watermark` (keyset-ordered within the filter),
upsert records, advance the watermark only after the page set completes. Clock
skew guard: overlap the watermark by a configurable window (default 5 min) —
upserts are idempotent so overlap is free.

### 9.3 Deletions

Two mechanisms, deliberately redundant:

- **Incremental**: consume `sys_audit_delete` (filtered to mirrored tables,
  `sys_created_on > last sync`) and tombstone matching sys_ids. Best-effort —
  retention is instance-configurable.
- **Authoritative**: periodic full reconciliation — keyset sweep of
  `sysparm_fields=sys_id` per table (cheap: ~40 bytes/row), diff against the
  shard, delete what the instance no longer has.

**Prune is gated on completeness** (resolving constraint #5): a table whose shard
says `partial` (skipped via 400/403/404, count mismatch, redaction failure) is
**never** pruned, and the skip reason is carried in the shard and the coverage
report. "Not in manifest" alone never deletes anything.

### 9.4 Drift detection (`mirror status`)

Cheap first pass: Aggregate `MAX(sys_updated_on)` + `COUNT` per table vs the
shard — one request per table, no row data. Tables that moved get listed; `--deep`
re-fetches and hash-compares. This is the everyday "has anyone touched prod?"
command and the CI cron's fast path.

## 10. Secrets and redaction

Deny by default, fail closed (goal G5):

1. **Field-type denial**: `password`, `password2` internal types never serialize —
   already v1 sidecar policy (`metaFields.ts:101-111`), extended to *all* mirror
   output including extracted files.
2. **Key-pattern denial**: field names matching the `isSensitiveAuditKey` regex
   set (22 patterns, `audit.ts:406`) are redacted regardless of type.
3. **Value scanning**: every serialized body (record.json values, script files,
   property values) runs through `looksLikeSecretValue` (`audit.ts:492`). Hits are
   replaced with `__SYNCRONA_REDACTED__<sha256-12>` (the hash prefix makes
   *changes* to a redacted secret still visible in diffs without revealing it)
   and logged to the coverage report. The scanner's fail-closed budget discipline
   (`SECRET_SCAN_BUDGET`, redact-on-overflow) carries over.
4. **`sys_properties` special handling**: property names matching the sensitive
   key patterns are value-redacted by default; a per-property allowlist in
   `mirror.config.js` opts specific properties back in.
5. **Repo-level backstop**: the mirror repo gets the same gitleaks gate as this
   repo (`scripts/scan-secrets.mjs` precedent). Note: gitleaks does not honor
   `.gitignore`, so the redaction must be correct *before* commit — the gate is a
   tripwire, not the mechanism.

Prerequisite refactor: lift the scanner out of `packages/mcp-server/src/audit.ts`
into a shared package (`@syncrona/redaction`) consumable by core, mcp-server, and
the mirror (§13.3).

## 11. Fidelity accounting

Coverage is a first-class, committed output — the mirror must never imply it got
everything when it did not.

`.mirror/state/coverage.json` (machine) + `MIRROR-REPORT.md` (human) record, per
table: rows counted vs mirrored; skip reason (`acl-403`, `not-visible`,
`protected-app`, `encrypted-field`, `redacted`, `parse-failure`); field-level
redaction tallies; attachment bytes mirrored/skipped. The report is regenerated
every sync and committed, so **the git history of MIRROR-REPORT.md is itself the
audit trail of what the mirror could and could not see over time**.

This is also the enforcement point for constraint #5: prune eligibility is read
from coverage, not assumed.

## 12. Push-back semantics

The mirror is **read-only first**. Write-back arrives in explicitly bounded steps:

- **Phase A (MVP)**: none. The mirror is a baseline, a diff surface, and a
  disaster-recovery reference.
- **Phase B**: single-field restore for `SN_TYPE_MAP` fields — exactly v1's
  existing push path (`PATCH` of one field by sys_id, `pushPipeline.ts` +
  `snClient.ts:315-332`), pointed at a mirror record. Safe because it is the
  same operation developers already do.
- **Phase C**: whole-record create/update for **leaf tables** (no ordered
  children, no graph membership) via Table API, with a preflight diff and
  update-set capture on the instance side (v1's `scopeManagement.ts` update-set
  swap generalizes).
- **Phase D**: graph artifacts (forms, flows, workflows, catalog clusters) only
  via **generated update-set XML** loaded through `sys_remote_update_set` —
  preview, collision detection, commit, the platform's own transactional path.
  Never raw row PATCH: the platform maintains graph invariants (versioning,
  ordering, cache invalidation) only through its own import machinery.

This phasing means the dangerous surface (graph mutation) is deferred until the
mirror's fidelity accounting has proven itself in production use.

## 13. Integration with the v1 codebase

### 13.1 New command: `syncrona mirror`

Registered by appending to `CLI_COMMANDS` (`packages/core/src/cliCommands.ts:95`,
module type at `:38`, shared options at `:62`) — commander wiring untouched.
Subcommands: `mirror init` (scaffold repo + config + .gitattributes), `mirror
sync` (incremental; `--full` forces sweep), `mirror status` (drift; `--deep`),
`mirror verify` (counts + spot hashes), `mirror report` (regenerate coverage).
README + CLAUDE.md command tables update in the same change (docs-drift gate).

### 13.2 New package: `@syncrona/mirror`

The mirror does **not** reuse `AppManifest`/`ConfigManager` (constraint #1) — it
gets its own sharded manifest model and a `mirror.config.js` (own loader,
reusing `config.ts`'s validation patterns; the mirror repo is a distinct project
type, so overloading `sync.config.js` would entangle two lifecycles). Reused
as-is: `sn-transport` (policy, auth, retry), `fieldMap.ts` extension mapping,
`metaFields.ts` eligibility discipline, path-hardening utilities from
`FileUtils.ts`/`downloadPipeline.ts` (lifted into the shared package where they
currently sit in core).

Config sketch:

```js
module.exports = {
  scopes: "all",                 // or ["global", "x_acme_cs", ...]
  tiers: { referenceData: false },
  tables: { include: [], exclude: [], perTable: { sys_properties: { redact: "sensitive-keys" } } },
  attachments: { enabled: true, lfsThresholdBytes: 262144 },
  redaction: { propertyAllowlist: [] },
  derived: { forms: true, workflows: true, refs: true },
  reconcileEveryNSyncs: 10,
};
```

### 13.3 Transport and shared-code work (Phase 0)

- Binary GET support in the core client (axios `responseType: "arraybuffer"`) —
  first binary path in the codebase.
- Keyset pagination helper in `sn-transport` beside the existing policy helpers;
  `withStableOrder` remains for offset compatibility.
- `Retry-After` honoring in the shared retry policy (today: fixed-delay, header
  ignored).
- Aggregate API client (`/api/now/stats`).
- Extract `@syncrona/redaction` from `mcp-server/src/audit.ts` (public surface:
  `isSensitiveKey`, `looksLikeSecretValue`, `redactValue`), consumed by both
  existing users and the mirror.
- Instance-wide `sys_db_object` hierarchy cache (one sweep, memoized), replacing
  per-table ancestor walks.

### 13.4 What stays untouched

The entire v1 per-scope workflow — `init`/`download`/`push`/`repair`, the
manifest, the plugin system (push-side), the MCP server. The mirror is additive.
`processTablesInManifest` (`downloadPipeline.ts:189`) remains the single pull
seam for scope projects; the mirror has its own writer built on the shared
hardened path utilities.

## 14. Phased delivery plan

| Phase | Deliverable | Exit criterion |
|---|---|---|
| **0 — Transport** | Keyset paging, Retry-After, Aggregate client, binary GET, `@syncrona/redaction` extraction, hierarchy cache. | v1 test suite green; new helpers covered; no behavior change for existing commands. |
| **1 — MVP mirror** | `mirror init/sync/status`: all scopes **including global**, T1 code-bearing tables (superset of v1's reach), sharded manifests, canonical serialization, full-sweep + reconciliation deletions, coverage report, secrets gate. | Byte-stable re-run on an unchanged PDI; coverage report accounts for every discovered table; zero secrets in tree (gitleaks clean). |
| **2 — Full metadata** | Entire dynamic T1 universe (flows, forms/lists, catalog, ACLs, dictionary, atf, …), T2 curated tables, JSON-blob canonicalization, derived views, `mirror verify`. | A PDI's `sys_metadata` row count matches mirrored+skipped exactly; form/flow diffs human-reviewable. |
| **3 — Scale & cadence** | Attachments + LFS, incremental watermark sync, `sys_audit_delete` tombstones, Batch API optimization, CI cron recipe (GitHub Action). | Incremental sync of a quiet instance < 60 s; scheduled mirror runs unattended for a week. |
| **4 — Push-back** | Phases B → C → D of §12, in order, each behind its own confirmation gates and audit logging. | Update-set-XML round trip of a form layout previews and commits cleanly on a test instance. |

Phase 1 alone already delivers the headline capability — *the instance's code in
git, global scope included* — which is the largest single gap in v1.

## 15. Risks and open questions

1. **ACL variance**: two credentials produce two different mirrors. Mitigation:
   coverage accounting (§11) + a recommended dedicated read-only mirror user
   documented in SECURITY.md; the shard's completeness flag prevents destructive
   conclusions from a poorer view.
2. **Instance scale extremes**: 1M+ `sys_metadata` rows (heavy store footprints)
   stress the 20 rps cap. Keyset + Aggregate planning keeps it linear; Batch API
   is the pressure valve. Full sweeps are schedulable off-hours.
3. **`sys_audit_delete` retention** varies per instance — reconciliation cadence
   (`reconcileEveryNSyncs`) must default conservatively (every 10th sync).
4. **Table API blind spots**: a small set of fields serialize differently via XML
   unload vs JSON API. `mirror verify` spot-checks with XML export on sampled
   records; discrepancies get catalogued per-field in the coverage report.
5. **Choice-list scope attribution**: `sys_choice` scope tagging is inconsistent
   across releases — records without usable scope attribution land under
   `global` with a manifest note. Needs empirical validation on the dev PDI.
6. **Derived-layer churn** could dominate diffs on rename-heavy instances —
   mitigated by `linguist-generated`, and the layer is optional per config.
7. **Windows path limits**: instance mirrors nest deeper than scope projects;
   long display names + `MAX_PATH` need the existing reserved-name/canonical-name
   hardening plus a length-truncation rule (truncate display part, keep sys_id
   suffix) — deterministic by construction.
8. **Open**: should T3 reference data ever ship, given PII exposure? Current
   answer: keep it opt-in, redaction-gated, and off the roadmap until asked for.
