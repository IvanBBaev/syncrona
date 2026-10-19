import { Acl, GraphQLApi } from '@servicenow/sdk/core'

const acl = Acl({ $id: Now.ID['gql_acl'], type: 'graphql', operation: 'execute', name: 'xSncBprobe.pets', roles: ['admin'] })

GraphQLApi({
    $id: Now.ID['pets'],
    name: 'Pets API',
    applicationNamespace: 'xSncBprobe',
    namespace: 'pets',
    schema: Now.include('./schema.graphql'),
    active: false,
    enforceAcl: [acl, 'cf9d01d3e73003009d6247e603f6a990', acl],
    requiresAuthentication: false,
    requiresAclAuthorization: false,
    requiresSncInternalRole: false,
    contextualAclMaxDepth: 2,
    resolvers: [
        { $id: Now.ID['hello'], name: 'hello', script: Now.include('./resolver.js'), paths: ['Query:hello'] },
        { $id: Now.ID['pets_r'], name: 'pets', script: 'return [{ name: "Rex", barks: true }];', paths: ['Query:pets', 'Dog:name'] },
    ],
    typeResolvers: [{ $id: Now.ID['pet'], typeName: 'Pet', script: 'return "Dog";' }],
})

GraphQLApi({
    $id: Now.ID['bare'],
    name: 'Bare API',
    namespace: 'bare',
    schema: 'type Query { ping: String }',
})
