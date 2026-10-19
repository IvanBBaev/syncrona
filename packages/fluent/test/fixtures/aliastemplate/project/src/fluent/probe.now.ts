import '@servicenow/sdk/global'
import { AliasTemplate, Record } from '@servicenow/sdk/core'

export const minimal = AliasTemplate({
    $id: Now.ID['minimal-template'],
    name: 'Minimal Template',
    dynamicDataSchema: {
        connectionFields: [{ name: 'connectionUrl', label: 'Base URL', type: 'text', mandatory: true }],
        credentialFields: [],
    },
    defaultDataTemplate: {
        connection: { table: 'http_connection', name: 'Minimal Connection' },
    },
})

export const testAction = Record({
    $id: Now.ID['test-action'],
    table: 'sys_hub_action_type_definition',
    data: { name: 'Test connection' },
})

export const full = AliasTemplate({
    $id: Now.ID['full-template'],
    name: 'Full <Template> & "quotes"',
    dynamicDataSchema: {
        connectionFields: [
            { name: 'connectionUrl', label: 'Base URL', type: 'text', mandatory: true, hint: 'https://…', defaultValue: 'https://api.example.com' },
            { name: 'port', type: 'number', defaultValue: 443 },
            { name: 'useMid', type: 'checkbox', defaultValue: false },
            {
                name: 'auth',
                label: 'Auth',
                type: 'radio',
                groups: [
                    { name: 'basic', label: 'Basic', defaultGroup: true, fields: [{ name: 'userName', type: 'text' }] },
                    { name: 'key', label: 'Key', fields: [{ name: 'apiKey', type: 'password' }] },
                ],
            },
            { name: 'region', type: 'choice', choices: ['eu', { name: 'us', label: 'United States' }] },
            { name: 'owner', type: 'reference', table: 'sys_user', query: 'active=true' },
        ],
        credentialFields: [{ name: 'password', label: 'Password', type: 'password', mandatory: true }],
        additionalFields: [{ name: 'notes', type: 'text' }],
    },
    defaultDataTemplate: {
        connection: {
            table: 'http_connection',
            name: 'Full Connection',
            useMid: true,
            connectionUrl: 'https://api.example.com',
            host: 'api.example.com',
            customField: 'kept',
            nested: { connectionUrl: 'converted', useMid: false, otherKey: null },
        },
        credential: { table: 'basic_auth_credentials', name: 'Full Credential', userName: 'admin' },
        additional: { list: [1, null, 'two', true], top: null, emptyObject: {}, emptyArray: [] },
    },
    preEditScript: 'return [];',
    onEditScript: Now.include('./scripts/on-edit.js'),
    postProcessScript: `gs.info("done & <ok>");\n`,
    testAction: testAction,
    protectionPolicy: 'read',
})

export const byId = AliasTemplate({
    $id: Now.ID['by-id-template'],
    name: 'By Id',
    dynamicDataSchema: { connectionFields: [], credentialFields: [] },
    defaultDataTemplate: {},
    preEditScript: '',
    testAction: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
})

// @ts-expect-error schemas are required
export const bare = AliasTemplate({
    $id: Now.ID['bare-template'],
    name: 'Bare',
})
