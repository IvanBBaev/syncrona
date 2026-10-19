import { InboundEmailAction, Role } from '@servicenow/sdk/core'

export const r = Role({ $id: Now.ID['r1'], name: 'x_snc_bprobe.mailer' })

InboundEmailAction({
    $id: Now.ID['iea_min'],
    action: 'reply_email',
})

InboundEmailAction({
    $id: Now.ID['iea_full'],
    name: 'Create incident & <go>',
    description: 'Full',
    table: 'incident',
    type: 'reply',
    action: 'record_action',
    active: true,
    order: 50,
    eventName: 'email.custom',
    stopProcessing: true,
    conditionScript: 'email.subject != ""',
    filterCondition: 'subjectLIKEhelp^EQ',
    from: '6816f79cc0a8016401c5a33be04be441',
    requiredRoles: ['admin', r, 'admin'],
    script: 'current.short_description = email.subject;\ncurrent.insert();',
    fieldAction: 'short_description=x^EQ',
    assignmentOperator: '=',
    replyEmail: '<p>Thanks</p>',
})

InboundEmailAction({
    $id: Now.ID['iea_reply'],
    name: 'Reply',
    action: 'reply_email',
    from: '',
    requiredRoles: [],
})
