import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    alias_basic: {
                        table: 'sys_alias'
                        id: 'fb070d63d27b4fb3a015bd9aeefb282e'
                    }
                    alias_cred: {
                        table: 'sys_alias'
                        id: '2c90e4987f21474c8a71f183cf7c4194'
                    }
                    alias_full: {
                        table: 'sys_alias'
                        id: 'f7f7c82d69b848059a248368f3caab2f'
                    }
                    alias_jms: {
                        table: 'sys_alias'
                        id: '54bb7a55af754eaf8f84da0a72426aeb'
                    }
                    alias_min: {
                        table: 'sys_alias'
                        id: '166f08fb6e94450db6d90f4f73fb26b0'
                    }
                    alias_odd: {
                        table: 'sys_alias'
                        id: '20d1874aa94b445bb221683ede2f56bc'
                    }
                    alias_rec: {
                        table: 'sys_alias'
                        id: '660c6c8797b941d28decaa2c0a307c23'
                    }
                    alias_rec_parent: {
                        table: 'sys_alias'
                        id: '04389ace31704d5da9c248ceb7d89982'
                    }
                    bom_json: {
                        table: 'sys_module'
                        id: '968ea54f8df54739b0824e7e9e302471'
                    }
                    dl_full: {
                        table: 'dl_definition'
                        id: 'c78915ade236450494fbba6f191c6542'
                    }
                    dl_m1: {
                        table: 'dl_definition_rel_match'
                        id: '90c613f83a5046feadd2932d0d86aa31'
                    }
                    dl_m2: {
                        table: 'dl_definition_rel_match'
                        id: 'f3ccdab9f60043f686d487c212872277'
                    }
                    dl_min: {
                        table: 'dl_definition'
                        id: 'c25b7a36650f491486e3be73b5c103fc'
                    }
                    dl_s1: {
                        table: 'dl_definition_rel_set'
                        id: '835526e99cd04ee3b84d4b2c9c6393ac'
                    }
                    dl_s2: {
                        table: 'dl_definition_rel_set'
                        id: '851924877a1e4d5bb27432b575032217'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '9b8aab7b478248d89c6435fa73b244e8'
                    }
                    rp_after: {
                        table: 'sys_retry_policy'
                        id: '70e99cf7fb744eb69441f1cd9491f166'
                    }
                    rp_default: {
                        table: 'sys_retry_policy'
                        id: 'cfb5badf4a044184970e700724a9cb04'
                    }
                    rp_http: {
                        table: 'sys_retry_policy'
                        id: 'b0c5cc6c0a9b4d8f9a679c16d347ebb9'
                    }
                    rp_jdbc: {
                        table: 'sys_retry_policy'
                        id: '68bbb3201eb54dfa972a37f8fb91d2db'
                    }
                }
                composite: [
                    {
                        table: 'sys_ui_page'
                        id: 'b27c23a77d4c4c0cacd1d3247c8de975'
                        deleted: true
                        key: {
                            endpoint: 'x_snc_bprobe_full.do'
                        }
                    },
                    {
                        table: 'sys_ui_page'
                        id: 'ca2da1b77b20427b8708e98b3cefe27b'
                        deleted: true
                        key: {
                            endpoint: 'x_snc_bprobe_min.do'
                        }
                    },
                ]
            }
        }
    }
}
