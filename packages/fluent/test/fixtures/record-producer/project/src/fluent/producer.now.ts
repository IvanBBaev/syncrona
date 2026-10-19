import {
    CatalogItemRecordProducer,
    VariableSet,
    SingleLineTextVariable,
    ReferenceVariable,
    RequestedForVariable,
    Table,
    StringColumn,
    Role,
} from '@servicenow/sdk/core'

CatalogItemRecordProducer({
    $id: Now.ID['rp_min'],
    name: 'Minimal Producer',
    table: 'incident',
})

export const x_snc_bprobe_ticket = Table({
    name: 'x_snc_bprobe_ticket',
    schema: {
        summary: StringColumn({ label: 'Summary' }),
        detail: StringColumn({ label: 'Detail' }),
    },
})

const approver = Role({ $id: Now.ID['rp_role'], name: 'x_snc_bprobe.approver' })

const vs = VariableSet({
    $id: Now.ID['rp_vs'],
    title: 'Producer Set',
    variables: {
        who: RequestedForVariable({ question: 'Who' }),
    },
})

CatalogItemRecordProducer({
    $id: Now.ID['rp_full'],
    name: 'Full & <Producer>',
    table: x_snc_bprobe_ticket,
    shortDescription: 'Short',
    active: false,
    view: 'aaaabbbbccccddddeeeeffff00001111',
    availability: 'both',
    roles: [approver],
    catalogs: ['e0d08b13c3330100c8b837659bba8fb4'],
    categories: ['d258b953c611227a0146101fb1be7c31'],
    variableSets: [{ variableSet: vs, order: 200 }],
    allowEdit: true,
    canCancel: true,
    redirectUrl: 'catalogHomePage',
    saveOptions: 'opt',
    script: 'current.short_description = producer.summary;',
    postInsertScript: 'gs.info("after");',
    saveScript: 'gs.info("save");',
    variables: {
        summary: SingleLineTextVariable({ question: 'Summary', order: 100, mapToField: true, field: 'summary' }),
        detail: SingleLineTextVariable({ question: 'Detail', order: 200, mapToField: true, field: 'detail' }),
        caller: ReferenceVariable({ question: 'Caller', referenceTable: 'sys_user', order: 300, dependentQuestion: 'who' }),
    },
})

CatalogItemRecordProducer({
    $id: Now.ID['rp_other'],
    name: 'Other',
    table: 'incident',
    redirectUrl: 'generatedRecord',
    variables: {
        a: SingleLineTextVariable({ question: 'A' }),
    },
})
