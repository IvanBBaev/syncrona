import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    acl_override: {
                        table: 'sys_security_acl'
                        id: 'be224101716b4f47b4748d279d5494ce'
                    }
                    bom_json: {
                        table: 'sys_module'
                        id: 'f7a4e3a0af164ab58c19d22814046328'
                    }
                    br_override: {
                        table: 'sys_script'
                        id: 'b6e98de97e124d94b571e59fc1f186e0'
                    }
                    cs_override: {
                        table: 'sys_script_client'
                        id: '69cb9d1018524dc7aa2c38cdc5696045'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: 'd6be6933385241af95dc6f886b25b71e'
                    }
                    prop_override: {
                        table: 'sys_properties'
                        id: '663a94fe7f044111a345222cc47c655b'
                    }
                    si_override: {
                        table: 'sys_script_include'
                        id: '898d6b077f5b480e93938c1fb5b49273'
                    }
                    src_server_ovr_server_js: {
                        table: 'sys_module'
                        id: 'ef0362c8b7094e4bb6abfb1b2cc1af44'
                    }
                    ua_override: {
                        table: 'sys_ui_action'
                        id: 'ac5b903f936d4ffbba1cd28b665f1cc8'
                    }
                }
                composite: [
                    {
                        table: 'sys_db_object'
                        id: '0229e0e1129044eeabe7b57ef3594ab0'
                        key: {
                            name: 'x_snc_bprobe_ovr'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: '03e9ab40a741476ea6ddd273b64ad50b'
                        key: {
                            name: 'x_snc_bprobe_ovr'
                            element: 'title'
                        }
                    },
                    {
                        table: 'ua_table_licensing_config'
                        id: '7fd6075c08fb4666b123a6e48fa2482d'
                        key: {
                            name: 'x_snc_bprobe_ovr'
                        }
                    },
                    {
                        table: 'sys_user_role'
                        id: '8729a1ac51d74e97acf864d17b827dfe'
                        key: {
                            name: 'x_snc_bprobe.ovr'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: 'd1063a2197a44c24b085e42ef4ba766e'
                        key: {
                            name: 'x_snc_bprobe_ovr'
                            element: 'NULL'
                        }
                    },
                    {
                        table: 'sys_documentation'
                        id: 'd2f173d9675f4186aa3a76854445e2e6'
                        key: {
                            name: 'x_snc_bprobe_ovr'
                            element: 'NULL'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_documentation'
                        id: 'dc2957c7a96d4af68144d39fecb71f40'
                        key: {
                            name: 'x_snc_bprobe_ovr'
                            element: 'title'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_security_acl_role'
                        id: 'fde50217a7ba4e92a9cd844bb3726d06'
                        key: {
                            sys_security_acl: 'be224101716b4f47b4748d279d5494ce'
                            sys_user_role: {
                                id: '8729a1ac51d74e97acf864d17b827dfe'
                                key: {
                                    name: 'x_snc_bprobe.ovr'
                                }
                            }
                        }
                    },
                ]
            }
        }
    }
}
