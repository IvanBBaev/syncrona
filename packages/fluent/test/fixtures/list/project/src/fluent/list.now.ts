import { List, Record, default_view } from '@servicenow/sdk/core'

List({
    table: 'incident',
    view: default_view,
    columns: ['number', 'short_description', 'caller_id.name'],
})

const detailed = Record({
    $id: Now.ID['detailed-view'],
    table: 'sys_ui_view',
    data: { name: 'x_snc_bprobe_detailed', title: 'Detailed View' },
})

List({
    table: 'x_snc_bprobe_expense',
    view: detailed,
    protectionPolicy: 'read',
    columns: [
        { element: 'category', position: 5 },
        { element: 'amount', sum: true, averageValue: true, maxValue: true, minValue: false },
        { element: 'other', max_value: true },
        'date',
    ],
})

List({
    table: 'x_snc_bprobe_sub',
    view: 'x_snc_bprobe_byname',
    parent: 'x_snc_bprobe_task',
    domain: 'mydomain',
    columns: ['short_description'],
})

const rel = Record({
    $id: Now.ID['rel'],
    table: 'sys_relationship',
    data: { name: 'Matched', basic_apply_to: 'x_snc_bprobe_task', basic_query_from: 'x_snc_bprobe_sub' },
})

List({
    table: 'x_snc_bprobe_sub',
    view: default_view,
    parent: 'x_snc_bprobe_task',
    relationship: rel,
    columns: ['state'],
})

List({
    table: 'x_snc_bprobe_sub',
    view: detailed,
    relationship: '0123456789abcdef0123456789abcdef',
    columns: [],
})
