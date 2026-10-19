import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bare: {
                        table: 'sys_graphql_schema'
                        id: 'd86e0e35c168454f8f85072eaa957186'
                    }
                    bom_json: {
                        table: 'sys_module'
                        id: '2cc7204b2df04c71b0678df28110de60'
                    }
                    gql_acl: {
                        table: 'sys_security_acl'
                        id: '80feeb8ea765457dad3a01d87a98e66a'
                    }
                    hello: {
                        table: 'sys_graphql_resolver'
                        id: 'bd3bc87faee143b9a1871a8ed044c617'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: 'cb72cfe2842d45c981ee15e239b5eccc'
                    }
                    pet: {
                        table: 'sys_graphql_typeresolver'
                        id: 'dbc671d90c274e23a2505989a7cf924a'
                    }
                    pets: {
                        table: 'sys_graphql_schema'
                        id: '7e13ee453839472f89318d37f909bfa2'
                    }
                    pets_r: {
                        table: 'sys_graphql_resolver'
                        id: '3c37de31b24e4f1dbf068367fd48935f'
                    }
                }
                composite: [
                    {
                        table: 'sys_graphql_resolver_mapping'
                        id: '17e26428019a4981b229a0b5b0aa6662'
                        key: {
                            schema: '7e13ee453839472f89318d37f909bfa2'
                            path: 'Dog:name'
                        }
                    },
                    {
                        table: 'sys_graphql_resolver_mapping'
                        id: '774399390f724ab181b5ceded388f62b'
                        key: {
                            schema: '7e13ee453839472f89318d37f909bfa2'
                            path: 'Query:hello'
                        }
                    },
                    {
                        table: 'sys_security_acl_role'
                        id: '8e576a8085064d3e9cef01f1fbd424ec'
                        key: {
                            sys_security_acl: '80feeb8ea765457dad3a01d87a98e66a'
                            sys_user_role: {
                                id: 'b5ae25b8d3064953a648062aa32fc876'
                                key: {
                                    name: 'admin'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_graphql_resolver_mapping'
                        id: 'f99a0010aca24375a439987c32a24f52'
                        key: {
                            schema: '7e13ee453839472f89318d37f909bfa2'
                            path: 'Query:pets'
                        }
                    },
                ]
            }
        }
    }
}
