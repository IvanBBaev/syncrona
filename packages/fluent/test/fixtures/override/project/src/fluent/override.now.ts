import '@servicenow/sdk/global'
import { Acl, BusinessRule, ClientScript, Property, Role, ScriptInclude, StringColumn, Table, UiAction } from '@servicenow/sdk/core'

export const ovrRole = Role({
    name: 'x_snc_bprobe.ovr',
    $override: { grantable: false, weight: 7, description: 'from override', u_custom: '' },
})

BusinessRule({
    $id: Now.ID['br_override'],
    name: 'Override BR',
    table: 'incident',
    when: 'before',
    action: ['update'],
    $override: {
        sys_domain: 'global',
        order: 999,
        condition: 'current.active',
        filter_condition: 'active=true',
        message: 'm',
        rest_method: 'r',
        role_conditions: 'admin',
        sys_policy: 'read',
        template: 't',
        description: 'd',
        x_snc_bprobe_flag: true,
    },
})

ScriptInclude({
    $id: Now.ID['si_override'],
    name: 'OvrSI',
    script: Now.include('../server/ovr.server.js'),
    protectionPolicy: 'read',
    $override: { sys_name: 'Custom name', sys_policy: 'protected', sys_class_name: 'sys_script_include', caller_access: '1', description: 'd', x_snc_bprobe_flag: 0 },
})

ClientScript({
    $id: Now.ID['cs_override'],
    name: 'Ovr CS',
    table: 'incident',
    type: 'onLoad',
    script: 'function onLoad() {}',
    $override: { description: 'd', messages: 'm', field: 'state', view: 'ess', u_n: 2.5 },
})

Acl({
    $id: Now.ID['acl_override'],
    type: 'record',
    table: 'incident',
    operation: 'read',
    roles: [ovrRole],
    $override: { applies_to: 'a', condition: 'active=true', description: 'd', script: 's', security_attribute: 'x', advanced: true, sys_domain: 'top' },
})

Property({
    $id: Now.ID['prop_override'],
    name: 'x_snc_bprobe.ovr_prop',
    value: 'v',
    $override: { private: true, choices: 'a,b', description: 'd', read_roles: 'admin', write_roles: 'admin', is_private: true },
})

UiAction({
    $id: Now.ID['ua_override'],
    name: 'Ovr UA',
    table: 'incident',
    $override: { action_name: 'a', comments: 'c', condition: 'x', hint: 'h', onclick: 'o()', script: 's', sys_overrides: 'abc', sys_domain: 'abc', u_x: 1.5, order: 5 },
})

export const x_snc_bprobe_ovr = Table({
    name: 'x_snc_bprobe_ovr',
    label: 'Ovr',
    schema: {
        title: StringColumn({ label: 'Title', $override: { u_col: 'c', attributes: 'x=y', sizeclass: '3', max_length: 7, comments: 'col' } }),
    },
    $override: { u_tab: 'x', caller_access: '2', number_ref: 'n', user_role: 'r', super_class: 'abc', sys_domain: 'd' },
})

Now.del('sys_script', 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6')
Now.del('sys_user_role', { name: 'x_snc_bprobe.old_role' })
Now.del('sys_ui_policy_action', { ui_policy: 'abc', field: 'x' })
Now.del('sys_user_role_contains', { role: ovrRole as any, contains: Now.ref('sys_user_role', 'b1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6') })
