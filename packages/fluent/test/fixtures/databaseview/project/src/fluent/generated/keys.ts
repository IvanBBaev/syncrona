import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    'basic-table': {
                        table: 'sys_db_view_table'
                        id: '6f0544aa63104539acd46682e6ba602e'
                    }
                    bom_json: {
                        table: 'sys_module'
                        id: 'aa184e24d5164e02a7ff6483d62af027'
                    }
                    'full-inc': {
                        table: 'sys_db_view_table'
                        id: 'f63ca98fd1d24128bdeaed53035fa061'
                    }
                    'full-inc-caller': {
                        table: 'sys_db_view_table_field'
                        id: '74afbd47d57d4a3ea7299e255fc7861f'
                    }
                    'full-inc-number': {
                        table: 'sys_db_view_table_field'
                        id: '3bf79df324564616be22072afa86774b'
                    }
                    'full-usr': {
                        table: 'sys_db_view_table'
                        id: '6605d4f4eb1b44e2bd447155f2654acb'
                    }
                    'full-usr-name': {
                        table: 'sys_db_view_table_field'
                        id: 'cdf488d6abcb4365be5b0f31641b803e'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '52c9a3ef71034f2a809abe41b091b99d'
                    }
                }
                composite: [
                    {
                        table: 'sys_db_view'
                        id: 'babe42477af44ff1987d1b663be74e05'
                        key: {
                            name: 'x_snc_bprobe_basic'
                        }
                    },
                    {
                        table: 'sys_db_view'
                        id: 'e8b5ca44460c41eea4310bc0d52a4f48'
                        key: {
                            name: 'x_snc_bprobe_empty'
                        }
                    },
                    {
                        table: 'sys_db_view'
                        id: 'ed751008dacc44e89ad1d42912f3d0d8'
                        key: {
                            name: 'x_snc_bprobe_full'
                        }
                    },
                ]
            }
        }
    }
}
