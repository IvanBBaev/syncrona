import { ColumnTypeCheck, LinterCheck, ScriptOnlyCheck, TableCheck } from '@servicenow/sdk/core'

TableCheck({
    $id: Now.ID['tc_min'],
    name: 'Inactive Users',
    category: 'security',
    priority: '2',
    shortDescription: 'Inactive users with roles',
    table: 'sys_user',
    conditions: 'active=false^roles!=',
})
TableCheck({
    $id: Now.ID['tc_full'],
    name: 'Large <Attachments> & more',
    active: false,
    category: 'performance',
    priority: '3',
    shortDescription: 'Oversized attachments',
    description: 'Finds big files',
    resolutionDetails: 'Delete them',
    documentationUrl: 'https://example.com/doc',
    scoreMin: 5,
    scoreMax: 50,
    scoreScale: 2,
    runCondition: 'active=true',
    findingType: 'scan_finding',
    table: 'sys_attachment',
    advanced: true,
    useManifest: true,
    script: Now.include('../server/scan/table.server.js'),
    $meta: { installMethod: 'demo' },
})
ColumnTypeCheck({
    $id: Now.ID['ct_min'],
    name: 'Script columns',
    category: 'manageability',
    priority: '4',
    shortDescription: 'Checks script columns',
    columnType: 'script',
    script: `(function (engine, current, columnValue) { if (columnValue.indexOf('eval(') > -1) engine.finding.increment() })(engine, current, columnValue)`,
})
ColumnTypeCheck({
    $id: Now.ID['ct_bare'],
    name: 'Bare column check',
    category: 'upgradability',
    priority: '1',
    shortDescription: 'Bare',
    columnType: 'html',
})
LinterCheck({
    $id: Now.ID['lc_min'],
    name: 'No gs.log',
    category: 'manageability',
    priority: '3',
    shortDescription: 'Avoid gs.log',
    script: `(function (engine) { engine.rootNode.visit(function (node) {}) })(engine)`,
})
ScriptOnlyCheck({
    $id: Now.ID['so_min'],
    name: 'Script only',
    category: 'user_experience',
    priority: '2',
    shortDescription: 'Script only check',
    description: 'desc',
    script: `(function (engine) { engine.finding.increment() })(engine)`,
    $meta: { installMethod: 'first install' },
})
ScriptOnlyCheck({
    $id: 'so_explicit_guid_0000000000000001',
    name: 'Explicit id',
    category: 'security',
    priority: '1',
    shortDescription: 'Explicit',
})
