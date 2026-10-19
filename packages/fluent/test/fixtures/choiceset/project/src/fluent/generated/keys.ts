import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: '8734bceaaf8c48d695ca45805919c4b7'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: 'd237bbe7a861471682f2dcdef93ad2a8'
                    }
                }
                composite: [
                    {
                        table: 'sys_documentation'
                        id: '034ee114ddc54a3d9e2a4328ab939429'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                            element: 'kind'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_choice_set'
                        id: '11ea88a2146148f1bb0e8f7793d89e0a'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                            element: 'priority'
                        }
                    },
                    {
                        table: 'sys_choice'
                        id: '1e2ef4e3370a41b9add5babfd0f8d1aa'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                            element: 'priority'
                            value: '1'
                            language: 'en'
                            dependent_value: 'NULL'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: '29451a67958949a78afeca397603630c'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                            element: 'NULL'
                        }
                    },
                    {
                        table: 'ua_table_licensing_config'
                        id: '2a86d07b0117409f89aa3b2c6940920b'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                        }
                    },
                    {
                        table: 'sys_choice'
                        id: '438f1e8035f8454eae154d0c45fbd55a'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                            element: 'state'
                            value: '11'
                            language: 'en'
                            dependent_value: 'NULL'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: '47be7c2efa16428999e8231af4f4fc79'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                            element: 'kind'
                        }
                    },
                    {
                        table: 'sys_choice'
                        id: '4cf658db71184e3d8e13478800905379'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                            element: 'state'
                            value: '13'
                            language: 'en'
                            dependent_value: 'x'
                        }
                    },
                    {
                        table: 'sys_choice'
                        id: '6d1269602fd44203804c9f00efdab618'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                            element: 'priority'
                            value: '2'
                            language: 'en'
                            dependent_value: 'NULL'
                        }
                    },
                    {
                        table: 'sys_choice_set'
                        id: '7683581e3c9046a49244c696665fd9e9'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                            element: 'state'
                        }
                    },
                    {
                        table: 'sys_documentation'
                        id: '7fd5979e3d8e476a8676d44bd4c68797'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                            element: 'NULL'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_db_object'
                        id: 'a05d6737b41544baae372a3120d2dc1c'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                        }
                    },
                    {
                        table: 'sys_choice'
                        id: 'ad15659a219048788dc7125df501e87b'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                            element: 'state'
                            value: '12'
                            language: 'en'
                            dependent_value: 'NULL'
                        }
                    },
                    {
                        table: 'sys_choice'
                        id: 'cefce862ee764d4b9a994b47b70b6edf'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                            element: 'state'
                            value: '10'
                            language: 'en'
                            dependent_value: 'NULL'
                        }
                    },
                    {
                        table: 'sys_choice'
                        id: 'e173ff41d1204371af25a49576892aed'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                            element: 'state'
                            value: '12'
                            language: 'de'
                            dependent_value: '3'
                        }
                    },
                    {
                        table: 'sys_choice'
                        id: 'f935c69ba1604e9982da1a608dc1ed38'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                            element: 'priority'
                            value: 'low'
                            language: 'en'
                            dependent_value: 'NULL'
                        }
                    },
                ]
            }
        }
    }
}
