import { ScriptInclude, Property, Role } from '@servicenow/sdk/core'

ScriptInclude({ $id: Now.ID['si_min'], name: 'MinSI', script: `var MinSI = function() {};` })
ScriptInclude({
    $id: Now.ID['si_full'],
    name: 'FullSI',
    active: false,
    accessibleFrom: 'public',
    callerAccess: 'tracking',
    apiName: 'x_snc_bprobe.FullSI',
    clientCallable: true,
    description: 'Full <desc> & "quotes"',
    mobileCallable: true,
    protectionPolicy: 'read',
    sandboxCallable: true,
    script: Now.include('../server/si/Included.server.js'),
})
ScriptInclude({ $id: 'si_plain_id', name: 'PlainIdSI', script: 'var PlainIdSI = 1;', $meta: { installMethod: 'demo' } })
ScriptInclude({ $id: 42, name: 'NumIdSI', script: 'var NumIdSI = 1;', $meta: { installMethod: 'first install' } })

Property({ $id: Now.ID['p_min'], name: 'x_snc_bprobe.min' })
Property({ $id: Now.ID['p_bool'], name: 'x_snc_bprobe.flag', type: 'boolean', value: true, description: 'A flag', ignoreCache: true, isPrivate: true })
Property({ $id: Now.ID['p_int'], name: 'x_snc_bprobe.count', type: 'integer', value: 7 })
Property({ $id: Now.ID['p_choice'], name: 'x_snc_bprobe.choice', type: 'choicelist', choices: ['a', 'b', 'c'], value: 'b', roles: { read: ['itil'], write: ['admin', 'x_snc_bprobe.manager'] } })

const user = Role({ name: 'x_snc_bprobe.user' })
const manager = Role({
    name: 'x_snc_bprobe.manager',
    assignableBy: 'admin',
    canDelegate: false,
    containsRoles: [user, 'itil'],
    description: 'Manager role',
    elevatedPrivilege: true,
    federatedId: 'fed-1',
    grantable: false,
    scopedAdmin: true,
})
