import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    'bare-template': {
                        table: 'sys_alias_templates'
                        id: 'c32bb21cc4944c99abe35ec68443c114'
                    }
                    bom_json: {
                        table: 'sys_module'
                        id: '274581dbd7c84724987cc1996bff0680'
                    }
                    'by-id-template': {
                        table: 'sys_alias_templates'
                        id: '75e0208ca8f3459fac6516d4ff8a89ec'
                    }
                    'full-template': {
                        table: 'sys_alias_templates'
                        id: '6c77937bfb1d466790419fbcf3226a18'
                    }
                    'minimal-template': {
                        table: 'sys_alias_templates'
                        id: 'c38f2a573de7440585db1824f277c245'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '77f43ead496d40468e1de9bb4bc61143'
                    }
                    'test-action': {
                        table: 'sys_hub_action_type_definition'
                        id: 'e6813144e06b4a16bcd7b914b394dd42'
                    }
                }
            }
        }
    }
}
