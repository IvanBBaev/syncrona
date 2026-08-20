# Record Metadata Layer (`.meta.json`)

How a ServiceNow record's non-code columns get into the working tree, what
happens to them there, and how they get back. This is the design document for
the feature the README summarises under
[Record metadata](../../README.md#record-metadata-metajson); where the README
tells you what to type, this tells you why each rule is the way it is and what
breaks if it changes.

Status: shipped. Every measurement quoted below was taken against a live
ServiceNow instance (a 5-table vendor scope, 17 records); the commands are in
[§9](#9-live-verification).

---

## 1. The problem

A tracked record used to be a set of *file fields*. `manifestBuilder` asks the
dictionary which of a table's columns have an internal type in `SN_TYPE_MAP`
(`css`, `html`, `html_script`, `html_template`, `script`, `script_plain`,
`script_server`, `xml`) and writes one file per such column. Everything else the
record carries was never selected, never downloaded, and never written.

For `sys_script_include` that means the workspace held `script.js` and nothing
else. Not `access`, not `active`, not `client_callable`, not `description`, not
`caller_access`, not the scope or package the record lives in. A reviewer looking
at the repository could not answer "is this script include public?" — a question
the platform answers with a single column — and a developer could not change the
answer without opening the browser.

The same gap applies to every tracked table: a business rule's `when`, `order`,
`condition` and `collection`; a UI action's `table`, `action_name`, `order`,
`form_button`, `condition`. In each case the *code* was under source control and
the *configuration that decides when the code runs* was not.

## 2. The model

One sidecar per record, holding every non-file column:

```
src/sys_script_include/MyUtil/script.js     <- unchanged: the file field
src/sys_script_include/MyUtil/.meta.json    <- new: everything else
```

In the flat layout the same file is `MyUtil~.meta.json`.

The single decision that keeps this change small is that the sidecar is
represented in the manifest **as a file**:

```json
{ "name": ".meta", "type": "json" }
```

inside `record.files`, next to `{ "name": "script", "type": "js" }`. Because it
looks like a file, it rides the machinery that already exists — the download
writer, the missing-file probe, the resumable checkpoint, `repair`, the build,
the push, `dev`'s watcher — without any of them learning a new concept. Two
per-table lists on the manifest carry the rest of the contract:

| Manifest key | Meaning |
| --- | --- |
| `metaFields` | Every column this table's sidecars record. The push matches keys against this list. |
| `metaReadOnlyFields` | The subset the dictionary marks `read_only` or `virtual`. Written to the file, withheld on the way back. |

`.meta` is not a column name, so exactly one seam needs an explicit guard: the
flat-layout orphan scan in `repair --prune`, where `MyUtil~.meta.json` is an
ordinary-looking file name that no column claims. `isMetaSidecarPath` is that
guard. (In the nested layout the leading dot already excludes it from the scan's
shape filter; in the flat layout nothing else does.)

## 3. Discovery — which columns are carried

Per table, once per refresh:

1. Walk the table's ancestry through `sys_db_object.super_class`, collecting the
   table and every parent (`sys_script_include` → `sys_metadata`). An inherited
   column is a column.
2. Query `sys_dictionary` across that whole hierarchy for
   `element,internal_type,read_only,virtual`.
3. Keep every row `isMetaFieldCandidate` admits.
4. Subtract the table's own file fields, so no column has two writers.
5. Record the result as `metaFields`, and the `read_only`/`virtual` subset as
   `metaReadOnlyFields`.

The governing rule is **carry everything the instance will show us**, narrowed by
exactly three exclusions.

### 3.1 `META_FIELD_DENYLIST` — six names

`sys_id`, `sys_created_by`, `sys_created_on`, `sys_updated_by`, `sys_updated_on`,
`sys_mod_count`.

Five of those are per-save audit stamps the platform rewrites on its own. They
describe the *last write*, not the artifact; carrying them would rewrite the
sidecar of every untouched record on every pull, turn `git status` into noise,
and bury the real metadata changes underneath it. `sys_id` is excluded for a
different reason: the manifest already owns it, it is the *key* of the update
rather than a value in it, and a hand-edited one would silently retarget the push
at a different record.

**This list used to be a blanket rule**, and that was the bug. An earlier
revision rejected every `sys_`-prefixed column outright. The six stamps above are
the only ones that deserved it; the rule took with them `sys_scope`,
`sys_package`, `sys_name`, `sys_class_name`, `sys_policy`, `sys_overrides`,
`sys_update_name`, `sys_domain`, `sys_customer_update`,
`sys_replace_on_upgrade` — the columns that say which application a record
belongs to, whether it is protected, and what it overrides. Naming the six
individually recovered 8 columns on `sys_script_include` alone
([§9](#9-live-verification)).

### 3.2 `NON_META_INTERNAL_TYPES` — by dictionary type

- Every key of `SN_TYPE_MAP`. A field of that type either already *is* a field
  file, or was deliberately removed from the file list by a config `excludes`
  rule — and a user who excluded `script` did not ask for it back as a JSON
  string.
- `password`, `password2`. Credentials must never reach the working tree. This is
  a hard design constraint, not a default: a secret in a git repository is a leak
  whether or not anybody meant it.
- `journal`, `journal_input`, `journal_list`. An append-only activity stream
  would churn the file on every pull.
- `collection`, `image`, `user_image`. No useful, round-trippable string form.

### 3.3 The table's own file fields

Removed by the caller. A column with two writers is a column that loses an edit
whenever the two disagree.

### 3.4 Escape hatch

`tableOptions.<table>.metaFields` replaces discovery for that table entirely. It
does not query the dictionary at all — that is the point, since it exists for
users who cannot read `sys_dictionary` — and therefore **bypasses every rule in
§3.1–§3.2**, not just the denylist. Only the table's file fields are still
subtracted. It can re-add the audit stamps if a workspace genuinely wants them;
it can equally name a credential column, and nothing downstream will stop it.
The type-based protection in §3.2 guards the *default* path. An explicit list is
an operator's deliberate override and carries the operator's responsibility:

```javascript
// sync.config.js
tableOptions: {
  sys_script: {
    metaFields: ["when", "order", "condition", "collection", "sys_overrides"],
  },
}
```

`meta: false` stops writing sidecars at all. `metaPush: false` keeps them as
read-only reference data.

## 4. Serialization — what the file looks like

`serializeMetaFields(row, fields)` writes a flat JSON object of
`"column": "value"` strings, keys sorted, one trailing newline. Three rules
matter.

**Keys are sorted** because the Table API gives no column-ordering guarantee.
Without the sort, a re-pull of an unchanged record produces a diff and a
workspace that refreshes on a timer never stops churning git.

**Every tracked column the response carried is written, including the empty
ones**, as `""`. An earlier revision dropped empties. That made the file smaller
and the feature much worse: a column that happened to be blank at pull time was
simply invisible, so the one question a reader most needs the file to answer —
*what can I set on this record?* — could not be answered from the file at all.
Measured live: `sys_script_include.caller_access` is tracked and writable, and
was blank on all 17 records of the probe scope, so it appeared in no sidecar
anywhere. Editing it required knowing it existed, which is exactly the state this
feature exists to end.

**A column the response omitted entirely stays absent**, rather than being
written as `""`. That is a genuinely different state — a column-level read ACL
hid it — and the file must never claim a value it was not shown. `!(field in
row)` is the whole of that distinction, and it is load-bearing: without it a push
would clear columns the user never read.

Reference cells arrive from the Table API as `{ link, value }` (the client does
not send `sysparm_exclude_reference_link`). `String()` on that object yields
`"[object Object]"` — a value that looks like data, survives into the file, and
is wrong. `metaValueText` unwraps to the referenced `sys_id`, which is also the
only form a push-back could send.

## 5. Push — the sidecar deploys like a script

`push`, `dev` and `deploy` expand the sidecar back into a Table-API update, in
the *same request* that carries the record's field files. Nothing about the
transport, the retry policy, the collaboration lock or the checkpoint is
special-cased for metadata; `expandMetaSidecar` runs at the last moment before
the body is sent and replaces the `.meta` pseudo-field with real columns.

Four rules, each present because the alternative loses an edit silently.

### 5.1 An unknown column is a hard error

ServiceNow ignores unknown columns in an update and answers `200`. A typo
(`descripton`) would otherwise be reported as a successful push that changed
nothing — the precise failure mode this feature exists to remove. The record
fails, and the message names the offending keys.

### 5.2 A read-only or virtual column is withheld, not rejected

`api_name` is derived server-side. It is written into the sidecar because it is
worth reading next to the script, and skipped on the way back because the
instance would discard it and still answer `200`. Failing on it would fail every
push of an *untouched* sidecar and make the feature unusable. The push logs what
it withheld:

```
sys_script_include > AuditHistoryLogsUtil : skipping read-only metadata
column(s) api_name, sys_package — the instance would discard them.
```

### 5.3 An absent key is not a request to clear

The update is a merge, not a replacement of the record. A sidecar written by an
older version, trimmed by hand, or produced under a column-level read ACL is
missing keys for reasons that have nothing to do with intent, and reading absence
as "clear it" would wipe columns nobody touched. Clearing is spelled `""` — which
is also what the file already shows for a column that is empty on the instance,
so the edit is a one-character change either way.

### 5.4 A degraded manifest is blamed instead of the file

If the table's `metaFields` is *empty*, every key in a perfectly good sidecar
reads as "unknown column" and §5.1 would send the user to edit a file that is
correct. An empty `metaFields` does not mean "this table tracks no columns"; it
means the manifest never got a metadata layer. The error says so, and points at
`syncrona refresh` and at the `tableOptions.<table>.metaFields` escape hatch.

`meta: false` and `metaPush: false` are checked *before* this path, so a
workspace that opted out and still has a leftover sidecar on disk pushes its
field files normally and logs one line about the skipped metadata. An opt-out is
a decision, not a fault.

Everything on the instance still applies on top: write ACLs, business rules and
data policies can reject or rewrite a value the push sent.

## 6. Degradation — a metadata layer that could not be built

The dictionary read can fail: a timeout, a 5xx, a read ACL on `sys_dictionary`.
The feature's rule is that this **never fails the download** — the scripts still
land — but it must never be quiet either.

Three things changed here.

**The refresh warns, at `warn`.** It used to log at `debug`, invisible at the
default level, and the result was a workspace of scripts with no metadata under a
cheerful "Download complete". One line per affected table, naming the table, the
cause, and both ways out:

```
Table sys_script_include: could not read the dictionary, so no .meta.json
sidecar will be written for its records and existing ones will not be pushable
(<cause>). The scripts are unaffected. If this user cannot read sys_dictionary,
set `tableOptions.sys_script_include.metaFields` explicitly; otherwise re-run
`syncrona refresh` once the instance answers again.
```

**A sidecar on disk still deploys.** This was the serious one. The original
wiring resolved a `.meta.json` the way it resolves a script — by looking the
field up in `record.files`. That works right up until a refresh writes a manifest
without a metadata layer, and from that point:

- `getFileContextFromPath` answered `undefined` for the sidecar,
- `getAppFileList` dropped the path silently along with genuinely invalid ones,
- the push reported success over a file it never sent.

Reproduced live: a manifest stripped of every metadata trace built 17/17 records
with **zero** sidecars in the build tree and no error anywhere. The fix is that a
sidecar belongs to the record whose directory it sits in — that is the whole of
its identity, and no manifest entry is needed to establish it. Correspondingly
`getBuildExt` answers `json` for `.meta` with no manifest entry, because
`.meta.json` is a constant of the format rather than a property of the record;
without that the file resolved and then failed to build, which is the same loss
one step later.

The leniency stops at the record. A path under a table or a record the manifest
does not know is still unmapped, and must stay unmapped — that is what stops
`repair --prune`'s scan and the push from adopting strays. An *ordinary* field
file gets no leniency at all: it names a column, and a column the manifest does
not list is a column the push must not invent.

**Nothing is dropped silently any more.** `getAppFileList` now reports the paths
it could not resolve, with the two reasons they usually have (a record that needs
a refresh; a leftover from a scope or layout this workspace no longer tracks).

## 7. Cost

Building the metadata layer costs two Table-API reads per table — the ancestry
walk and the dictionary query — on top of the manifest itself. For a 5-table
scope that measured 15 requests: 10 × `sys_db_object` + 5 × `sys_dictionary`.

Ten hierarchy requests for five tables is the waste: every table in a scoped
application ultimately extends `sys_metadata`, and that one row was fetched once
per table. `dev` re-runs the whole enrichment on an interval, so it repeats.

The fix memoises the *single-row parent lookup*, not the walk. (Memoising the
walk keyed on its starting table is useless — each table in a scope is walked
exactly once, so that cache never hits.) The memo is **per run**, cleared at the
top of `buildManifestFromTableAPI` and `attachMetaFieldsToManifest`, so a `dev`
session that refreshes every few seconds picks up a hierarchy change instead of
pinning the first answer it ever saw. A failed lookup is evicted rather than
cached.

Measured on the same scope afterwards: **11 requests** — 6 × `sys_db_object`
(five tables plus their one shared ancestor) + 5 × `sys_dictionary`. The saving
grows with the number of tables in the scope.

## 8. Where the code lives

| File | Responsibility |
| --- | --- |
| `packages/core/src/metaFields.ts` | The whole policy: constants, predicates, `serializeMetaFields`, `resolveMetaUpdate`. |
| `packages/core/src/manifestBuilder.ts` | Discovery: hierarchy walk (+ memo), dictionary query, `attachMetaFieldsToManifest` for the scoped-app manifest path. |
| `packages/core/src/downloadPipeline.ts` | Writes the sidecar during download. |
| `packages/core/src/FileUtils.ts` | Path → record resolution (`getFileContextFromPath`) and build extension (`getBuildExt`). |
| `packages/core/src/pushPipeline.ts` | `expandMetaSidecar`, the opt-outs, and the unresolved-path report. |
| `packages/core/src/repairCommand.ts` | The flat-layout orphan-scan guard. |

Regression tests: `metaSidecar.test.ts` (policy), `metaSidecarPush.test.ts` (push
contract), `metaSidecarResolution.test.ts` (degraded-manifest resolution),
`metaEnrichmentCost.test.ts` (request count and the degradation warning).

## 9. Live verification

Against a 5-table vendor scope, 17 records, with the built CLI.

**Download.** `syncrona download <scope> --ci` wrote 17 sidecars for 17 records.
Columns recorded per table, before and after the discovery widening:

| Table | before | after |
| --- | ---: | ---: |
| `sys_script` | 29 | 40 |
| `sys_script_client` | 14 | 25 |
| `sys_script_include` | 9 | 17 |
| `sys_ui_action` | 34 | 45 |
| `x_nuvo_mobile_nuvolo_property` | 8 | 18 |

The 8 columns recovered on `sys_script_include` are `sys_class_name`,
`sys_customer_update`, `sys_name`, `sys_package`, `sys_policy`,
`sys_replace_on_upgrade`, `sys_scope`, `sys_update_name`. Two columns that are
blank on the instance — `caller_access` and `sys_policy` — now appear as `""`
and are therefore editable; before the serializer change neither was in the file.

**Build.** `syncrona build` produced 17 sidecars in the build tree. Repeated
against a manifest with `metaFields`, `metaReadOnlyFields` and every `.meta`
entry stripped out: **17/17 again**, where the same experiment before the fix
produced 0/17 with no error.

**Push.** One column edited in one sidecar, then
`syncrona push <path>/.meta.json --ss --ci`:

```
1 files to push.
sys_script_include > AuditHistoryLogsUtil : skipping read-only metadata
column(s) api_name, sys_package — the instance would discard them.
Successful Pushes: 1
```

A direct Table-API read confirmed the new value and a fresh `sys_updated_on`. The
original value was pushed back by the same path and confirmed restored.

**Cost.** 15 → 11 requests for the same scope, as in [§7](#7-cost).

## 10. Deliberate non-goals

- **Creating or deleting records.** The sidecar updates an existing record. New
  records and deletions remain a ServiceNow-side operation moved by update sets,
  as with all other non-code architecture.
- **Attachments and binaries.** No round-trippable string form; out of scope.
- **Credentials.** `password`/`password2` are excluded by dictionary type on the
  discovery path, which is the path every workspace uses. An explicit
  `tableOptions.<table>.metaFields` list is not filtered (§3.4) — the tool cannot
  type-check a list from a config file without the dictionary read that list
  exists to avoid. Naming a credential column there is a leak the tool will not
  catch.
- **Conflict detection on metadata.** The push is a merge into the live record
  and does not compare against the state at download time. Two people editing
  different columns of the same record both win; two people editing the same
  column, last writer wins — the same semantics the field files have.
