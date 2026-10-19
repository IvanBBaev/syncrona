# @syncrona/fluent

**Optional Fluent tier** for SyncroNow AI. It powers `syncrona fluent <action>`
by driving the ServiceNow SDK (`@servicenow/sdk`) orchestrator. That covers
building, transforming, packing and installing Fluent (`.now.ts`) applications,
plus generating types, adding dependencies and running project scripts.

The core CLI works without this package. Install it, together with the SDK, only
if you build Fluent applications:

```sh
npm install --save-dev @syncrona/fluent @servicenow/sdk
```

If either package is missing, `syncrona fluent` exits 1 with a single
install hint. No other command is affected.

`syncrona fluent types --native` needs neither package: core generates the table
types (`@types/syncrona/tables.d.ts`) from `sys_db_object`, `sys_dictionary` and
`sys_choice` directly, and a plain `types` falls back to it when the SDK is not
installed.

## What lives here

- `createFluentEngine(options, deps?)`: implements the `SN.FluentEngine` port
  from `@syncrona/types`.
  - The SDK is loaded on the first call, never at import, because loading it
    costs about a second.
  - It is resolved from the Fluent project first, then from this package.
  - SDK telemetry is turned off (`NO_TELEMETRY=1`).
- `createFluentAuthResolver(instanceUrl, input)`: bridges a stored syncrona
  profile to the SDK's credential resolver.
  - A Basic profile logs in through the UI session (`angular.do`), so the
    session-only endpoints work: `sn_appclient_upload_processor.do`,
    `xmlhttp.do` and `fluent_update_set_export.do`.
  - An OAuth profile hands over its bearer token.
  - An injected UI session (`{ kind: "session", token, cookie }`) is handed
    over as is, with no login.
  - API-key profiles are refused, because the SDK cannot use them. A
    mutual-TLS client certificate works with either Basic or OAuth: core hands
    the adapter the TLS material as `tls`.
  - The resolver never memoizes. The SDK's own `LazyCredential` caches the
    result and re-resolves after an instance 401.
- `loginUiSession(instanceUrl, user, password, fetch?)`: the two-step UI login.
  It returns `{ type: "basic", token, cookie }` and never logs credentials.
- `explainDocs(docs, options)` and `defaultSdkDocsLoader(projectDir)`: back
  `fluent explain`. The loader finds the `docs` directory the SDK bundles and
  the public `@servicenow/sdk-api/docs` module without evaluating the SDK; it
  throws `FluentDocsUnavailableError` when either is missing.
- `compileFluentProject({ projectDir })`: a native compiler for a subset of
  the Fluent core APIs (`SUPPORTED_FLUENT_APIS`: `Acl`, `AiAgent`,
  `Alias`, `AliasTemplate`, `Applicability`, `ApplicationMenu`, `Assessment`,
  `BusinessRule`, `CatalogClientScript`, `CatalogItem`,
  `CatalogItemRecordProducer`, `CatalogUiPolicy`, `ChoiceSet`, `ClientScript`,
  `ColumnTypeCheck`, `CrossScopePrivilege`, `CssInclude`, `Dashboard`,
  `DatabaseView`, `DataLookup`, `DataPolicy`, `EmailNotification`, `Form`,
  `GraphQLApi`, `ImportSet`, `InboundEmailAction`, `Interceptor`, `JsInclude`,
  `LinterCheck`, `List`, `NowAssistSkillConfig`, `PlaybookDefinition`,
  `Property`, `Record`, `RestApi`, `RestMessage`, `RetryPolicy`,
  `RiskAssessment`, `Role`, `ScheduledScript`, `ScriptAction`,
  `ScriptInclude`, `ScriptOnlyCheck`, `ServicePortal`, `Sla`,
  `SPAngularProvider`, `SPHeaderFooter`, `SPMenu`, `SPPage`, `SPPageRouteMap`,
  `SPTheme`, `SPWidget`, `SPWidgetDependency`, `StateModel`, `Table`,
  `TableCheck`, `Test`, `TestSuite`, `UiAction`, `UiPage`, `UiPolicy`,
  `UserPreference`, `UxListMenuConfig`, `VariableSet`, `Workspace`), without
  the SDK.
  - `Record()` writes one record of any table except the ones the SDK builds
    with its own record plugins (`sys_dictionary`, `sys_choice`, ...), which
    are an error. A table another API owns gets the SDK's hint to use that
    API. Role and view names in the m2m tables the SDK resolves
    (`sys_ui_action_role`, `sys_user_role_contains`, ...) become coalesce
    references, as in the SDK.
  - `Now.attach('./logo.png')` as a `Record()` data value attaches an image
    (`.jpg`, `.jpeg`, `.png`, `.bmp`, `.gif`, `.ico`, `.svg`) to that field:
    the `sys_attachment` record and its gzipped `sys_attachment_doc` chunks are
    written into the record's file, with the SDK's ids and checks. The chunks
    use node:zlib with a zero timestamp rather than the SDK's fflate stream,
    so builds are reproducible but their bytes (and the chunk ids) differ.
  - `Assessment()` writes the `asmt_metric_type`, an `asmt_metric_category`
    per category, an `asmt_metric` per metric and an `asmt_metric_definition`
    per definition (a numeric scale without definitions gets one per value
    from `min` to `max`). A scored assessment adds the SDK's trigger and
    delete business rules, and a scheduled one its `sys_trigger` job and,
    once published with a `userField`, the user-field rule, unless
    `scheduleJob`/`userFieldBusinessRule` name existing records.
    `RiskAssessment()` writes a `change_risk_asmt` on `change_request` with a
    `change_risk_asmt_threshold` per threshold. Durations take `Duration()`,
    an object or a `glide_duration` string, and the SDK's table, scale
    factor, publish-state and metric checks are errors and hints with its
    messages.
  - `ChoiceSet()` adds choices to a field the app does not define and returns
    them in `files` as the same `author_elective_update/sys_choice_<table>_<field>.xml`
    a `Table()` choice column writes. As in the SDK, a field the project's own
    `Table()` defines is an error (use inline choices there), and so is a table
    outside the app in a scoped app; a `legacyChoices` other than `true` in
    now.config.json is not supported yet.
  - `Dashboard()` writes the top layout's canvas and widgets, each tab with its
    canvas and widgets, a visibility per `visibilities` entry (a `Workspace()`
    record or an experience sys_id; the default experience when there is none)
    and a permission per `permissions` entry. A widget's `component` name
    resolves to its sys_id and its `componentProps` (plain JSON) merge over the
    SDK's property defaults.
  - `DatabaseView()` writes a `sys_db_view` keyed by its `name`, a
    `sys_db_view_table` per entry of `tables` and a `sys_db_view_table_field`
    per selected field. A name the platform would normalize, a name without
    the scope prefix (`u_` in global) and a `variablePrefix` with an
    underscore, over 30 characters or used twice are errors; two tables with
    the same `order` get the SDK's hint.
  - `DataPolicy()` writes a `sys_data_policy_rule` per entry of `rules` (keyed
    by field name, each with its own `$id`) and runs the SDK's checks: a table
    outside the app's scope, a rule both mandatory and read-only, and a
    mandatory rule on a table outside the scope are errors. A `mandatory` or
    `readOnly` other than a boolean or `'ignore'` is an error too, where the
    SDK quietly writes `ignore`.
  - `EmailNotification()` writes one `sysevent_email_action` from its
    `triggerConditions`, `recipientDetails`, `emailContent` and `digest`
    groups. References take sys_ids or records (recipient users also take
    email addresses); an invalid one is an error, as are an `engine` trigger
    without `onRecordInsert` or `onRecordUpdate` and an `event` trigger without
    `eventName`. A digest on a `vcalendar` notification, event-parameter
    recipients on a non-event trigger and message fields that disagree with
    `contentType` get the SDK's warnings.
  - `Form()` writes the form with its section links as one
    `sys_ui_form_sections_<id>.xml` file and each section with its elements
    and annotations as one `sys_ui_section_<id>.xml` file, as the SDK's form
    plugin does. Two-column blocks get the `.begin_split`, `.split` and
    `.end_split` markers; annotation types and formatters take the SDK's
    `AnnotationType` and `Formatter` constants, their keys or a sys_id; lists
    take `12M`/`M2M` dot-notation references or a `sys_relationship`. The
    SDK's section, block and element checks are errors and warnings with its
    messages.
  - `GraphQLApi()` writes the `sys_graphql_schema`, a `sys_graphql_resolver`
    per resolver with a `sys_graphql_resolver_mapping` per path (coalesced on
    the schema and the path) and a `sys_graphql_typeresolver` per type
    resolver. The application namespace is derived from the scope (`now` in
    global, where an API may name its own), and the SDK's namespace,
    duplicate-name and shared-namespace checks are errors with its messages.
    Scripts must be strings.
  - `ImportSet()` writes the `sys_transform_map`, a `sys_transform_entry` per
    field mapping (coalesced on the map and its target field; a string maps a
    source field with every option at its default) and a
    `sys_transform_script` per transform script. A script left out is the
    instance's default template, and the SDK's `runScript`/`coalesce` errors
    and `sourceScript` hints apply. Scripts must be strings.
  - `InboundEmailAction()` runs the SDK's checks: a `fieldAction` without a
    `table` on a record action and a `from` that is neither a sys_id nor a
    `sys_user` record are errors. Its script must be a string; the SDK's
    module functions are not supported yet.
  - `Interceptor()` writes the `sys_wizard` (coalesced on its name) and a
    `sys_wizard_answer` per answer, with the SDK's answer type codes and its
    hints and warnings for fields an answer type uses or ignores and for
    sibling answers sharing an order. It takes no `$id` or `$meta`.
  - `List()` writes the list and a `sys_ui_list_element` per column as one
    `sys_ui_list_<table>_<view>.xml` file (with the parent, relationship and a
    non-global domain in the name), as the SDK's list plugin does. Its `view`
    is `default_view`, a `sys_ui_view` record or a view name; a `Record()` of
    `sys_ui_view` gets the SDK's check that its name is alphanumeric. A view
    named by string has a fresh sys_id on every build, in the SDK as here.
  - `NowAssistSkillConfig()` writes the skill's `sys_one_extend_capability`
    with its skill config and status, a capability definition and definition
    config per provider, a `sys_generative_ai_config` and prompt config per
    prompt, the input and output attributes (with the five standard outputs),
    the feature, strategy and resource mappings and, with `securityControls`,
    an execute ACL and an agent access role configuration — every file with
    the SDK's `[object Object]` root table. The SDK's name, provider, prompt,
    state and attribute checks are errors with its messages. Tools, skill and
    deployment settings, role-based user access, `roleMap`, more than one
    prompt version, filter conditions and record/JSON attributes are not
    supported yet.
  - `PlaybookDefinition()` (from `@servicenow/sdk/automation`) writes one
    `sys_pd_process_definition_<id>.xml` file as the SDK's playbook plugin
    does: the clean-ups of lanes and activities it no longer declares, the
    playbook, each lane with its activities and their input and experience
    property values and mappings, the triggers with their inputs and, with a
    `parentTable`, the parent-record process input. This first slice compiles
    record-driven playbooks with `RecordCreate`, `RecordUpdate` and
    `RecordCreateOrUpdate` triggers on the parent table,
    `wfa.playbook.run.Immediately()` and `After(...)` start rules, and the
    `Instruction` and `TwoStepInstruction` activities with string inputs and
    experience properties; the SDK's name deduplication and duplicate-order
    error apply. Other activity definitions and trigger types, data pills in
    values, `Run.Manually()`, variants, permissions and the launcher, AI-agent
    and other playbook options are not supported yet.
  - `RestApi()` writes the `sys_ws_definition`, a `sys_ws_version` per
    version and a `sys_ws_operation` per route, with the route's headers and
    query parameters and their map rows. As in the SDK, a header or parameter
    several routes share by `$id` is written once and must be declared the
    same way each time, a custom namespace applies only to ServiceNow scopes,
    and `$meta` puts every record of the API in its install category.
  - `RestMessage()` writes the message, its headers and a `sys_rest_message_fn`
    per function, keyed by the message and the function name, with the
    function's headers, variables and query parameters. As in the SDK, an
    authentication profile is written only for its authentication type, and
    an unknown authentication type is an error.
  - `ScheduledScript()` evaluates the global `Duration()` and `Time()` helpers
    (or plain objects) and converts its run window and time of day from its
    `timeZone` as SDK 4.13 does; the SDK's schedule checks (required interval,
    days or calendar, date-time formats, a window that allows no run, zone
    mismatches) are errors with the SDK's messages.
  - The Service Portal building blocks write their m2m rows keyed by the SDK's
    coalesce fields: `SPAngularProvider()` one `m2m_sp_ng_pro_sp_ng_pro` row
    per required provider, `SPWidgetDependency()` and `SPTheme()` their css and
    js include rows (order 100 unless given). `CssInclude()` and `JsInclude()`
    take exactly one of a url and a local source, and `SPPageRouteMap()`
    rejects a route to its own page, as the SDK does.
  - `SPWidget()` and `SPHeaderFooter()` write the SDK's script and template
    defaults, `demoData` and `optionSchema` as JSON (option keys in
    snake_case), an `sp_ng_template` per template and their dependency and
    angular provider m2m rows; the SDK's id, client controller and `href="#"`
    checks are errors with its messages.
  - `SPPage()` writes the page (keyed by its page id), then each container,
    its rows, their columns and each column's nested rows and widget
    instances, in the SDK's order and with its defaults (placeholder
    dimensions, script and template included); widget parameters are wrapped
    as `{ value, displayValue }`. `SPMenu()` writes the menu instance and its
    items, each followed by its child items. The SDK's page id, SEO script and
    readable-URL checks are errors with its messages.
  - `ServicePortal()` writes the portal and its search source, knowledge base,
    catalog and taxonomy m2m rows (order 100 unless given, active unless
    `false`), keyed by the SDK's coalesce fields. A `urlSuffix` the SDK would
    normalize is an error; the deprecated `knowledgeBase` and `catalog` are a
    warning on their own and an error next to their arrays, as in the SDK.
  - `Test()` writes the `sys_atf_test` and, for each `atf.<category>.<step>()`
    call of its steps function, a composite `sys_atf_step` file holding the
    step, a `sys_variable_value` per input variable of its step configuration
    (coalesced on step and variable) and a `sys_element_mapping` per input
    that refers to an earlier step's output (`const inserted = atf...;`
    `inserted.record_id`, also inside a template literal), written as the
    SDK's `{{step['<id>'].<output>}}` expression. Unknown categories and steps
    are skipped with the SDK's warnings; a `Duration()` timeout is written
    empty as the SDK does (with a hint), and a value of the wrong shape for
    its input type is an error.
  - `TestSuite()` writes the `sys_atf_test_suite` and a
    `sys_atf_test_suite_test` per test (coalesced on suite and test), ordered
    by position unless an entry pins its `order`, with the SDK's hints for tied
    or out-of-sequence orders and for a `testFilter` beside explicit tests. A
    test or parent is a sys_id or a record; a duplicate test, an invalid
    sys_id and a suite that is its own parent are errors.
  - `UiPage()` writes the `sys_ui_page` keyed by its endpoint (by its name in
    the global scope) and prints the `html` the way the SDK's XML round trip
    does: re-indented elements, numbers and booleans normalised, `&` outside
    a valid entity escaped to `$[AMP]`, and `<sdk:now-ux-globals>` expanded.
    Markup the SDK rejects fails with its message. An included or imported
    `.html` file, a character reference in `<textarea>` content and markup
    the SDK's parser crashes on are not supported yet and are errors.
  - `UiPolicy()` writes its actions (`sys_ui_policy_action`) and related list
    actions (`sys_ui_policy_rl_action`) keyed by the SDK's coalesce fields, and
    runs the SDK's checks: a table outside the app's scope, scripts that import
    modules and malformed related lists are errors; scripts that will not run
    without `runScripts` and actions without effect are hints (the SDK's info).
  - `UxListMenuConfig()` writes its categories, lists and list applicabilities
    (`sys_ux_list_category`, `sys_ux_list`, `sys_ux_applicability_m2m_list`)
    in declaration order; an applicability is an `Applicability()` record or a
    sys_id string.
  - `VariableSet()` writes its variables (the 31 `*Variable()` APIs) as
    `item_option_new`, with `question_choice` rows for the choices of a select
    box or multiple choice and `fx_price` rows for pricing details, and runs
    the SDK's checks: an invalid `internalName`, a second `RequestedForVariable`
    and a variable type a multi-row set cannot hold are errors, as are the
    per-variable checks (`mapToField` without `field`, a required field that
    is read-only or hidden, lookup and reference-qualifier settings, a
    `dependentQuestion` that names no reference variable of the set). A
    variable compiles only inline in `variables`.
  - `CatalogUiPolicy()` (with its `catalog_ui_policy_action` rows) and
    `CatalogClientScript()` name variables as `item.variables.name`
    references or by name, and write them as the SDK's `IO:` references; a
    `catalogCondition` may be an encoded query (prefixed term by term, as the
    SDK does) or a template literal interpolating such references. They run
    the SDK's checks: `catalogItem` and `variableSet` against `appliesTo`, a
    referenced variable against a `const`-bound target, an action's message
    and message type together, and duplicate action variables.
  - `Workspace()` writes the page registry with everything SDK 4.13 derives
    for it: the app config, the unified-navigation category, seven page
    properties and the list, record, home and simple-list pages (screen type,
    route and screen each, plus the record page's macroponent, generated from
    the SDK's template). `listConfig` is a `UxListMenuConfig()` record or a
    sys_id string; `tables` is required, and `defaultRecordOverrides` is not
    supported natively yet.
  - `Sla()` runs the SDK's checks of which fields a duration type, schedule
    source, time-zone source, `whenTo` and `retroactive` setting require or
    ignore: a missing required field is an error, an ignored one a hint. Its
    `duration` must be a `Duration()` helper.
  - `StateModel()` writes the model on `sttrm_model`, or on `chg_model`,
    `prb_model` or `prb_task_model` for a change_request, problem or
    problem_task target, with its user-criteria rows, states (and their
    attributes) and transitions (and their conditions and fields). Attribute and
    condition type names resolve to the SDK's sys_ids; a transition to an
    undefined state, a condition with both `condition` and `conditionScript`, an
    unknown name and a non-GUID approver are errors, and fields the model table
    or a disabled `advancedSecurity` ignores get the SDK's hints.
  - `Table()` takes its schema of column APIs (`StringColumn`, `ChoiceColumn`,
    `ReferenceColumn`, `GenericColumn`, ...). Besides the record updates it
    returns the bootstrap `dictionary/<table>.xml` and, per choice column,
    `author_elective_update/sys_choice_<table>_<column>.xml` in `files`, as
    SDK 4.13 does with the default `now.config.json` table settings; other
    `emitDictionary`, `legacyChoices` or `tableOutputFormat` values are an
    error.
  - `$override` merges raw fields into the record (for a column, into its
    `sys_dictionary` record) as SDK 4.13 does: a field the API already set is
    ignored with a warning, and a framework-managed field (`sys_id`,
    `sys_scope`, `sys_update_name`, `sys_domainpath`) is an error.
  - A top-level `Now.del(table, sysId | keys)` writes a `DELETE` record update
    to `author_elective_update/<table>_<sys_id>.xml`. Coalesce keys take
    strings, records and `Now.ref()`s by sys_id; like the SDK, a deletion by
    keys gets a new sys_id on every build.
  - It reads `now.config.json` and `generated/keys.ts` and assigns sys_ids
    through the keys registry the way SDK 4.13 does.
  - It returns the record updates the SDK build would write, the keys.ts text
    to write back and the diagnostics; it writes no files itself.
  - Anything outside the subset is an error diagnostic, never a silent drop.
  - Like the SDK build, it reports key conflicts as errors: one record defined
    twice (same table and sys_id) and one `$id` used across tables. It then
    returns no keys.ts text, so a conflicting build never rewrites the keys.
  - It warns about table and column names it cannot find. Columns are
    checked against the project's own `Table()` schemas; when the project has
    `@types/syncrona/tables.d.ts` (from `syncrona fluent types --native`),
    table names and inherited columns are checked against it too. The SDK
    accepts any name, so these are warnings, never errors. `Record()` has its
    table and every column its `data` sets checked.
  - It needs only `typescript` (an optional peer dependency), resolved from
    the project first; `FluentTypeScriptMissingError` says when it is missing.
- `nativeBuild(projectDir, options)`: the native `fluent build`. It writes the
  compiler's records plus the `sys_app` scope record and the `package.json` and
  CycloneDX SBOM `sys_module` rows into the app output directory, byte for byte
  as SDK 4.13 does (the SBOM names syncrona as its tool), and writes keys.ts
  back.
  - It refuses what it cannot build yet (server modules, client content,
    `metadata/` XML, runtime policies, a logo file) instead of building an
    incomplete app.
  - A build with errors, or a `frozenKeys` build whose keys.ts would change,
    writes nothing.

## TLS

The UI login, the OAuth token request and the SDK's own requests all use Node's
native `fetch`. When the credential carries `tls` (a client certificate from
`SN_CLIENT_CERT` / `SN_CLIENT_KEY`, a CA bundle from `SYNCRONA_CA_BUNDLE`, or
`SYNCRONA_TLS_REJECT_UNAUTHORIZED=0`), the engine installs a TLS-configured
dispatcher as Node's global fetch dispatcher for the duration of each
instance-side action and restores the previous one afterwards, even when the
action throws. The dispatcher is built from the constructor of Node's default
dispatcher, so no extra dependency is needed; when the default dispatcher is
not an undici `Agent` (a proxy agent, for example), the action fails with
`FluentTlsUnavailableError` instead of silently skipping the TLS settings.
Because the slot is process-global, run one TLS-configured action at a time.

`syncrona fluent run` runs a project script locally and passes it no instance
credential.

## Licensing

This package is GPL-3.0-or-later. It does **not** vendor the ServiceNow SDK,
which ServiceNow publishes under MIT terms and the user installs separately as a
peer dependency; it is never bundled into a published tarball. This package's
own source is original code that calls the SDK's public API, and the SDK's MIT
copyright and permission notice travel with the package the user installs from
npm. If the SDK is ever vendored or bundled, its notice must be added to the
repository `NOTICE` in the same change.
