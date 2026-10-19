import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: '2c6074446b0c4ca5a9f0a80d87e790b2'
                    }
                    'filtered-suite': {
                        table: 'sys_atf_test_suite'
                        id: '7725f76f4b7b463bb4a775f7e99c62ca'
                    }
                    'full-suite': {
                        table: 'sys_atf_test_suite'
                        id: 'b35df54eaec549b8b430174fcd3faa04'
                    }
                    'minimal-suite': {
                        table: 'sys_atf_test_suite'
                        id: 'df6795e340dd45acb8a349e1d7dcd064'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '35ecf147d8a6482986fd91e2943bfed7'
                    }
                    'parent-suite': {
                        table: 'sys_atf_test_suite'
                        id: '659d0fdf757a49f1b9c04dadea99352f'
                    }
                }
                composite: [
                    {
                        table: 'sys_atf_test_suite_test'
                        id: '28a4c6ac5076493a889e228196fcabee'
                        key: {
                            test_suite: 'b35df54eaec549b8b430174fcd3faa04'
                            test: '4a1b2c3d4e5f40718293a4b5c6d7e8f9'
                        }
                    },
                    {
                        table: 'sys_atf_test_suite_test'
                        id: '2f48133dd5494763b9414179af8adbca'
                        key: {
                            test_suite: '659d0fdf757a49f1b9c04dadea99352f'
                            test: '0a1b2c3d4e5f40718293a4b5c6d7e8f9'
                        }
                    },
                    {
                        table: 'sys_atf_test_suite_test'
                        id: '400fa4a58180466db2e8ce66f17289e9'
                        key: {
                            test_suite: 'b35df54eaec549b8b430174fcd3faa04'
                            test: '1a1b2c3d4e5f40718293a4b5c6d7e8f9'
                        }
                    },
                    {
                        table: 'sys_atf_test_suite_test'
                        id: 'cfcd828d7b4c49dd97ec92ab031244c1'
                        key: {
                            test_suite: 'b35df54eaec549b8b430174fcd3faa04'
                            test: '2a1b2c3d4e5f40718293a4b5c6d7e8f9'
                        }
                    },
                    {
                        table: 'sys_atf_test_suite_test'
                        id: 'd9d2b38da3fc495284ae8e0cd1d56578'
                        key: {
                            test_suite: 'b35df54eaec549b8b430174fcd3faa04'
                            test: '3a1b2c3d4e5f40718293a4b5c6d7e8f9'
                        }
                    },
                    {
                        table: 'sys_atf_test_suite_test'
                        id: 'dace7def03c24dac8f2c608602bece14'
                        key: {
                            test_suite: 'b35df54eaec549b8b430174fcd3faa04'
                            test: '5a1b2c3d4e5f40718293a4b5c6d7e8f9'
                        }
                    },
                ]
            }
        }
    }
}
