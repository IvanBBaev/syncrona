import '@servicenow/sdk/global'
import { Table, StringColumn, IntegerColumn, BooleanColumn, ReferenceColumn, ChoiceColumn, DateTimeColumn } from '@servicenow/sdk/core'

export const x_snc_bprobe_task = Table({
    name: 'x_snc_bprobe_task',
    label: 'Probe Task',
    display: 'title',
    extensible: true,
    schema: {
        title: StringColumn({ label: 'Title', maxLength: 100, mandatory: true }),
        priority: IntegerColumn({ label: 'Priority', default: 3 }),
        done: BooleanColumn({ label: 'Done' }),
        owner: ReferenceColumn({ label: 'Owner', referenceTable: 'sys_user' }),
        state: ChoiceColumn({
            label: 'State',
            dropdown: 'dropdown_with_none',
            choices: {
                open: { label: 'Open', sequence: 0 },
                closed: { label: 'Closed', sequence: 1 },
            },
        }),
        due: DateTimeColumn({ label: 'Due' }),
        notes: StringColumn({}),
    },
})

export const x_snc_bprobe_child = Table({
    name: 'x_snc_bprobe_child',
    extends: 'task',
    schema: {
        weight: IntegerColumn({ label: 'Weight', readOnly: true, attributes: { edge_encryption_enabled: true } }),
    },
})
