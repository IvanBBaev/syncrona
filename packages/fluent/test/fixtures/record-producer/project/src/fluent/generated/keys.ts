import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: '7cd518badeb0474aa5ad57810ce5b4e6'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: 'd4aa82fcce8842918d9b3677ac8c52eb'
                    }
                    rp_full: {
                        table: 'sc_cat_item_producer'
                        id: '0c3558f7598f459fa8138a58179ae36c'
                    }
                    rp_min: {
                        table: 'sc_cat_item_producer'
                        id: '7390fb3a15524e798dab196b835f7d39'
                    }
                    rp_other: {
                        table: 'sc_cat_item_producer'
                        id: '2426443251a6486a9da524ab34212466'
                    }
                    rp_vs: {
                        table: 'item_option_new_set'
                        id: '794482ecc3a743fa82e554f338b0aa5b'
                    }
                }
                composite: [
                    {
                        table: 'sys_documentation'
                        id: '0a609b77e94a4f418e732a600d437443'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                            element: 'NULL'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: '14e5019d46a54b179ec0e813a6f86583'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                            element: 'detail'
                        }
                    },
                    {
                        table: 'io_set_item'
                        id: '1a40d4a25a6244cb97b6ee29861027e0'
                        key: {
                            sc_cat_item: '0c3558f7598f459fa8138a58179ae36c'
                            variable_set: '794482ecc3a743fa82e554f338b0aa5b'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: '50b4bb06e4bc4fedb9111c44dc63164f'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '794482ecc3a743fa82e554f338b0aa5b'
                            name: 'who'
                        }
                    },
                    {
                        table: 'sys_documentation'
                        id: '513188657e9d491681869c3ae2b1ac39'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                            element: 'summary'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_db_object'
                        id: '621a8176b987441684ab78f7255a893a'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                        }
                    },
                    {
                        table: 'sys_user_role'
                        id: '9c15a70c857141f78bb500f86c09daec'
                        key: {
                            name: 'x_snc_bprobe.approver'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: 'a55efd1f3acd4a35b35258fdba2ed795'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                            element: 'NULL'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: 'b7f2864b99d147cd90ad84db00f08cdd'
                        key: {
                            cat_item: '0c3558f7598f459fa8138a58179ae36c'
                            variable_set: 'NULL'
                            name: 'caller'
                        }
                    },
                    {
                        table: 'sys_documentation'
                        id: 'c264c0b5bc29481086e50215f658c192'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                            element: 'detail'
                            language: 'en'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: 'c9e15dd17ef046eaa9512c689e1a1e85'
                        key: {
                            cat_item: '2426443251a6486a9da524ab34212466'
                            variable_set: 'NULL'
                            name: 'a'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: 'ca4c89437f714badba07b7469822841e'
                        key: {
                            cat_item: '0c3558f7598f459fa8138a58179ae36c'
                            variable_set: 'NULL'
                            name: 'summary'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: 'd07b474b84cf4f5c9629affe74a05215'
                        key: {
                            cat_item: '0c3558f7598f459fa8138a58179ae36c'
                            variable_set: 'NULL'
                            name: 'detail'
                        }
                    },
                    {
                        table: 'sc_cat_item_catalog'
                        id: 'd7053506c6f440e6a10d76895a97eee3'
                        key: {
                            sc_cat_item: '0c3558f7598f459fa8138a58179ae36c'
                            sc_catalog: 'e0d08b13c3330100c8b837659bba8fb4'
                        }
                    },
                    {
                        table: 'ua_table_licensing_config'
                        id: 'd97d9783405a46b0bf86667d4e6e915a'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                        }
                    },
                    {
                        table: 'sc_cat_item_category'
                        id: 'eec54cce3d774409aae850293fc03735'
                        key: {
                            sc_cat_item: '0c3558f7598f459fa8138a58179ae36c'
                            sc_category: 'd258b953c611227a0146101fb1be7c31'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: 'f02eef081f5541b9af0c556209c7ca42'
                        key: {
                            name: 'x_snc_bprobe_ticket'
                            element: 'summary'
                        }
                    },
                ]
            }
        }
    }
}
