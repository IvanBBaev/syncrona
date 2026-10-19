import '@servicenow/sdk/global'
import { Alias, DataLookup, Record, RetryPolicy } from '@servicenow/sdk/core'

export const rpDefault = RetryPolicy({ $id: Now.ID['rp_default'] })

export const rpHttp = RetryPolicy({
    $id: Now.ID['rp_http'],
    name: 'REST Exponential',
    connectionType: 'http_retry_conditions',
    retryStrategy: 'exponential_backoff',
    count: 5,
    interval: 5,
    condition: 'status_codeIN429,500',
    restrictTo: ['status_code', 'error'],
})

export const rpAfter = RetryPolicy({
    $id: Now.ID['rp_after'],
    name: 'Retry After',
    retryStrategy: 'retry_after',
    maxElapsedTime: 120,
    restrictTo: [],
    protectionPolicy: 'read',
})

export const rpJdbc = RetryPolicy({
    $id: Now.ID['rp_jdbc'],
    name: 'JDBC',
    connectionType: 'jdbc_retry_conditions',
    count: 3,
    interval: 10,
})

export const aliasMin = Alias({ $id: Now.ID['alias_min'], name: 'Min Alias' })

export const aliasFull = Alias({
    $id: Now.ID['alias_full'],
    name: 'Full Alias',
    type: 'connection',
    connectionType: 'jdbcConnection',
    description: 'A JDBC alias',
    parent: aliasMin,
    retryPolicy: rpJdbc,
    configurationTemplate: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    multipleConnections: true,
})

export const aliasCred = Alias({
    $id: Now.ID['alias_cred'],
    name: 'Cred Alias',
    type: 'credential',
    parent: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    retryPolicy: 'cccccccccccccccccccccccccccccccc',
})

export const parentRecord = Record({
    $id: Now.ID['alias_rec'],
    table: 'sys_alias',
    data: { name: 'Record alias', type: 'connection' },
})

export const aliasRecParent = Alias({
    $id: Now.ID['alias_rec_parent'],
    name: 'Record Parent',
    parent: parentRecord,
})

export const dlMin = DataLookup({
    $id: Now.ID['dl_min'],
    name: 'Min Lookup',
    sourceTable: 'x_snc_bprobe_src',
    matcherTable: 'x_snc_bprobe_matcher',
})

export const dlFull = DataLookup({
    $id: Now.ID['dl_full'],
    name: 'Full Lookup',
    sourceTable: 'x_snc_bprobe_src',
    matcherTable: 'x_snc_bprobe_matcher',
    active: false,
    protectionPolicy: 'protected',
    runOnInsert: false,
    runOnUpdate: true,
    runOnFormChange: false,
    matchRules: [
        { $id: Now.ID['dl_m1'], sourceField: 'impact', matcherField: 'impact' },
        { $id: Now.ID['dl_m2'], sourceField: 'urgency', matcherField: 'urgency', exactMatch: true },
    ],
    setRules: [
        { $id: Now.ID['dl_s1'], targetField: 'priority', matcherField: 'priority', alwaysReplace: true },
        { $id: Now.ID['dl_s2'], targetField: 'state', matcherField: 'state' },
    ],
})

export const aliasOdd = Alias({
    $id: Now.ID['alias_odd'],
    name: ' Odd-name.v2 ',
    type: 'credential',
    connectionType: 'basicConnection',
    multipleConnections: false,
    protectionPolicy: 'read',
})

export const aliasJms = Alias({ $id: Now.ID['alias_jms'], name: 'JMS', connectionType: 'jmsConnection' })

export const aliasBasic = Alias({ $id: Now.ID['alias_basic'], name: 'Basic', connectionType: 'basicConnection' })
