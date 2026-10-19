import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: 'fedd00c61da94ef39fbb6236062d0572'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '4bb8392881684423b9956fa2018c8adf'
                    }
                }
                composite: [
                    {
                        table: 'sys_documentation'
                        id: '021e7f73d05f4cf1bc6918741a37ba76'
                        key: {
                            name: 'x_snc_bprobe_task'
                            element: 'notes'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_documentation'
                        id: '042cf5d7301b432a87f1253a1c2cb1d5'
                        key: {
                            name: 'x_snc_bprobe_task'
                            element: 'done'
                            language: 'en'
                        }
                    },
                    {
                        table: 'ua_table_licensing_config'
                        id: '15d9eed2322c48cdbf25889c8b42dfa7'
                        key: {
                            name: 'x_snc_bprobe_child'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: '1f5d5bdb4fbb40d6a33dd5af03fa34e2'
                        key: {
                            name: 'x_snc_bprobe_task'
                            element: 'NULL'
                        }
                    },
                    {
                        table: 'sys_choice'
                        id: '4232e3f7ed3e443183497781287a9939'
                        key: {
                            name: 'x_snc_bprobe_task'
                            element: 'state'
                            value: 'closed'
                            language: 'en'
                            dependent_value: 'NULL'
                        }
                    },
                    {
                        table: 'sys_choice_set'
                        id: '43e96a89eae440378b0f64882f3f5203'
                        key: {
                            name: 'x_snc_bprobe_task'
                            element: 'state'
                        }
                    },
                    {
                        table: 'sys_documentation'
                        id: '4eb2b8a9ecc843069348ba3dd09cfa9d'
                        key: {
                            name: 'x_snc_bprobe_task'
                            element: 'title'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: '56947cb639024ca4a37cfcee8d20faf7'
                        key: {
                            name: 'x_snc_bprobe_task'
                            element: 'due'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: '5a524736cb8e483695873409078b4f05'
                        key: {
                            name: 'x_snc_bprobe_task'
                            element: 'notes'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: '6fcceb3a04cd456282df4e764278f12d'
                        key: {
                            name: 'x_snc_bprobe_task'
                            element: 'priority'
                        }
                    },
                    {
                        table: 'sys_documentation'
                        id: '74e87f8605e84c1ea45560182b594bfa'
                        key: {
                            name: 'x_snc_bprobe_child'
                            element: 'NULL'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: '7a59eb62b4b4477295daaedc846142c7'
                        key: {
                            name: 'x_snc_bprobe_child'
                            element: 'weight'
                        }
                    },
                    {
                        table: 'sys_choice'
                        id: '810eb403ff3d4948bf0e7ad5514e0ab4'
                        key: {
                            name: 'x_snc_bprobe_task'
                            element: 'state'
                            value: 'open'
                            language: 'en'
                            dependent_value: 'NULL'
                        }
                    },
                    {
                        table: 'sys_db_object'
                        id: '8c59976ea62d4946aefdad13b2c19d41'
                        key: {
                            name: 'x_snc_bprobe_child'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: '9f60bafb67384a998d4359ca30bd415b'
                        key: {
                            name: 'x_snc_bprobe_task'
                            element: 'owner'
                        }
                    },
                    {
                        table: 'sys_documentation'
                        id: 'a50f2c17ef7a4b8fa41a96a9f64edfd6'
                        key: {
                            name: 'x_snc_bprobe_task'
                            element: 'NULL'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: 'a661994bc2d9484ebb33716aa9066bb5'
                        key: {
                            name: 'x_snc_bprobe_task'
                            element: 'done'
                        }
                    },
                    {
                        table: 'sys_db_object'
                        id: 'bbcb9bcfd39946e0af7583341b1e7fca'
                        key: {
                            name: 'x_snc_bprobe_task'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: 'bef1ee65579842c0aa0c8c1721391f9e'
                        key: {
                            name: 'x_snc_bprobe_task'
                            element: 'title'
                        }
                    },
                    {
                        table: 'sys_documentation'
                        id: 'c57b170363124318a2154ff360fa4baf'
                        key: {
                            name: 'x_snc_bprobe_task'
                            element: 'owner'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: 'c62e8432d88d42209aa77321cf6a7e61'
                        key: {
                            name: 'x_snc_bprobe_task'
                            element: 'state'
                        }
                    },
                    {
                        table: 'sys_documentation'
                        id: 'd072786d6cda46f49e687ed5a51383fb'
                        key: {
                            name: 'x_snc_bprobe_task'
                            element: 'priority'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_documentation'
                        id: 'da6257e500b04d20a7c18bd5c7701b5a'
                        key: {
                            name: 'x_snc_bprobe_task'
                            element: 'state'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: 'db684e2a4cae4e55aad8ada5e69a7fe9'
                        key: {
                            name: 'x_snc_bprobe_child'
                            element: 'NULL'
                        }
                    },
                    {
                        table: 'ua_table_licensing_config'
                        id: 'dee1ba1ab6e744499941ee7694658cc0'
                        key: {
                            name: 'x_snc_bprobe_task'
                        }
                    },
                    {
                        table: 'sys_documentation'
                        id: 'ed98ed2b20094c95a2e763844b4e5763'
                        key: {
                            name: 'x_snc_bprobe_child'
                            element: 'weight'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_documentation'
                        id: 'fab1c63ae0924a11b32a2b40ac9dd42c'
                        key: {
                            name: 'x_snc_bprobe_task'
                            element: 'due'
                            language: 'en'
                        }
                    },
                ]
            }
        }
    }
}
