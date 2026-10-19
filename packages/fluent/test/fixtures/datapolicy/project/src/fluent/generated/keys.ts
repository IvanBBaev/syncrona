import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    '7': {
                        table: 'sys_data_policy_rule'
                        id: 'af305f6c7e6846c29895ec7f468bc00f'
                    }
                    bom_json: {
                        table: 'sys_module'
                        id: '458a91dc2f76421fb1c0118446de6859'
                    }
                    dp_full: {
                        table: 'sys_data_policy2'
                        id: '6be00c234bd645b5b959ab0d2ef41ef8'
                    }
                    dp_min: {
                        table: 'sys_data_policy2'
                        id: 'c19dd70cf41b4958932b4163839647b9'
                    }
                    dp_rule_code: {
                        table: 'sys_data_policy_rule'
                        id: 'dd660c9f10a841c69db150b4da941f95'
                    }
                    dp_rule_note: {
                        table: 'sys_data_policy_rule'
                        id: '36fcfc4e61ae43388f57cb4cc1a3cc46'
                    }
                    dp_rule_number: {
                        table: 'sys_data_policy_rule'
                        id: '2aa423e01ab94412bcb5e2e5ddd64e31'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: 'b666eb198cea45e39bbf48b740e5b326'
                    }
                }
                composite: [
                    {
                        table: 'sys_documentation'
                        id: '145d0d77bfe14176aa23a9946f0d0dce'
                        key: {
                            name: 'x_snc_bprobe_dp'
                            element: 'NULL'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_documentation'
                        id: '387445e75b1f484786ab07af91eeaf01'
                        key: {
                            name: 'x_snc_bprobe_dp'
                            element: 'code'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_db_object'
                        id: '3f952491bf7c4cbc8b639703eccf97c0'
                        key: {
                            name: 'x_snc_bprobe_dp'
                        }
                    },
                    {
                        table: 'ua_table_licensing_config'
                        id: '577643e5140e49e48e7171efe5992bf2'
                        key: {
                            name: 'x_snc_bprobe_dp'
                        }
                    },
                    {
                        table: 'sys_documentation'
                        id: '70846daca6594033b56e4bc6bdc9a20e'
                        key: {
                            name: 'x_snc_bprobe_dp'
                            element: 'note'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: '85a19861e3c7499cad05e4c872b903dc'
                        key: {
                            name: 'x_snc_bprobe_dp'
                            element: 'NULL'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: 'a80f0a392f5e4bc9880d4f6e8e1c8540'
                        key: {
                            name: 'x_snc_bprobe_dp'
                            element: 'code'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: 'd67057d0edb043508b14377224a5fa2e'
                        key: {
                            name: 'x_snc_bprobe_dp'
                            element: 'note'
                        }
                    },
                ]
            }
        }
    }
}
