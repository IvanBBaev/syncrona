import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: 'efda51649e2046c2913b8dea24cca447'
                    }
                    csp_exec: {
                        table: 'sys_scope_privilege'
                        id: 'beac273a46754b1888f3a78cf8cec698'
                    }
                    csp_read: {
                        table: 'sys_scope_privilege'
                        id: '11ff02b32e414efdad1c54a9f762e550'
                    }
                    menu_full: {
                        table: 'sys_app_application'
                        id: '486a2bbec8144051b728c6b49825deb1'
                    }
                    menu_min: {
                        table: 'sys_app_application'
                        id: '340d2d3776ab4f31872bc391c47839e0'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '5731c7fcc6f64fce99b78d2cb2aee89e'
                    }
                    pref_bool: {
                        table: 'sys_user_preference'
                        id: '736abf776a294c909d274c6398a41be1'
                    }
                    pref_full: {
                        table: 'sys_user_preference'
                        id: 'bdfe4422bea54ceea223735afb0f798d'
                    }
                    pref_min: {
                        table: 'sys_user_preference'
                        id: 'dcf4d7ef8a9d4d359f5d107a9c7a2c64'
                    }
                    src_server_simple_server_js: {
                        table: 'sys_module'
                        id: 'd1c45910159141118390e3ca5c59fce7'
                    }
                }
                composite: [
                    {
                        table: 'sys_dictionary'
                        id: '281024bb4bd44a37acfa9e11147b39d5'
                        key: {
                            name: 'x_snc_bprobe_ui'
                            element: 'caller_id'
                        }
                    },
                    {
                        table: 'sys_documentation'
                        id: '2bc7220535cb437bb1f519ea0e7ed3d3'
                        key: {
                            name: 'x_snc_bprobe_ui'
                            element: 'caller_id'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_ui_policy_action'
                        id: '4946ffb11e2748c4846f1415029e86a1'
                        key: {
                            ui_policy: {
                                id: '88116b537e6d4b1eac10f0de566c3dd7'
                                key: {
                                    table: 'x_snc_bprobe_ui'
                                    short_description: 'Full policy'
                                }
                            }
                            field: 'caller_id'
                        }
                    },
                    {
                        table: 'sys_documentation'
                        id: '559bb82b6f0941bba1bfafb22fc0f20e'
                        key: {
                            name: 'x_snc_bprobe_ui'
                            element: 'NULL'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_documentation'
                        id: '5778f20a474d41109ef331ec51ec6fd2'
                        key: {
                            name: 'x_snc_bprobe_ui'
                            element: 'description'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_documentation'
                        id: '674c9ec9b20d414bba906e9fbb880df0'
                        key: {
                            name: 'x_snc_bprobe_ui'
                            element: 'short_description'
                            language: 'en'
                        }
                    },
                    {
                        table: 'sys_user_role'
                        id: '6c5cb0fcbdca4b0da5e9ae336dea59b9'
                        key: {
                            name: 'x_snc_bprobe.menu_user'
                        }
                    },
                    {
                        table: 'sys_ui_policy_action'
                        id: '7aead42c072840639599565750939b2c'
                        key: {
                            ui_policy: {
                                id: '88116b537e6d4b1eac10f0de566c3dd7'
                                key: {
                                    table: 'x_snc_bprobe_ui'
                                    short_description: 'Full policy'
                                }
                            }
                            field: 'description'
                        }
                    },
                    {
                        table: 'sys_ui_policy'
                        id: '88116b537e6d4b1eac10f0de566c3dd7'
                        key: {
                            table: 'x_snc_bprobe_ui'
                            short_description: 'Full policy'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: '9148d6b13e794d428bf1880e1244f73d'
                        key: {
                            name: 'x_snc_bprobe_ui'
                            element: 'short_description'
                        }
                    },
                    {
                        table: 'sys_ui_policy_action'
                        id: '9cfa70ad5b184a9b8eae57676f7d3b60'
                        key: {
                            ui_policy: {
                                id: '88116b537e6d4b1eac10f0de566c3dd7'
                                key: {
                                    table: 'x_snc_bprobe_ui'
                                    short_description: 'Full policy'
                                }
                            }
                            field: 'short_description'
                        }
                    },
                    {
                        table: 'sys_ui_policy_rl_action'
                        id: 'accdfb3705ad420fba6d9c585e388ba4'
                        key: {
                            ui_policy: {
                                id: '88116b537e6d4b1eac10f0de566c3dd7'
                                key: {
                                    table: 'x_snc_bprobe_ui'
                                    short_description: 'Full policy'
                                }
                            }
                            list: 'x_snc_bprobe_ui.caller_id'
                        }
                    },
                    {
                        table: 'ua_table_licensing_config'
                        id: 'd1866598bc3442eaaad47901df8adff0'
                        key: {
                            name: 'x_snc_bprobe_ui'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: 'd20882391f4b467e981fbc37af6dc5c5'
                        key: {
                            name: 'x_snc_bprobe_ui'
                            element: 'description'
                        }
                    },
                    {
                        table: 'sys_db_object'
                        id: 'd3ee5e61429645a184b649791c4152d5'
                        key: {
                            name: 'x_snc_bprobe_ui'
                        }
                    },
                    {
                        table: 'sys_dictionary'
                        id: 'e1833ec7e8384d668f42443719c773d9'
                        key: {
                            name: 'x_snc_bprobe_ui'
                            element: 'NULL'
                        }
                    },
                    {
                        table: 'sys_ui_policy_rl_action'
                        id: 'e528c03647d94146afc7aa7de83fd95a'
                        key: {
                            ui_policy: {
                                id: '88116b537e6d4b1eac10f0de566c3dd7'
                                key: {
                                    table: 'x_snc_bprobe_ui'
                                    short_description: 'Full policy'
                                }
                            }
                            list: 'REL:b9b7e1a0c0a8016400b98a06818d57c7'
                        }
                    },
                    {
                        table: 'sys_ui_policy'
                        id: 'fc645fcd832e40a6b26d8c005b2f9a22'
                        key: {
                            table: 'NULL'
                            short_description: 'Minimal policy'
                        }
                    },
                ]
            }
        }
    }
}
