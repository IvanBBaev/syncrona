import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    full_acl: {
                        table: 'sys_security_acl'
                        id: '4b2318fdb42d4ce9b63cdf0360974a38'
                    }
                    full_agent: {
                        table: 'sn_aia_agent'
                        id: 'cd65f04152944317a4d531140b8ad539'
                    }
                    minimal_acl: {
                        table: 'sys_security_acl'
                        id: 'ad32fa4dbc73429fbd697dd317288c1c'
                    }
                    minimal_agent: {
                        table: 'sn_aia_agent'
                        id: '33c0da38ee2342b1a36cb7545c7fd645'
                    }
                    public_acl: {
                        table: 'sys_security_acl'
                        id: 'fe02e2968ddf4cfbb5c3296bd81e8961'
                    }
                    public_agent: {
                        table: 'sn_aia_agent'
                        id: 'c9a01837e85e40699f677abfd0586e24'
                    }
                }
                composite: [
                    {
                        table: 'sys_security_acl_role'
                        id: '326167e2e230401e8ad5592f15eb6ff0'
                        key: {
                            sys_security_acl: 'fe02e2968ddf4cfbb5c3296bd81e8961'
                            sys_user_role: 'b0593b350a0a0aa7001d689e4542dc28'
                        }
                    },
                    {
                        table: 'sys_agent_access_role_mapping'
                        id: '3a7d75dd450f4c01bcd525792b5c613b'
                        key: {
                            agent_access_config: {
                                id: 'e0451a6f33c94fbc8bd56ce91d883115'
                                key: {
                                    agent: 'cd65f04152944317a4d531140b8ad539'
                                }
                            }
                            role: {
                                id: '193432dde5394faf8cb5124216d60a55'
                                key: {
                                    name: 'itil'
                                }
                            }
                        }
                    },
                    {
                        table: 'sn_aia_trigger_configuration'
                        id: '429b52620b2947d2aefedd6ab6b0c516'
                        key: {
                            name: 'Create Trigger'
                            usecase: 'NULL'
                        }
                    },
                    {
                        table: 'sn_aia_tool'
                        id: '4ffdd7fb1cc9480ab94b9de1bbc0d59a'
                        key: {
                            name: 'Run Script'
                        }
                    },
                    {
                        table: 'sn_aia_agent_config'
                        id: '531085ef3c404f7a9a11b8bf53af87af'
                        key: {
                            agent: 'cd65f04152944317a4d531140b8ad539'
                        }
                    },
                    {
                        table: 'sys_security_acl_role'
                        id: '631ed49e53a84656b6f4765bbae4bdab'
                        key: {
                            sys_security_acl: '4b2318fdb42d4ce9b63cdf0360974a38'
                            sys_user_role: 'b05926fa0a0a0aa7000130023e0bde98'
                        }
                    },
                    {
                        table: 'sn_aia_agent_tool_m2m'
                        id: '6d93b58f0f044ee7b234e52fb300d174'
                        key: {
                            agent: 'cd65f04152944317a4d531140b8ad539'
                            tool: '4ffdd7fb1cc9480ab94b9de1bbc0d59a'
                            name: 'Run Script'
                        }
                    },
                    {
                        table: 'sn_aia_version'
                        id: '74ef5c5d5c984394abf21da6d6f207df'
                        key: {
                            target_id: 'cd65f04152944317a4d531140b8ad539'
                            version_name: 'V1'
                        }
                    },
                    {
                        table: 'sn_aia_ltm_category_mapping'
                        id: '75da4baff49b42f2bf5b353acd8347ca'
                        key: {
                            entity_id: 'cd65f04152944317a4d531140b8ad539'
                            category: '6b49e262431312107c4d14020ab8f2a9'
                        }
                    },
                    {
                        table: 'sn_aia_agent_tool_m2m'
                        id: '7819065047b247a08c12c2008c40dfae'
                        key: {
                            agent: 'cd65f04152944317a4d531140b8ad539'
                            tool: '576cf8eaffd922101dbaffffffffff66'
                            name: 'Web Search'
                        }
                    },
                    {
                        table: 'sn_aia_trigger_agent_usecase_m2m'
                        id: '808fcb2b89d741a182fd6708448134e5'
                        key: {
                            trigger_configuration: {
                                id: 'dfdaa952004749b8ae73eed27caecca7'
                                key: {
                                    name: 'Daily Trigger'
                                    usecase: 'NULL'
                                }
                            }
                            related_resource_record: 'cd65f04152944317a4d531140b8ad539'
                        }
                    },
                    {
                        table: 'sn_aia_ltm_category_mapping'
                        id: '88760091c95b41578da1cc33c59ad978'
                        key: {
                            entity_id: 'cd65f04152944317a4d531140b8ad539'
                            category: '5c446eae43db52107c4d14020ab8f218'
                        }
                    },
                    {
                        table: 'sys_agent_access_role_configuration'
                        id: '9a234ff46b7b4251bb847e60d55027ce'
                        key: {
                            agent: 'c9a01837e85e40699f677abfd0586e24'
                        }
                    },
                    {
                        table: 'sn_aia_version'
                        id: 'a33f51dd7da64ceaa2f9990f4b936bd0'
                        key: {
                            target_id: '33c0da38ee2342b1a36cb7545c7fd645'
                            version_name: 'Minimal Agent'
                        }
                    },
                    {
                        table: 'sys_security_acl_role'
                        id: 'aa84a5cfe5d34599955878f6e1b115dd'
                        key: {
                            sys_security_acl: '4b2318fdb42d4ce9b63cdf0360974a38'
                            sys_user_role: '282bf1fac6112285017366cb5f867469'
                        }
                    },
                    {
                        table: 'sn_aia_agent_config'
                        id: 'b2ea4284a81e4de7baf13ec40c28c16b'
                        key: {
                            agent: 'c9a01837e85e40699f677abfd0586e24'
                        }
                    },
                    {
                        table: 'sn_aia_agent_config'
                        id: 'bc6294d05de9466085c30745f2b0c874'
                        key: {
                            agent: '33c0da38ee2342b1a36cb7545c7fd645'
                        }
                    },
                    {
                        table: 'sn_aia_version'
                        id: 'd167a0e890584f6bb0e1ba7320a670be'
                        key: {
                            target_id: 'cd65f04152944317a4d531140b8ad539'
                            version_name: 'V2'
                        }
                    },
                    {
                        table: 'sys_agent_access_role_mapping'
                        id: 'd2a3434fbea2434ea858e33077f1c3d4'
                        key: {
                            agent_access_config: {
                                id: 'e0451a6f33c94fbc8bd56ce91d883115'
                                key: {
                                    agent: 'cd65f04152944317a4d531140b8ad539'
                                }
                            }
                            role: {
                                id: 'c0e5b20c8a3d47178f7abf92ed9c09ba'
                                key: {
                                    name: 'admin'
                                }
                            }
                        }
                    },
                    {
                        table: 'sn_aia_trigger_configuration'
                        id: 'dfdaa952004749b8ae73eed27caecca7'
                        key: {
                            name: 'Daily Trigger'
                            usecase: 'NULL'
                        }
                    },
                    {
                        table: 'sys_agent_access_role_configuration'
                        id: 'e0451a6f33c94fbc8bd56ce91d883115'
                        key: {
                            agent: 'cd65f04152944317a4d531140b8ad539'
                        }
                    },
                    {
                        table: 'sn_aia_trigger_agent_usecase_m2m'
                        id: 'ee485dcd9c844aed9b7a842bbb72d447'
                        key: {
                            trigger_configuration: {
                                id: '429b52620b2947d2aefedd6ab6b0c516'
                                key: {
                                    name: 'Create Trigger'
                                    usecase: 'NULL'
                                }
                            }
                            related_resource_record: 'cd65f04152944317a4d531140b8ad539'
                        }
                    },
                    {
                        table: 'sn_aia_version'
                        id: 'f7b5d73b2e364c869e7139b50fe0cfbc'
                        key: {
                            target_id: 'c9a01837e85e40699f677abfd0586e24'
                            version_name: 'Public Agent'
                        }
                    },
                ]
            }
        }
    }
}
