import { DatabaseView } from '@servicenow/sdk/core'

DatabaseView({
    name: 'x_snc_bprobe_basic',
    tables: [{ $id: Now.ID['basic-table'], table: 'incident', variablePrefix: 'inc' }],
})

DatabaseView({
    name: 'x_snc_bprobe_full',
    label: 'Full View',
    plural: 'Full Views',
    description: 'Joins incidents & users <b>',
    protectionPolicy: 'read',
    tables: [
        {
            $id: Now.ID['full-inc'],
            table: 'incident',
            variablePrefix: 'inc',
            order: 100,
            fields: [
                { $id: Now.ID['full-inc-number'], field: 'number' },
                { $id: Now.ID['full-inc-caller'], field: 'caller_id' },
            ],
        },
        {
            $id: Now.ID['full-usr'],
            table: 'sys_user',
            variablePrefix: 'usr',
            order: 200,
            leftJoin: true,
            active: false,
            whereClause: 'inc_caller_id=usr_sys_id',
            fields: [{ $id: Now.ID['full-usr-name'], field: 'name' }],
        },
    ],
})

DatabaseView({ name: 'x_snc_bprobe_empty', tables: [] })
