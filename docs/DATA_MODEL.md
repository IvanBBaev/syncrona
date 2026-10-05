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
  `<table>/<record>/.meta.json` and nothing else.
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
named by its display value.

## What a record contains

A data-model record is its sidecar. The columns written there are the ones
dictionary discovery finds for the table, minus the deny list that applies to
every sidecar: system columns, passwords and other secrets, and file fields. A
field file is only written where the table has a script-typed column (a
dictionary entry's `calculation`, for example). `tableOptions.<table>.metaFields`
replaces discovery for a table, just as it does for any other sidecar.

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

## Child tables

Records on a child table are independent records. A dictionary override, a
choice or a documentation entry is never nested under the column it belongs to.
Each child table has its own folder, its own records, and its own entry in
`dataModelTables`.

## Editing and pushing

Edit a sidecar and run `syncrona push`, as for any record. For an opted-in
table the push first reads the record's current values (one GET of the sidecar
columns). It then PATCHes **only the columns that differ**. Re-sending an
unchanged `internal_type` or `max_length` would re-run the dictionary business
rules, and it would overwrite a column someone else changed on the instance
since the last pull. If that read fails, the record fails and nothing is sent.
Field files are always sent.

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

## Deleting records

Pruning (deleting instance records whose local files are gone) is **never
allowed** for the documented data-model tables, whether or not a workspace opts
them in: `push --prune` refuses those records and sends no DELETE. Deleting a dictionary entry, a table, a role or an ACL deletes data or
access on the instance. Delete these records on the instance on purpose, then
refresh. (`repair --prune` only deletes local orphan files and is unaffected.)

## Limitations

- The naming rules for dot-walked columns (`operation.name`, `role.name`, and
  the rest) rely on the Table API returning the dot-walked value. This has not
  yet been verified against every instance release.
- The live round-trip acceptance test (pull, edit a dictionary entry, push, pull
  again, no diff) has not been run against a live instance as part of this
  change. It is covered by mocked tests only.
- The `syncrona init` wizard does not ask about data-model tables. Add
  `dataModelTables` to `sync.config.js` by hand.
