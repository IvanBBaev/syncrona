import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    app_full: {
                        table: 'sys_ux_applicability'
                        id: '022984c7c8cb4db2a5d4859ae482ccde'
                    }
                    app_minimal: {
                        table: 'sys_ux_applicability'
                        id: '6aa40011691a428b9555feed56a37db6'
                    }
                    app_sysid: {
                        table: 'sys_ux_applicability'
                        id: '52eb3d5a75fe47a7b35f3e9e8e07d05f'
                    }
                    bom_json: {
                        table: 'sys_module'
                        id: '54f7ae1e64d54d58b0614e615e946eb0'
                    }
                    cat_defaults: {
                        table: 'sys_ux_list_category'
                        id: '65f03d8bd69f46fa814957af9d026b48'
                    }
                    cat_lists: {
                        table: 'sys_ux_list_category'
                        id: '9c22f8428d6548f4bbc2eabe6a3f7a24'
                    }
                    list_defaults: {
                        table: 'sys_ux_list'
                        id: '66367fb158644798bc83ba84dfc7f7f1'
                    }
                    list_full: {
                        table: 'sys_ux_list'
                        id: 'a869b1b2f925407fbfe5cc9b2a8df4e6'
                    }
                    m2m_record: {
                        table: 'sys_ux_applicability_m2m_list'
                        id: '9728664daa0a4e9ab223bad6142f13e6'
                    }
                    m2m_string: {
                        table: 'sys_ux_applicability_m2m_list'
                        id: '918e51382be44dd7ac3e114db6d5e7ed'
                    }
                    menu_empty: {
                        table: 'sys_ux_list_menu_config'
                        id: '7569715dce2c44658545d753bddc6e99'
                    }
                    menu_full: {
                        table: 'sys_ux_list_menu_config'
                        id: '3c3cefc6d7644b74b124d8428c10f138'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '5b4ab03dbc1b47bb9373a8e89a0af50f'
                    }
                }
                composite: [
                    {
                        table: 'sys_user_role'
                        id: '28d4655b98c54df7a95bec35212d1c31'
                        key: {
                            name: 'x_snc_bprobe.viewer'
                        }
                    },
                ]
            }
        }
    }
}
