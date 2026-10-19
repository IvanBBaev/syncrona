import { RestMessage } from '@servicenow/sdk/core'

RestMessage({
    $id: Now.ID['crm'],
    name: 'CRM Integration',
    endpoint: 'https://crm.example.com/api',
    description: 'Outbound CRM <integration> & "more"',
    authenticationType: 'oauth2',
    oauthProfile: '00000000000000000000000000000002',
    headers: [
        { $id: Now.ID['crm-h-ct'], name: 'Content-Type', value: 'application/json' },
        { $id: Now.ID['crm-h-acc'], name: 'Accept', value: 'application/json' },
    ],
    functions: [
        {
            name: 'createContact',
            httpMethod: 'POST',
            endpoint: 'https://crm.example.com/api/contacts',
            content: '{"firstName":"${firstName}"}',
            headers: [{ $id: Now.ID['crm-fh'], name: 'X-Trace', value: '${trace}' }],
            variables: [
                { $id: Now.ID['crm-v-first'], name: 'firstName' },
                { $id: Now.ID['crm-v-trace'], name: 'trace', escapeType: 'escapeXml' },
            ],
            queryParams: [
                { $id: Now.ID['crm-q-a'], name: 'a', value: '${firstName}', order: 2 },
                { $id: Now.ID['crm-q-b'], name: 'b' },
            ],
        },
        {
            name: 'getContact',
            httpMethod: 'GET',
        },
    ],
})

RestMessage({
    $id: Now.ID['erp'],
    name: 'ERP',
    endpoint: 'https://erp.example.com',
    authenticationType: 'basic',
    basicAuthProfile: '00000000000000000000000000000001',
    access: 'public',
    functions: [
        {
            name: 'del',
            httpMethod: 'DELETE',
            midServer: 'd1a2b3c4d5e6f7a8b9c0d1e2f3a4b5c6',
            authenticationType: 'noAuthentication',
            lock: true,
        },
        {
            name: 'put',
            httpMethod: 'PUT',
            authenticationType: 'basic',
            basicAuthProfile: '00000000000000000000000000000003',
        },
        {
            name: 'patch',
            httpMethod: 'PATCH',
            authenticationType: 'oauth2',
            oauthProfile: '00000000000000000000000000000004',
        },
        { name: 'head', httpMethod: 'HEAD' },
    ],
})

RestMessage({
    $id: Now.ID['min'],
    name: 'Minimal',
    endpoint: 'https://min.example.com',
})
