import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: '56a470913cf14e9d80cee631285e7ace'
                    }
                    crm: {
                        table: 'sys_rest_message'
                        id: '7aa73d18d57b4673a5b72c30a34dc552'
                    }
                    'crm-fh': {
                        table: 'sys_rest_message_fn_headers'
                        id: '871395929720433dbbe54f48de259fe0'
                    }
                    'crm-h-acc': {
                        table: 'sys_rest_message_headers'
                        id: 'ad5db71a50864d31967816eeceb089ce'
                    }
                    'crm-h-ct': {
                        table: 'sys_rest_message_headers'
                        id: '82f44b7a05a54ec9b953a34effd87222'
                    }
                    'crm-q-a': {
                        table: 'sys_rest_message_fn_param_defs'
                        id: 'dca21042ca0f4b198010a12ef22c12cc'
                    }
                    'crm-q-b': {
                        table: 'sys_rest_message_fn_param_defs'
                        id: 'f44f27fd85c448c7b2e411d76ddac293'
                    }
                    'crm-v-first': {
                        table: 'sys_rest_message_fn_parameters'
                        id: '8ee1c9566c294babbd8755ae66c2941a'
                    }
                    'crm-v-trace': {
                        table: 'sys_rest_message_fn_parameters'
                        id: '1320831312b543b4bed6365ed655b36e'
                    }
                    erp: {
                        table: 'sys_rest_message'
                        id: 'd46e75c26830456e98241763d7915f6c'
                    }
                    min: {
                        table: 'sys_rest_message'
                        id: '65443eae6eff42298906dc23d9877719'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '6b3ab8fa862a45afa567c4ec9a920edb'
                    }
                }
                composite: [
                    {
                        table: 'sys_rest_message_fn'
                        id: '2efb9b14587048caa1d0a5546f0d3406'
                        key: {
                            rest_message: '7aa73d18d57b4673a5b72c30a34dc552'
                            function_name: 'createContact'
                        }
                    },
                    {
                        table: 'sys_rest_message_fn'
                        id: '52bb4a0f849e462b94dbd273d9f3bd63'
                        key: {
                            rest_message: '7aa73d18d57b4673a5b72c30a34dc552'
                            function_name: 'getContact'
                        }
                    },
                    {
                        table: 'sys_rest_message_fn'
                        id: '8ea83788c4fd442d861baf17284c3383'
                        key: {
                            rest_message: 'd46e75c26830456e98241763d7915f6c'
                            function_name: 'patch'
                        }
                    },
                    {
                        table: 'sys_rest_message_fn'
                        id: '932c9e05caf047ea81e729b495485e42'
                        key: {
                            rest_message: 'd46e75c26830456e98241763d7915f6c'
                            function_name: 'put'
                        }
                    },
                    {
                        table: 'sys_rest_message_fn'
                        id: 'c4fb7a1677ba4fee9ed76a865066a6f2'
                        key: {
                            rest_message: 'd46e75c26830456e98241763d7915f6c'
                            function_name: 'del'
                        }
                    },
                    {
                        table: 'sys_rest_message_fn'
                        id: 'f5556db024384a46b1f3a278f79733fc'
                        key: {
                            rest_message: 'd46e75c26830456e98241763d7915f6c'
                            function_name: 'head'
                        }
                    },
                ]
            }
        }
    }
}
