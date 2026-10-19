import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: '65cee149d5b44d7ba79d0875445a1fb9'
                    }
                    cs_change: {
                        table: 'catalog_script_client'
                        id: 'e003dd52300144a4a0c935836c18a764'
                    }
                    cs_min: {
                        table: 'catalog_script_client'
                        id: 'b43c5f0be2534c48982495ca17f77f18'
                    }
                    cs_notype: {
                        table: 'catalog_script_client'
                        id: '77ce2920a0ae4a54955925709c49091f'
                    }
                    cs_set: {
                        table: 'catalog_script_client'
                        id: 'a9472356bff94b6b8b3bfd2909b9783e'
                    }
                    p_full: {
                        table: 'catalog_ui_policy'
                        id: '06c821b89f69493a9b1ff9c543b813ca'
                    }
                    p_min: {
                        table: 'catalog_ui_policy'
                        id: '85227dc6b6994d04bba702ce626f6e2f'
                    }
                    p_set: {
                        table: 'catalog_ui_policy'
                        id: 'b248d93de6334f6eb53e5c97621fa12e'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '7d16f3a8a63d457f9d1213f24e15e3e9'
                    }
                    ui_ci: {
                        table: 'sc_cat_item'
                        id: '3813e86653aa4f21acf1c0afdf1c4500'
                    }
                    ui_vs: {
                        table: 'item_option_new_set'
                        id: 'c272425a24b7470db845f21d148c1b34'
                    }
                }
                composite: [
                    {
                        table: 'item_option_new'
                        id: '055f9af2598b416a8ff001d9b411409f'
                        key: {
                            cat_item: '3813e86653aa4f21acf1c0afdf1c4500'
                            variable_set: 'NULL'
                            name: 'a'
                        }
                    },
                    {
                        table: 'io_set_item'
                        id: '29fa8dc6dc794235b2a7db3dccbd2a0a'
                        key: {
                            sc_cat_item: '3813e86653aa4f21acf1c0afdf1c4500'
                            variable_set: 'c272425a24b7470db845f21d148c1b34'
                        }
                    },
                    {
                        table: 'catalog_ui_policy_action'
                        id: '4e7e75d5eafc4d13848d379bfe83fbaf'
                        key: {
                            ui_policy: '06c821b89f69493a9b1ff9c543b813ca'
                            catalog_variable: 'IO:055f9af2598b416a8ff001d9b411409f'
                        }
                    },
                    {
                        table: 'catalog_ui_policy_action'
                        id: '5059b7748f73415d878614c349937c75'
                        key: {
                            ui_policy: 'b248d93de6334f6eb53e5c97621fa12e'
                            catalog_variable: 'IO:s'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: '8348c667ad7d47338fe87138fd5b4b9c'
                        key: {
                            cat_item: '3813e86653aa4f21acf1c0afdf1c4500'
                            variable_set: 'NULL'
                            name: 'b'
                        }
                    },
                    {
                        table: 'catalog_ui_policy_action'
                        id: '8e66a8c7f0bb4093b0ab1227511f9c6f'
                        key: {
                            ui_policy: '06c821b89f69493a9b1ff9c543b813ca'
                            catalog_variable: 'IO:e3f931026f364c7a89729cb95e9fb0e4'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: 'e3f931026f364c7a89729cb95e9fb0e4'
                        key: {
                            cat_item: 'NULL'
                            variable_set: 'c272425a24b7470db845f21d148c1b34'
                            name: 's'
                        }
                    },
                ]
            }
        }
    }
}
