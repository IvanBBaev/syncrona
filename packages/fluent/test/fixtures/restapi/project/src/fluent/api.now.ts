import { Acl, RestApi } from '@servicenow/sdk/core'

const acl = Acl({ $id: Now.ID['acl'], type: 'rest_endpoint', operation: 'execute', name: 'x_snc_bprobe/items', roles: ['admin'] })

RestApi({
  $id: Now.ID['items'],
  name: 'Items',
  serviceId: 'items',
  shortDescription: 'Item API',
  docLink: 'https://docs.example.com',
  consumes: 'application/json',
  enforceAcl: [acl, 'a0b1c2d3e4f5a6b7c8d9e0f1a2b3c4d5'],
  protectionPolicy: 'read',
  versions: [
    { $id: Now.ID['v1'], version: 1, shortDescription: 'First' },
    { $id: Now.ID['v2'], version: 2, isDefault: true, deprecated: true, active: false },
  ],
  routes: [
    {
      $id: Now.ID['list'],
      name: 'list',
      path: '/list',
      script: "(function (request, response) { response.setBody({ ok: true }); })(request, response);",
      version: 1,
      parameters: [
        { $id: Now.ID['p-limit'], name: 'limit', required: true, exampleValue: '10', shortDescription: 'Max' },
      ],
      headers: [{ $id: Now.ID['h-trace'], name: 'X-Trace' }],
    },
    {
      $id: Now.ID['create'],
      method: 'POST',
      path: '/create',
      consumes: 'text/plain',
      produces: 'application/json',
      script: 'gs.info("create")',
      version: 2,
      authentication: false,
      authorization: false,
      internalRole: false,
      active: false,
      requestExample: '{"a":1}',
      enforceAcl: [acl],
      protectionPolicy: 'protected',
      headers: [{ $id: Now.ID['h-trace'], name: 'X-Trace' }],
      parameters: [{ $id: Now.ID['p-dry'], name: 'dry' }],
    },
  ],
})

RestApi({
  $id: Now.ID['plain'],
  name: 'Plain',
  serviceId: 'plain_api',
  routes: [{ $id: Now.ID['root'], script: 'gs.info(1)' }],
})
