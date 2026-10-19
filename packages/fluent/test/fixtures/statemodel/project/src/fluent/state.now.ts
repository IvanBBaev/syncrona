import { StateModel, Record, Role } from '@servicenow/sdk/core'

const approver = Role({ $id: Now.ID['approver'], name: 'x_snc_bprobe.approver' })
const crit = Record({ $id: Now.ID['crit'], table: 'user_criteria', data: { name: 'Crit' } })
const user = Record({ $id: Now.ID['user'], table: 'sys_user', data: { user_name: 'probe.user' } })

export const base = StateModel({
    $id: Now.ID['base'],
    name: 'Base model',
    table: 'x_snc_bprobe_t',
    advancedSecurity: true,
    readRoles: ['itil', approver],
    writeRoles: [approver],
    availableFor: [crit, '0c441abbc6112275000025157c651c89'],
    writableFor: [crit],
    notAvailableFor: ['0c441abbc6112275000025157c651c89'],
    templateProposalAccess: 'write',
    templateApprovalUsers: [user, '6816f79cc0a8016401c5a33be04be441'],
    templateApprovalGroups: ['477a05d153013010b846ddeeff7b1225'],
    states: {
        new: { $id: Now.ID['s-new'], label: 'New', value: 1, sequence: 1, initial: true, attributes: [{ $id: Now.ID['a1'], attribute: 'allowImplementation' }, { $id: Now.ID['a2'], attribute: '9fbfd18affa431107f54ffffffffff03', active: false }] },
        work: { $id: Now.ID['s-work'], label: 'Work in Progress', value: '2' },
        done: { $id: Now.ID['s-done'], label: 'Done', value: 3, sequence: 3 },
    },
    transitions: [
        {
            $id: Now.ID['t1'],
            from: 'new',
            to: 'work',
            conditions: [
                { $id: Now.ID['c1'], name: 'Assigned', condition: 'assigned_toISNOTEMPTY^EQ', conditionType: 'Transition Condition', fields: [{ $id: Now.ID['f1'], name: 'assigned_to' }] },
                { $id: Now.ID['c2'], name: 'Scripted', conditionScript: '(function (current) {\n    return true;\n})(current);', conditionType: 'Transition Script', active: false, order: 200, description: 'A script' },
            ],
        },
        { $id: Now.ID['t2'], from: 'work', to: 'done', automatic: true },
    ],
})

export const minimal = StateModel({ $id: Now.ID['min'], name: 'Minimal', table: 'x_snc_bprobe_t' })

export const chg = StateModel({
    $id: Now.ID['chg'],
    name: 'Change model',
    table: 'change_request',
    availableInUI: false,
    recordPreset: 'type=normal^EQ',
    color: 'blue',
    itilChangeProcess: 'normal',
    defaultModel: true,
    description: 'A change model',
})

export const chgMin = StateModel({ $id: Now.ID['chgmin'], name: 'Change min', table: 'change_request' })

export const prb = StateModel({ $id: Now.ID['prb'], name: 'Problem model', table: 'problem', description: 'P' })

export const prbTask = StateModel({ $id: Now.ID['prbtask'], name: 'Problem task model', table: 'problem_task', taskType: 'rca', defaultModel: false })
