import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: 'bc04c2ae66244b8997c4c69372a557ed'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '2eed8fc8e01b4e598c63cbc9f086c8e2'
                    }
                }
                composite: [
                    {
                        table: 'sys_ui_page'
                        id: 'e2301e569e1c4ca891a5d2515b3a43a9'
                        key: {
                            name: 'dash-page'
                        }
                    },
                    {
                        table: 'sys_ui_page'
                        id: 'f4c7f46a46364ef99f5a0ac26f087161'
                        key: {
                            name: 'my_global_page'
                        }
                    },
                ]
            }
        }
    }
}
