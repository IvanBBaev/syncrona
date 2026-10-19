import { ChoiceSet, Table, StringColumn } from '@servicenow/sdk/core'

export const x_snc_bprobe_ticket = Table({
    name: 'x_snc_bprobe_ticket',
    extends: 'task',
    schema: {
        kind: StringColumn({ label: 'Kind' }),
    },
})

ChoiceSet({
    table: 'x_snc_bprobe_ticket',
    field: 'priority',
    choices: {
        1: 'Critical',
        2: 'High',
        low: 'Low & <slow>',
    },
})

ChoiceSet({
    table: 'x_snc_bprobe_ticket',
    field: 'state',
    choices: {
        10: { label: 'Pending', sequence: 10 },
        11: { label: 'Running', hint: 'In flight', inactive: true, inactiveOnUpdate: true, synonyms: ['busy', 'active'] },
        12: [
            { label: 'Done', sequence: 12, language: 'en' },
            { label: 'Fertig', sequence: 12, language: 'de', dependentValue: 3 },
        ],
        13: { label: 'Failed', dependentValue: 'x' },
    },
})
