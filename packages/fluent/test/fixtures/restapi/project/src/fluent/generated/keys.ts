import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    acl: {
                        table: 'sys_security_acl'
                        id: 'e68465a2793e4a8ca7e3a911e617416e'
                    }
                    bom_json: {
                        table: 'sys_module'
                        id: '628105b322e746bfaefcdc0007b68772'
                    }
                    create: {
                        table: 'sys_ws_operation'
                        id: '79212e5d37164c88be7199a3ce404d53'
                    }
                    'h-trace': {
                        table: 'sys_ws_header'
                        id: 'd92612518ab74093bf89c44749ff5ae3'
                    }
                    items: {
                        table: 'sys_ws_definition'
                        id: 'd3617245013c4e83bd60ed56ae312b91'
                    }
                    list: {
                        table: 'sys_ws_operation'
                        id: '34ab963acda14d8abccf5747402b62ed'
                    }
                    'p-dry': {
                        table: 'sys_ws_query_parameter'
                        id: '1ce554f2413b4a2b89a244de93400608'
                    }
                    'p-limit': {
                        table: 'sys_ws_query_parameter'
                        id: '97a17e40a9584c41b828c3b9170727b8'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '79d99204f7e74459b687fbd06c552ffa'
                    }
                    plain: {
                        table: 'sys_ws_definition'
                        id: 'b2419f854e7042eab0d0875562bc9103'
                    }
                    root: {
                        table: 'sys_ws_operation'
                        id: '88e268bc8f57455ab9e853a7fc429bae'
                    }
                    v1: {
                        table: 'sys_ws_version'
                        id: 'c766d9dec6bf4cae8945c0905b51df37'
                    }
                    v2: {
                        table: 'sys_ws_version'
                        id: 'e4692ac0bc414cfb857d3f2a80182e07'
                    }
                }
                composite: [
                    {
                        table: 'sys_ws_query_parameter_map'
                        id: '0338b3f030244cf68da40d8e1f0b51d7'
                        key: {
                            web_service_operation: '79212e5d37164c88be7199a3ce404d53'
                            web_service_query_parameter: '1ce554f2413b4a2b89a244de93400608'
                        }
                    },
                    {
                        table: 'sys_security_acl_role'
                        id: '243eb23a84fd4c709669b03825710cab'
                        key: {
                            sys_security_acl: 'e68465a2793e4a8ca7e3a911e617416e'
                            sys_user_role: {
                                id: '3e1f438887944d8cb969115192dea779'
                                key: {
                                    name: 'admin'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_ws_header_map'
                        id: '7284f72741b84552a9f7459348095f46'
                        key: {
                            web_service_operation: '79212e5d37164c88be7199a3ce404d53'
                            web_service_header: 'd92612518ab74093bf89c44749ff5ae3'
                        }
                    },
                    {
                        table: 'sys_ws_query_parameter_map'
                        id: 'a4bbb836f7bc4fe7abba8f7313511ab4'
                        key: {
                            web_service_operation: '34ab963acda14d8abccf5747402b62ed'
                            web_service_query_parameter: '97a17e40a9584c41b828c3b9170727b8'
                        }
                    },
                    {
                        table: 'sys_ws_header_map'
                        id: 'dc8bbfe136cf4545b40d7bd16bb7da83'
                        key: {
                            web_service_operation: '34ab963acda14d8abccf5747402b62ed'
                            web_service_header: 'd92612518ab74093bf89c44749ff5ae3'
                        }
                    },
                ]
            }
        }
    }
}
