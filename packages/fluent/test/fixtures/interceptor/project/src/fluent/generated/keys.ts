import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: '0f6ae1016c9f4298b75e54f9d813bb66'
                    }
                    'demo-guid': {
                        table: 'sys_wizard_answer'
                        id: '195538581f944ec1b9178e43bad7130a'
                    }
                    'follow-only': {
                        table: 'sys_wizard_answer'
                        id: 'c33c418e66dc4bae94f5af9d949854e8'
                    }
                    'full-button': {
                        table: 'sys_wizard_answer'
                        id: '407c8e09a71a4dd1a54091fc84859b0c'
                    }
                    'full-custom': {
                        table: 'sys_wizard_answer'
                        id: '03185e9de27e48169bade42b22b5aac4'
                    }
                    'full-external': {
                        table: 'sys_wizard_answer'
                        id: 'd450e8d1c65f4d639effe93514b83cea'
                    }
                    'full-form': {
                        table: 'sys_wizard_answer'
                        id: '4038e813b6b941da9f41fee28286adf0'
                    }
                    'full-free': {
                        table: 'sys_wizard_answer'
                        id: 'db9df5b5ed8b4b0cafb9fb55c4fcbfb8'
                    }
                    'full-leading': {
                        table: 'sys_wizard_answer'
                        id: '6bfa7343f49c441aa951330781ecece5'
                    }
                    'full-multi': {
                        table: 'sys_wizard_answer'
                        id: '3f36f47e6cf64b9faca9174f5937e188'
                    }
                    'full-yes-no': {
                        table: 'sys_wizard_answer'
                        id: '4caac0bcf0b54a0682ae72c52ab55c5a'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '8ba548f5c4334a1998b4fa2bec8768b4'
                    }
                }
                composite: [
                    {
                        table: 'sys_wizard'
                        id: '4c1ec0a527cb494e980a73415c7c473f'
                        key: {
                            name: 'Minimal'
                        }
                    },
                    {
                        table: 'sys_wizard'
                        id: '571dbb92c8b14f27863f9f6714365e7c'
                        key: {
                            name: 'Keyed refs'
                        }
                    },
                    {
                        table: 'sys_wizard'
                        id: '855cef9fabb04903be20c4444a518c3a'
                        key: {
                            name: 'Demo wizard'
                        }
                    },
                    {
                        table: 'sys_wizard'
                        id: 'b6c0cd79c32c468d9fe829c11b42da97'
                        key: {
                            name: 'Record wizard'
                        }
                    },
                    {
                        table: 'sys_wizard'
                        id: 'c5edccc55b8140298f0fa0923e7b241a'
                        deleted: true
                        key: {
                            name: 'Full <Interceptor> & "quotes"'
                        }
                    },
                    {
                        table: 'sys_user_role'
                        id: 'cc58cc0fa2dc45dab2e005a5cab6d7bc'
                        key: {
                            name: 'x_snc_bprobe.wizard_user'
                        }
                    },
                    {
                        table: 'sys_wizard'
                        id: 'ea91a27f9e6749ec90cfcaea7a3c5323'
                        key: {
                            name: 'Full "quoted" Interceptor'
                        }
                    },
                    {
                        table: 'sys_wizard'
                        id: 'f4f9fb4305fc4f9aa93116a2a8da6891'
                        key: {
                            name: 'Follow-up question'
                        }
                    },
                ]
            }
        }
    }
}
