import { DataPolicy, Table, StringColumn } from '@servicenow/sdk/core'

export const x_snc_bprobe_dp = Table({
    name: 'x_snc_bprobe_dp',
    schema: {
        code: StringColumn({ label: 'Code' }),
        note: StringColumn({ label: 'Note' }),
    },
})

DataPolicy({
    $id: Now.ID['dp_min'],
    table: 'x_snc_bprobe_dp',
})

DataPolicy({
    $id: Now.ID['dp_full'],
    table: 'x_snc_bprobe_dp',
    shortDescription: 'Code & <note>',
    active: false,
    applyToImportSets: false,
    applyToSOAP: false,
    conditions: 'code=A^EQ',
    description: 'Full',
    useAsUiPolicyOnClient: false,
    inherit: true,
    modelId: 'm1',
    reverseIfFalse: false,
    rules: {
        code: { $id: Now.ID['dp_rule_code'], mandatory: true },
        note: { $id: Now.ID['dp_rule_note'], readOnly: true, mandatory: false },
        short_description: { $id: 7, table: 'task', readOnly: 'ignore' },
        number: { $id: 'dp_rule_number' },
    },
})
