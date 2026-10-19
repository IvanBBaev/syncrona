import { Record, Role } from '@servicenow/sdk/core'

export const manager = Role({ $id: Now.ID['role_mgr'], name: 'x_snc_bprobe.manager' })

export const plain = Record({
    $id: Now.ID['rec_plain'],
    table: 'x_snc_bprobe_thing',
    data: {
        name: 'Plain thing',
        active: true,
        inactive: false,
        count: 42,
        ratio: 1.5,
        negative: -3,
        empty: '',
        tags: ['a', 'b', 'c'],
        script: Now.include('./thing.js'),
        nothing: undefined,
    },
})

Record({
    $id: Now.ID['rec_refs'],
    table: 'x_snc_bprobe_thing',
    data: {
        name: 'Refs',
        parent: plain,
        owner_role: manager,
        other: Now.ref('sys_user_group', { name: 'CAB Approval' }),
        guid_ref: Now.ref('sys_user', '5137153cc611227c000bbd1bd8cd2005'),
    },
})

Record({
    $id: Now.ID['rec_demo'],
    table: 'x_snc_bprobe_thing',
    $meta: { installMethod: 'demo' },
    data: { name: 'Demo thing' },
})

Record({
    $id: '0123456789abcdef0123456789abcdef',
    table: 'x_snc_bprobe_thing',
    data: { name: 'Guid id' },
})

Record({
    $id: Now.ID['rec_prop'],
    table: 'sys_properties',
    data: { name: 'x_snc_bprobe.via_record', value: 'v', type: 'string' },
})

Record({
    $id: Now.ID['rec_ua'],
    table: 'sys_ui_action',
    data: { name: 'Do', table: 'incident'},
})

Record({
    $id: Now.ID['rec_role_ref'],
    table: 'sys_user_has_role',
    data: { role: 'admin', user: '6816f79cc0a8016401c5a33be04be441' },
})
