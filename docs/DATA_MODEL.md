# The data model as local records

SyncroNow AI can track a scoped application's data model (its tables, columns,
choices, properties, roles, ACLs and UI policies) as ordinary local records
that you edit, review in a pull request and push back. The feature is opt-in.

## Why

A scoped app is more than its scripts. When a column's label or length, a
choice list, an ACL or a role lives only on the instance, nobody reviews it and
nothing records its history. Most data-model records have no script field at
all, so the file-based sync used to skip them. With record metadata
(`.meta.json` sidecars, see
[docs/design/record-metadata-layer.md](design/record-metadata-layer.md)), a
record can be represented by its sidecar alone. The data model builds on that.

## Opting in

List the tables to track in `sync.config.js`:

```javascript
module.exports = {
  // ...
  dataModelTables: ["sys_db_object", "sys_dictionary", "sys_choice"],
};
```

The default is `[]`, so nothing changes until you opt in. Several of these
tables are excluded by default (`sys_dictionary`, `sys_security_acl`,
`sys_scope_privilege`, `sys_ui_policy`), and silently re-including them would
change every existing workspace on its next refresh.

Listing a table:

- **re-includes it** when the default (or your own) `excludes` drop it. An
  explicit `includes.<table>: false` still wins, so a team can share one list
  and switch a single table off.
- **tracks records with no file field.** Each one is written as
  `<table>/<record>/.meta.json`. A record also gets a field file where its
  table has a script-typed column (a dictionary entry's `calculation`, see
  [What a record contains](#what-a-record-contains)).
- **gives it a stable naming rule** where its display value is not unique (see
  below).

Each entry must be a table name made of letters, digits and `_`. Config
validation names any entry that is not.

The documented tables are:

| Table | What it holds | Record name |
|---|---|---|
| `sys_db_object` | table definitions | display value (the table name) |
| `sys_dictionary` | column definitions | `<name>.<element>` |
| `sys_dictionary_override` | column overrides on child tables | `<name>.<element>` |
| `sys_documentation` | column labels and help per language | `<name>.<element>.<language>` |
| `sys_choice` | choice-list entries | `<name>.<element>.<value>` |
| `sys_properties` | system properties | display value (the property name) |
| `sys_user_role` | roles | display value (the role name) |
| `sys_user_role_contains` | role containment | `<role.name>.<contains.name>` |
| `sys_security_acl` | ACLs | `<name>.<operation>` |
| `sys_security_acl_role` | roles required by an ACL | `<acl name>.<acl operation>.<role name>` |
| `sys_scope_privilege` | cross-scope privileges | `<target_scope.scope>.<target_name>.<operation>` |
| `sys_ui_policy` | UI policies | display value |
| `sys_ui_policy_action` | UI policy actions | `<ui_policy.short_description>.<field>` |

Any other table name is accepted too. It is tracked the same way, but it is
named by its display value. Such a table needs a `sys_scope` column, its own or
an inherited one; see the next section for a table that has none.

## Which records belong to the scope

A record belongs to the scope when its `sys_scope` column says so. That holds
for every documented table except `sys_choice`, and for any other table that
extends `sys_metadata`.

`sys_choice` has no `sys_scope` column. The Table API ignores a query term on a
column a table does not have, so filtering it by scope would return every choice
on the instance. A choice is attributed through what it belongs to instead. It
is tracked when one of these is true:

- its table (`name`) is defined by the scope;
- its column (`name` and `element`) is defined by the scope on a table of
  another scope;
- its choice list (the `sys_choice_set` record for `name` and `element`) is
  owned by the scope.

Building the manifest reads `sys_db_object`, `sys_dictionary` and
`sys_choice_set` once for this, whether or not those tables are listed
themselves. A scope that owns no table, column or choice list has no choices,
and `sys_choice` is not queried at all. `tableOptions.sys_choice.query` is
appended to that selection with `^`. Write it as an AND filter: a query
containing `^NQ` starts a new OR group that the ownership rule does not bound.

A table you add yourself is checked for a `sys_scope` column before it is read.
If it has none, its records cannot be attributed to a scope:

- with `tableOptions.<table>.query` set, the table is read by that query alone,
  and you are responsible for what it selects;
- without it, the table is left out and a warning names it.

## What a record contains

A data-model record is its sidecar. The columns written there are the ones
dictionary discovery finds for the table, minus the deny list that applies to
every sidecar: system columns, file fields, passwords and other secrets,
journals, collections and images. Field files are written for script-typed
columns (a dictionary entry's `calculation`, for example) and for any column you
list in `includes`. An `includes` entry cannot lift the password, journal,
collection and image filter: such a column is dropped with a warning, whether
the manifest comes from the scoped endpoint or the Table API fallback, on
`init`, `refresh` and `download` alike — its value is never written and never
requested. The type is compared after trimming and lower-casing, so
`Password2` is a credential type too. If its dictionary type cannot be read (no
dictionary row, an empty `internal_type`, or a failed lookup), it is kept and a
warning names it once per build. When the table's parent hierarchy cannot be
read (a `sys_db_object` lookup fails, or an ACL hides the row), a column the
table inherits has no dictionary row either; it is kept the same way, and the
warning says the parent table hierarchy could not be read and names the table
where the walk stopped. A column dropped this way that an earlier version had
already written (or one you took out of `includes`) keeps its file on disk:
`refresh` and `download` never delete it, but the run that drops the column warns
once, naming each such file, that it is no longer synced and can be deleted.
`syncrona repair` lists those files as orphans, and `repair --apply --prune`
removes them only when git holds them committed and unchanged. If the file held
a credential, delete it and rotate the credential. A column that does not exist leaves the table reported incomplete on
`refresh` and `download`. `tableOptions.<table>.metaFields` replaces discovery for a
table, just as it does for any other sidecar.

A `sys_properties` record of type `password` or `password2` keeps its secret in
`value`, a plain string column, so the type filter cannot see it. Neither its
sidecar nor a `value` field file (from `includes` or the data-field fallback)
carries it: the Table API build does not list `value` for that record, the
scoped manifest lists it but the fetch withholds it, and a download reports the
withheld count at info level. A property whose `type` cannot
be read is treated the same way. The rule applies on every write path, `init`
included: there the scoped endpoint's answer for `value` is discarded and
re-read by sys_id through the Table API; records that re-read does not return
get no value and a warning gives their count (`refresh` retries them). `repair`
does not report a withheld value as a missing file, and `repair --apply`
re-fetches governed values, restoring a non-secret one. Pushing that
sidecar does not clear the value on the instance, because a missing key is never
a request to clear a column. To change such a value, set it on the instance.

If the dictionary cannot be read and the table has no explicit `metaFields`, its
sidecar-only records are skipped with a warning. The rest of the refresh goes on.

## Stable names

A dictionary entry's display value is its table's name, so every column of a
table would collide on one folder. Opted-in tables with a rule in the table
above are named by joining the non-empty values of the listed columns with `.`.
A dotted column such as `operation.name` is a Table API dot-walk.

Names can still collide: two choices with the same value in two languages, two
ACLs on the same object and operation, or two names that differ only by case on
a case-insensitive volume. Every member of such a group is then suffixed with
`_<sys_id>`. The suffix depends only on the set of records, never on the order
the instance returned them, so a refresh does not move folders around.

You can override a rule in `tableOptions`:

- `displayField` names records by one column, as for any table.
- `nameFields` (an array of columns, joined with `.`) replaces the rule.

Either one takes precedence over the built-in rule.

Records in composite-named tables are always downloaded through the Table API.
The scoped bulk endpoint names records by display value, so its answer would
land in folders the manifest does not know.

A `sys_properties` `value` field file is also always fetched through the Table
API, which reads each property's `type` with the row; the scoped endpoint cannot
tell a password property from any other.

## Record folder names

These rules apply to every table, not only to the data-model tables above. A
record's folder (or, in the flat layout, its file prefix) is its name in the
manifest, and the same names are used to download, refresh, push, watch and
repair. They apply in the same way whether the manifest comes from the scoped
endpoint or from the Table API.

- **Collisions.** Two names collide when they are equal after Unicode NFC
  normalisation, lower-casing (with the Greek final sigma `ς` folded to `σ`)
  and removing trailing dots and spaces. On APFS, NTFS and SMB shares such
  names are one folder. Every member of a
  colliding group gets the suffix `_<sys_id>`, for example `Util_<sys_id>` and
  `util_<sys_id>`. The suffix counts toward the same 160-byte budget as the
  name: a long name is cut further, with its hash, so that `_<sys_id>` fits.
  The result depends only on the set of records, not on the order the instance
  returns them in. The CLI prints one warning per group.
- **Stable under re-naming.** Every folder name these rules produce comes back
  unchanged when it passes through them again, so the scoped endpoint and the
  Table API give the same records the same folders.
- **Records that do not collide** keep their names exactly as before.
- **Names no filesystem stores as written.** A NUL, another control character
  (C0, DEL, C1) or a tab in a record name is replaced with `_`, and a lone
  UTF-16 surrogate with U+FFFD. A name longer than 160 UTF-8 bytes is cut at
  the last whole code point that fits and gets `_<hash>`, the first 8 hex
  digits of the SHA-256 of the whole name. Two long names with the same prefix
  therefore get different folders, and the result is the same on every run.
  The 95 bytes left below the 255-byte segment limit hold the flat layout's
  `~<field>.<ext>`: a field name of up to 80 characters, the ServiceNow
  column limit, and an extension of up to 13 bytes. A longer tail stops the
  download with the segment-length error instead of being cut. The cut keeps whole code points, so
  it can still separate an emoji from a combining mark that follows it.
- **Names Windows cannot store.** Trailing dots and spaces are removed, since
  Windows would drop them, for example `Report.` becomes `Report`. A Windows
  device name (`CON`, `PRN`, `AUX`, `NUL`, `COM0`–`COM9`, `LPT0`–`LPT9` and
  the `¹²³` variants, in any case, alone or with an extension) gets `_` after
  the device stem: `CON` becomes `CON_`, `aux.txt` becomes `aux_.txt`. A
  record whose name is empty, only whitespace or only dots is named by its
  `sys_id`.
- **Other path segments are refused, not altered.** A table, field, type or
  scope name with a separator, a control character, a lone surrogate or more
  than 255 bytes stops the download with a `Refusing to download: unsafe ...`
  error, because the same name also addresses the record on the instance. The
  error states which rule the name broke: path traversal (it then also names
  the directory it would escape), a control character or lone surrogate with
  its code point, or the segment's length in UTF-8 bytes.

### Upgrading an existing checkout

The scoped endpoint used to name records by display value only. On a
case-insensitive volume, two records whose names differed only by case or
normal form were written into one folder and overwrote each other. On the
first `refresh` or `download` with these rules:

- Folders of records that do not collide stay where they are. Folders that an
  earlier Table API build had already suffixed also stay.
- A colliding record whose old folder belonged to it alone, which happens on a
  case-sensitive volume or when only one member was ever downloaded, has that
  folder renamed to the suffixed name. Local edits move with it, and the CLI
  prints `Renamed "<table>/<old>" to "<table>/<new>"`. Commit the rename.
- A folder that several colliding records shared cannot be assigned to one of
  them. It is left in place with a `Left "<table>/<old>" in place` warning, and
  each record is downloaded fresh into its new folder. Review the old folder,
  then delete it; `syncrona repair` lists its files as orphans.
- A record whose name was stored verbatim but is now made to fit (161 to 255
  bytes, or a tab or other control character) has its folder renamed in the
  same way, with the same `Renamed` warning. So does a folder with a trailing
  dot or space, a Windows device name, or a whitespace-only name.
- When a collision dissolves, because the other members were deleted on the
  instance, the remaining record's suffixed folder is renamed back to the plain
  name, for example `Foo_<sys_id>` to `Foo`, with the same `Renamed` warning.
  If a folder with the plain name already exists, the suffixed one is left in
  place with a `Left ... in place` warning.
- A colliding long name that an earlier version suffixed on top of the
  former 180-byte budget (up to 213 bytes) has its folder renamed to the cut
  form that fits, in the same way. So does a name an earlier version cut at
  180 bytes, now that the budget is 160.
- No folder is moved when the destination already exists. The old folder is
  left in place, with a warning.

After the upgrade, push and watch resolve only the new paths. A file left in
an old folder is no longer matched to a record.

## Child tables

Records on a child table are independent records. A dictionary override, a
choice or a documentation entry is never nested under the column it belongs to.
Each child table has its own folder, its own records, and its own entry in
`dataModelTables`.

## Editing and pushing

Edit a sidecar and run `syncrona push`, as for any record. For an opted-in
table the push first reads the record's current values (one GET of the sidecar
columns). It then PATCHes **only the columns whose local value differs from the
current instance value**. Re-sending an unchanged `internal_type` or
`max_length` would re-run the dictionary business rules. If that read fails,
the record fails and nothing is sent. Field files are always sent.

The compare is two-way (local sidecar against the current instance row), not
a three-way merge: syncrona keeps no pulled baseline. A column someone changed
on the instance since your last pull still differs from your sidecar, so it is
sent and overwrites that change. `refresh` does not overwrite existing files,
so re-download a data-model record that others may have changed before you
edit it.

An unknown key in a sidecar is a hard error, as for every sidecar. Nothing is
sent for that record.

## Creating records

`syncrona push --create` creates a sidecar-only data-model record, even on a
table the manifest has never described. Its columns are read from the
dictionary at create time and stored in the manifest, so the next push of that
sidecar resolves without waiting for a refresh. If the dictionary yields no
columns, the record fails and nothing is posted.

For a composite-named table, the idempotency lookup (before the create, and
before any retry of a failed POST) matches the naming columns read from the
sidecar plus the scope. Every naming column must be set in the sidecar. Matching
on fewer columns could adopt a different record.

Create stays **denied** for `sys_properties` and `sys_user_role`, as it is for
every table on the always-deny list. Existing records on those tables can still
be updated.

`sys_choice` does not extend `sys_metadata`, so `push --create` does not allow
it by default the way it allows application files. Creating a choice needs
`sys_choice` in the `createTables` config list or in the `SYNCRONA_CREATE_TABLE_ALLOWLIST` environment allowlist
(the same opt-in as any other non-metadata table). Without it the record is
refused and nothing is posted.

The idempotency lookup of a `sys_choice` create matches its natural key
(`name`, `element`, `value` and `language`) **across scopes**: `sys_choice`
has no `sys_scope` column to bound it. A choice with the same key that another
scope added is therefore adopted instead of created.

## Deleting records

Pruning (deleting instance records whose local files are gone) is **never
allowed** for the documented data-model tables, whether or not a workspace opts
them in: `push --prune` refuses those records and sends no DELETE. Deleting a dictionary entry, a table, a role or an ACL deletes data or
access on the instance. Delete these records on the instance on purpose, then
refresh. (`repair --prune` only deletes local orphan files git holds committed
and unchanged, and is unaffected.)

After such a refresh the record's local `.meta.json` is left behind. `repair`
reports it as an orphan when the manifest still lists the table but no longer
holds the record, and `repair --apply --prune` deletes that local file — when
the manifest committed at HEAD tracked the record (so it was on the instance)
and git holds the file committed and unchanged — so a later `push --create`
does not POST the deleted record back. A record no committed manifest tracked
is taken for one awaiting `push --create` and kept, committed or not; so is a
file git cannot restore. Delete such a leftover by hand. A sidecar of a
table the manifest does not list at all (a new record waiting for
`push --create`, or a table the last refresh could not read) is reported with
a warning and never pruned.

## Composite documents

By default every data-model record is its own sidecar, so one table with ten
columns and thirty choices is forty-one `.meta.json` files in three folders.
`dataModelLayout: "composite"` keeps the same records as one document per table:

```javascript
module.exports = {
  // ...
  dataModelTables: ["sys_db_object", "sys_dictionary", "sys_choice"],
  dataModelLayout: "composite", // default: "records"
};
```

The layout covers `sys_db_object`, `sys_dictionary` and `sys_choice`, and only
those of them listed in `dataModelTables`. Every other data-model table keeps its
per-record sidecars. A download writes `<sourceDirectory>/data-model/<table>.json`:

```json
{
  "format": "syncrona.data-model/1",
  "table": "x_demo_task",
  "sys_db_object": {
    "x_demo_task": { "label": "Task", "name": "x_demo_task", "super_class": "task" }
  },
  "sys_dictionary": {
    "x_demo_task.u_foo": { "column_label": "Foo", "element": "u_foo", "name": "x_demo_task" }
  },
  "sys_choice": {
    "x_demo_task.u_foo.1": { "element": "u_foo", "label": "One", "name": "x_demo_task", "value": "1" }
  }
}
```

- **One document per table.** A record is grouped by its `name` column (the
  table it belongs to). Each section maps the record name (the same stable name
  the per-record layout uses) to exactly the columns its sidecar would hold.
  A key is one path segment: an empty key, `.` or `..`, or a key containing
  `/`, `\` or a NUL character is refused, and so is a downloaded record whose
  name is one of those.
- **Byte-stable.** Sections, records and columns are written in a fixed order,
  and a document whose content did not change is not rewritten. A refresh or
  download of an unchanged scope leaves no diff, and a document whose entries
  are unchanged keeps its own formatting (line endings, indentation).
- **Download and refresh** follow the sidecar rules: `download` overwrites an
  entry with the instance's values, `refresh` only adds entries a document lacks.
  A record whose only file is its sidecar gets no folder. A field file (a
  dictionary entry's `calculation`) is still written per record.
- **Push** expands a changed document into one sidecar per entry, then pushes
  each exactly as in the per-record layout: one GET, and a PATCH of only the
  columns that differ. An unchanged entry sends nothing. The table definition
  is pushed before any column, and a column before any choice. An entry is
  pushed only to the record its section and key name; push refuses an entry
  that resolves to any other record.
- **Create** (`push --create`) treats an entry no manifest record claims as a
  new record. It creates tables, then columns, then choices, with the same
  create-or-adopt lookup as a per-record sidecar.
- **Prune** is unchanged. Removing an entry does not delete the record: the
  documented data-model tables are never pruned (see
  [Deleting records](#deleting-records)).

The two layouts are never mixed for a record. `download`, `refresh`, `push`,
`repair` and `status` all refuse (or, for `status`, report) a workspace where:

- a record has both a document entry and a per-record `.meta.json`;
- `dataModelLayout` is `"composite"` and a covered table still has per-record
  sidecars;
- `dataModelLayout` is `"records"` and `data-model/` holds documents;
- a document has a section for a table that is not in `dataModelTables`.

Nothing is written or sent while the conflict stands. To switch layouts,
delete the files of the old layout (the per-record `.meta.json` files of the
three tables, or the `data-model/` folder), change `dataModelLayout`, and run
`syncrona refresh`. `repair` also lists document entries that no manifest
record claims. `status` prints the active layout and the number of documents.

## Limitations

- The naming rules for dot-walked columns (`operation.name`, `role.name`, and
  the rest) rely on the Table API returning the dot-walked value. This has not
  yet been verified against every instance release.
- The live round-trip acceptance test (pull, edit a dictionary entry, push, pull
  again, no diff) has not been run against a live instance as part of this
  change. It is covered by mocked tests only. Its "prune it" step cannot pass
  for `sys_dictionary`: `push --prune` refuses every data-model table by design
  (see [Deleting records](#deleting-records)). The expected result of that step
  is the refusal, with no DELETE sent.
- Choices are attributed per choice list, not per choice. A single choice your
  scope adds to a choice list that another scope owns is not tracked.
- The `syncrona init` wizard does not ask about data-model tables. Add
  `dataModelTables` to `sync.config.js` by hand.
- `syncrona dev` (watch mode) pushes per-record sidecars only. It does not
  expand a data-model document; use `syncrona push` after editing one. Under
  the composite layout it skips a stray per-record sidecar of a covered table,
  with one warning per file, just as `push` refuses it.
- Each entry of a changed document is compared with the instance by its own
  GET, so a push of a large document makes one request per record.
