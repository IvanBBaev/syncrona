import { ApplicationMenu, CrossScopePrivilege, Role, StringColumn, Table, UiPolicy, UserPreference } from '@servicenow/sdk/core'

export const x_snc_bprobe_ui = Table({
    name: 'x_snc_bprobe_ui',
    schema: {
        short_description: StringColumn({ label: 'Short description' }),
        description: StringColumn({ label: 'Description' }),
        caller_id: StringColumn({ label: 'Caller' }),
    },
})

export const menuRole = Role({ name: 'x_snc_bprobe.menu_user' })

CrossScopePrivilege({
    $id: Now.ID['csp_exec'],
    operation: 'execute',
    status: 'allowed',
    targetName: 'GlideQuery',
    targetScope: 'global',
    targetType: 'sys_script_include',
})

CrossScopePrivilege({
    $id: Now.ID['csp_read'],
    operation: 'read',
    status: 'requested',
    targetName: 'cmdb_ci_computer',
    targetScope: 'global',
    targetType: 'sys_db_object',
    protectionPolicy: 'read',
    $meta: { installMethod: 'demo' },
})

UserPreference({
    $id: Now.ID['pref_min'],
    name: 'x_snc_bprobe.min',
    type: 'string',
    value: 'hello',
})

UserPreference({
    $id: Now.ID['pref_full'],
    name: 'x_snc_bprobe.size',
    type: 'integer',
    value: 20,
    description: 'Page size',
    system: true,
})

UserPreference({
    $id: Now.ID['pref_bool'],
    name: 'x_snc_bprobe.flag',
    type: 'boolean',
    value: false,
})

ApplicationMenu({
    $id: Now.ID['menu_min'],
    title: 'Probe Menu',
})

ApplicationMenu({
    $id: Now.ID['menu_full'],
    title: 'Probe Full Menu',
    active: false,
    category: 'b6a0b4c9c0a8016400b98a06818d57c7',
    description: 'All the things',
    hint: 'Hover text',
    name: 'probe_full',
    order: 300,
    roles: [menuRole, 'admin'],
    protectionPolicy: 'protected',
})

UiPolicy({
    $id: Now.ID['uip_min'],
    shortDescription: 'Minimal policy',
})

UiPolicy({
    $id: Now.ID['uip_full'],
    table: 'x_snc_bprobe_ui',
    shortDescription: 'Full policy',
    active: false,
    conditions: 'priority=1^EQ',
    description: 'Long description',
    global: false,
    view: 'ess',
    inherit: true,
    isolateScript: false,
    onLoad: false,
    order: 200,
    reverseIfFalse: false,
    runScripts: true,
    scriptTrue: 'function onCondition() { g_form.addInfoMessage("t"); }',
    scriptFalse: 'function onCondition() { g_form.addInfoMessage("f"); }',
    uiType: 'all',
    actions: [
        { field: 'short_description', mandatory: true, visible: true, readOnly: 'ignore' },
        { field: 'description', cleared: true, readOnly: true, value: 'x', fieldMessage: 'Look', fieldMessageType: 'warning', valueAction: 'set', table: 'x_snc_bprobe_ui' },
        { field: 'caller_id' },
    ],
    relatedListActions: [
        { list: 'x_snc_bprobe_ui.caller_id', visible: false },
        { list: 'b9b7e1a0c0a8016400b98a06818d57c7', visible: 'ignore' },
    ],
})
