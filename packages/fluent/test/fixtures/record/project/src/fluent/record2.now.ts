import { Record } from '@servicenow/sdk/core'
import { manager } from './record.now'

export const ua = Record({
    $id: Now.ID['rec_ua2'],
    table: 'sys_ui_action',
    data: { name: 'Two', table: 'incident' },
})

Record({
    $id: Now.ID['rec_ua2_role'],
    table: 'sys_ui_action_role',
    data: { sys_ui_action: ua, sys_user_role: 'itil' },
})

Record({
    $id: Now.ID['rec_ua2_role_obj'],
    table: 'sys_ui_action_role',
    data: { sys_ui_action: ua, sys_user_role: manager },
})

Record({
    $id: Now.ID['rec_ua2_view'],
    table: 'sys_ui_action_view',
    data: { sys_ui_action: ua, sys_ui_view: 'Default view' },
})

Record({
    $id: Now.ID['rec_ua2_view2'],
    table: 'sys_ui_action_view',
    data: { sys_ui_action: ua, sys_ui_view: 'mobile' },
})

Record({
    $id: Now.ID['rec_role'],
    table: 'sys_user_role',
    data: { name: 'x_snc_bprobe.via_record', description: 'Via Record()' },
})

Record({
    $id: Now.ID['rec_contains'],
    table: 'sys_user_role_contains',
    data: { role: 'x_snc_bprobe.via_record', contains: 'itil' },
})

Record({
    $id: Now.ID['rec_edge'],
    table: 'x_snc_bprobe_thing',
    data: {
        multi: 'line one\nline two',
        special: 'a < b & c > d "q" \'s\'',
        tpl: `templated`,
        nul: null,
        nums: [1, 2],
        role_by_guid: Now.ref('sys_user_role', '2831a114c611228501d4ea6c309d626d'),
    },
})
