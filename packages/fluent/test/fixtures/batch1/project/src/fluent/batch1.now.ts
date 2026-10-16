import { ScriptInclude, Property, Role, Acl, BusinessRule, ClientScript, UiAction } from '@servicenow/sdk/core'

ScriptInclude({ $id: Now.ID['si_min'], name: 'MinSI', script: `var MinSI = function() {};` })
ScriptInclude({
    $id: Now.ID['si_full'],
    name: 'FullSI',
    active: false,
    accessibleFrom: 'public',
    callerAccess: 'tracking',
    apiName: 'x_snc_bprobe.FullSI',
    clientCallable: true,
    description: 'Full <desc> & "quotes"',
    mobileCallable: true,
    protectionPolicy: 'read',
    sandboxCallable: true,
    script: Now.include('../server/si/Included.server.js'),
})
ScriptInclude({ $id: 'si_plain_id', name: 'PlainIdSI', script: 'var PlainIdSI = 1;', $meta: { installMethod: 'demo' } })
ScriptInclude({ $id: 42, name: 'NumIdSI', script: 'var NumIdSI = 1;', $meta: { installMethod: 'first install' } })

Property({ $id: Now.ID['p_min'], name: 'x_snc_bprobe.min' })
Property({ $id: Now.ID['p_bool'], name: 'x_snc_bprobe.flag', type: 'boolean', value: true, description: 'A flag', ignoreCache: true, isPrivate: true })
Property({ $id: Now.ID['p_int'], name: 'x_snc_bprobe.count', type: 'integer', value: 7 })
Property({ $id: Now.ID['p_choice'], name: 'x_snc_bprobe.choice', type: 'choicelist', choices: ['a', 'b', 'c'], value: 'b', roles: { read: ['itil'], write: ['admin', 'x_snc_bprobe.manager'] } })

const user = Role({ name: 'x_snc_bprobe.user' })
const manager = Role({
    name: 'x_snc_bprobe.manager',
    assignableBy: 'admin',
    canDelegate: false,
    containsRoles: [user, 'itil'],
    description: 'Manager role',
    elevatedPrivilege: true,
    federatedId: 'fed-1',
    grantable: false,
    scopedAdmin: true,
})

Acl({ $id: Now.ID['acl_min'], type: 'record', table: 'incident', operation: 'read' })
Acl({
    $id: Now.ID['acl_full'],
    type: 'record',
    table: 'incident',
    field: 'short_description',
    operation: 'write',
    active: false,
    adminOverrides: false,
    condition: 'active=true^EQ',
    decisionType: 'deny',
    description: 'Full ACL',
    protectionPolicy: 'protected',
    roles: [manager, 'itil', { role: user, protectionPolicy: 'read' }],
    script: 'answer = true;',
    appliesTo: 'priority=1',
})
Acl({ $id: Now.ID['acl_rest'], type: 'rest_endpoint', name: 'x_snc_bprobe/api', operation: 'execute', roles: ['admin'] })

BusinessRule({ $id: Now.ID['br_min'], name: 'MinBR', table: 'incident' })
BusinessRule({
    $id: Now.ID['br_full'],
    name: 'FullBR',
    table: 'incident',
    abortAction: true,
    access: 'public',
    action: ['insert', 'update', 'delete', 'query'],
    active: false,
    addMessage: true,
    changeFields: true,
    clientCallable: true,
    condition: 'current.active == true',
    description: 'Full BR',
    executeFunction: true,
    filterCondition: 'priority=1^EQ',
    message: 'Hello',
    order: 50,
    priority: 10,
    protectionPolicy: 'protected',
    roleConditions: ['itil', manager],
    script: `(function executeRule(current, previous) {
    gs.info('x');
})(current, previous);`,
    setFieldValue: 'state=2^EQ',
    when: 'before',
})

ClientScript({ $id: Now.ID['cs_min'], name: 'MinCS', table: 'incident' })
ClientScript({
    $id: Now.ID['cs_full'],
    name: 'FullCS',
    table: 'incident',
    order: 5,
    active: false,
    appliesExtended: true,
    description: 'Full CS',
    field: 'state',
    global: false,
    view: 'ess',
    isolateScript: true,
    messages: 'msg1\nmsg2',
    protectionPolicy: 'read',
    script: 'function onChange(control, oldValue, newValue, isLoading) {}',
    type: 'onChange',
    uiType: 'mobile_or_service_portal',
})

UiAction({ $id: Now.ID['ua_min'], name: 'MinUA', table: 'incident' })
UiAction({
    $id: Now.ID['ua_full'],
    name: 'FullUA',
    table: 'incident',
    actionName: 'full_ua',
    active: false,
    client: { isClient: true, isUi11Compatible: true, isUi16Compatible: true, onClick: 'doIt()' },
    comments: 'internal',
    condition: 'current.active',
    excludeFromViews: ['ess'],
    includeInViews: ['default', 'itil'],
    form: { iconName: 'star', showButton: true, showContextMenu: true, showIconOnly: false, showLink: true, style: 'primary' },
    hint: 'Do it',
    isolateScript: true,
    list: { iconName: 'list', showBannerButton: true, showButton: true, showContextMenu: true, showIconOnly: true, showLink: true, showListChoice: true, showSaveWithFormButton: true, style: 'destructive' },
    messages: ['m1', 'm2'],
    order: 300,
    protectionPolicy: 'read',
    roles: ['itil', manager],
    script: 'function doIt() {}',
    showInsert: true,
    showMultipleUpdate: true,
    showQuery: true,
    showUpdate: false,
    workspace: { clientScriptV2: 'function onClick(g_form) {}', isConfigurableWorkspace: true, showFormButtonV2: true, showFormMenuButtonV2: true },
})
