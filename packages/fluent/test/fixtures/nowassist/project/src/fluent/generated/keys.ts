import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    customer_inquiry_input: {
                        table: 'sys_one_extend_definition_attribute'
                        id: '9c933514cc634369bf05d4d003ff7552'
                    }
                    customer_support_acl: {
                        table: 'sys_security_acl'
                        id: '206f6db54a9c4c94948e02a72d30a4d0'
                    }
                    customer_support_custom_response: {
                        table: 'sys_one_extend_definition_attribute'
                        id: 'ca08ef343e7741c684aeb5beaf9459a4'
                    }
                    my_skill: {
                        table: 'sys_one_extend_capability'
                        id: 'e0156365ac94450b86885804ae35ed6b'
                    }
                    my_skill__output_error: {
                        table: 'sys_one_extend_definition_attribute'
                        id: 'f4378d87793b4844b9bc623b7c2e2c2d'
                    }
                    my_skill__output_errorcode: {
                        table: 'sys_one_extend_definition_attribute'
                        id: '529514b70fc444e2b3a1b656dc9cde09'
                    }
                    my_skill__output_provider: {
                        table: 'sys_one_extend_definition_attribute'
                        id: 'b2853f6bf4234142a0c89a1e94ea7cb0'
                    }
                    my_skill__output_response: {
                        table: 'sys_one_extend_definition_attribute'
                        id: '80afe98efbd84fabbae1205b546dfd6f'
                    }
                    my_skill__output_status: {
                        table: 'sys_one_extend_definition_attribute'
                        id: '2c4df31e84c1471899353af7e6fe9b47'
                    }
                    support_prompt_v1: {
                        table: 'sys_generative_ai_config'
                        id: '58204dce698e4236942f7c2d08fccb03'
                    }
                }
                composite: [
                    {
                        table: 'sys_gen_ai_strategy_mapping'
                        id: '10e5ddc6f4c04eeea17dfb2ac89847cb'
                        key: {
                            strategy: 'CAPABILITY_EXECUTION'
                            feature: {
                                id: '5266b71084f748d4af9319785ac249ac'
                                key: {
                                    feature_name: 'Customer Support Helper'
                                    document: 'e0156365ac94450b86885804ae35ed6b'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_one_extend_resource_mapping'
                        id: '4a76686538f44e5384f44fa653de0946'
                        key: {
                            parent_capability: 'e0156365ac94450b86885804ae35ed6b'
                            resource_capability: 'e0156365ac94450b86885804ae35ed6b'
                        }
                    },
                    {
                        table: 'sn_nowassist_skill_config'
                        id: '4cda03a1515e403ab48930d0e6f96409'
                        key: {
                            skill_id: 'e0156365ac94450b86885804ae35ed6b'
                        }
                    },
                    {
                        table: 'sys_gen_ai_feature_mapping'
                        id: '5266b71084f748d4af9319785ac249ac'
                        key: {
                            feature_name: 'Customer Support Helper'
                            document: 'e0156365ac94450b86885804ae35ed6b'
                        }
                    },
                    {
                        table: 'sys_agent_access_role_configuration'
                        id: '871c06a421fa48d695e3cbf3f49e3b2d'
                        key: {
                            agent: '4cda03a1515e403ab48930d0e6f96409'
                        }
                    },
                    {
                        table: 'sn_nowassist_skill_config_status'
                        id: 'bdbcf9a6ec884ca786fee63d45ec0147'
                        key: {
                            skill_config: {
                                id: '4cda03a1515e403ab48930d0e6f96409'
                                key: {
                                    skill_id: 'e0156365ac94450b86885804ae35ed6b'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_generative_ai_prompt_config'
                        id: 'cdf16ff6fdd84bdc8f196f07238e9732'
                        key: {
                            ai_config: '58204dce698e4236942f7c2d08fccb03'
                        }
                    },
                    {
                        table: 'sys_one_extend_capability_definition'
                        id: 'd823a807960c4a5eac319b4a9ad33ab0'
                        key: {
                            capability: 'e0156365ac94450b86885804ae35ed6b'
                            api: '936e514a53b3b110f028ddeeff7b128c'
                        }
                    },
                    {
                        table: 'sys_one_extend_definition_config'
                        id: 'e601639f3a314911acb07141893a44e2'
                        key: {
                            definition: {
                                id: 'd823a807960c4a5eac319b4a9ad33ab0'
                                key: {
                                    capability: 'e0156365ac94450b86885804ae35ed6b'
                                    api: '936e514a53b3b110f028ddeeff7b128c'
                                }
                            }
                            capability: 'e0156365ac94450b86885804ae35ed6b'
                        }
                    },
                ]
            }
        }
    }
}
