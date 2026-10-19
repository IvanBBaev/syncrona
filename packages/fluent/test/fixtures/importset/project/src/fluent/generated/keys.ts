import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bare: {
                        table: 'sys_transform_map'
                        id: 'f83ecc227a3f406488f2ef33c3a1f39c'
                    }
                    before: {
                        table: 'sys_transform_script'
                        id: '72cbc7be6f1b404b9b9ede4b696dcbb4'
                    }
                    bom_json: {
                        table: 'sys_module'
                        id: 'b829693af4bb4445ba82f9fea41e9670'
                    }
                    done: {
                        table: 'sys_transform_script'
                        id: '656248aaf8d54957a9a20f5e56796eb8'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '716a47d00b3742ccb14cf9e3a53e8e37'
                    }
                    users: {
                        table: 'sys_transform_map'
                        id: 'd1c2890a17404df4b526f43f71999d9c'
                    }
                }
                composite: [
                    {
                        table: 'sys_transform_entry'
                        id: '72fefe6082444aafa697cf402192c7e5'
                        key: {
                            map: 'd1c2890a17404df4b526f43f71999d9c'
                            target_field: 'title'
                        }
                    },
                    {
                        table: 'sys_transform_entry'
                        id: '871459c9664e48448a84660eb42541ba'
                        key: {
                            map: 'f83ecc227a3f406488f2ef33c3a1f39c'
                            target_field: 'name'
                        }
                    },
                    {
                        table: 'sys_transform_entry'
                        id: 'b2bc7a755ce24c77b6c390434b8def96'
                        key: {
                            map: 'd1c2890a17404df4b526f43f71999d9c'
                            target_field: 'manager'
                        }
                    },
                    {
                        table: 'sys_transform_entry'
                        id: 'bdfd1dfeb88746eeb8d16c8dbb22afc9'
                        key: {
                            map: 'd1c2890a17404df4b526f43f71999d9c'
                            target_field: 'hire_date'
                        }
                    },
                    {
                        table: 'sys_transform_entry'
                        id: 'c4c32eb7b2814463938bfbc5866e8bdf'
                        key: {
                            map: 'd1c2890a17404df4b526f43f71999d9c'
                            target_field: 'user_name'
                        }
                    },
                    {
                        table: 'sys_transform_entry'
                        id: 'e9a6a3f856454ac2b60fe714b09fea18'
                        key: {
                            map: 'd1c2890a17404df4b526f43f71999d9c'
                            target_field: 'email'
                        }
                    },
                ]
            }
        }
    }
}
