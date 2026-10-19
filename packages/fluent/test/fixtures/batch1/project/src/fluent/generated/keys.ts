import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    '42': {
                        table: 'sys_script_include'
                        id: 'a5298eea800e427aa84d4e3b6a17ab9e'
                    }
                    acl_full: {
                        table: 'sys_security_acl'
                        id: '9cb219d8c8da486cb6ba56c5f53a604c'
                    }
                    acl_min: {
                        table: 'sys_security_acl'
                        id: 'b469da4325764c8baf8fbee9fbe25ae4'
                    }
                    acl_rest: {
                        table: 'sys_security_acl'
                        id: '711f224a6a1941f48aec5e76037ea64c'
                    }
                    bom_json: {
                        table: 'sys_module'
                        id: 'c17be2dde3604b6cb7597d7e626ef325'
                    }
                    br_full: {
                        table: 'sys_script'
                        id: '8608a455299b436294963de3f102e519'
                    }
                    br_min: {
                        table: 'sys_script'
                        id: '78921f72598646c59e4c85a8c8541ea5'
                    }
                    cs_full: {
                        table: 'sys_script_client'
                        id: '07b695dde01c440c9f1699496c72156c'
                    }
                    cs_min: {
                        table: 'sys_script_client'
                        id: '380a16f0d1094952b2f87e41d8a4107a'
                    }
                    p_bool: {
                        table: 'sys_properties'
                        id: '17717c7b362b42cd90ae5d4c68e2180e'
                    }
                    p_choice: {
                        table: 'sys_properties'
                        id: 'b43b33c396a54f51a3df2c463eddf048'
                    }
                    p_int: {
                        table: 'sys_properties'
                        id: '0a54cd9d41e64c5480c0858479e04a46'
                    }
                    p_min: {
                        table: 'sys_properties'
                        id: 'd6ac6f70a5974398962a6fc6a4bb0360'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '5e807a8dcc294cab8c2eeb13e857469e'
                    }
                    si_full: {
                        table: 'sys_script_include'
                        id: '05f2733779094d2eb4534f516ac22895'
                    }
                    si_min: {
                        table: 'sys_script_include'
                        id: '5df66cafb0354009a7e5e24662f5ed2a'
                    }
                    si_plain_id: {
                        table: 'sys_script_include'
                        id: 'd9772d6acf124bdc922950c6ef48687b'
                    }
                    src_server_si_Included_server_js: {
                        table: 'sys_module'
                        id: 'cb4091b0d0d04888a1b93e33c9d107b6'
                    }
                    ua_full: {
                        table: 'sys_ui_action'
                        id: 'f3f802813f7449e3a7b6de3a2907528d'
                    }
                    ua_min: {
                        table: 'sys_ui_action'
                        id: 'd0265019a6f448b288a618450edd339d'
                    }
                }
                composite: [
                    {
                        table: 'sys_ui_action_role'
                        id: '007743f1b5fc46f8855c954da477e9b4'
                        key: {
                            sys_ui_action: 'f3f802813f7449e3a7b6de3a2907528d'
                            sys_user_role: {
                                id: '19412ce8f2894686bb0f45e2d56fa407'
                                key: {
                                    name: 'x_snc_bprobe.manager'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_security_acl_role'
                        id: '02e7d97896b04626a14beb6466b18375'
                        key: {
                            sys_security_acl: '9cb219d8c8da486cb6ba56c5f53a604c'
                            sys_user_role: {
                                id: '3a040284ff6444e1a1e9ad2433ec77ec'
                                key: {
                                    name: 'itil'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_ui_action_role'
                        id: '08b76cced0a748818e6123c157f831b4'
                        key: {
                            sys_ui_action: 'f3f802813f7449e3a7b6de3a2907528d'
                            sys_user_role: {
                                id: '3a040284ff6444e1a1e9ad2433ec77ec'
                                key: {
                                    name: 'itil'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_user_role'
                        id: '19412ce8f2894686bb0f45e2d56fa407'
                        key: {
                            name: 'x_snc_bprobe.manager'
                        }
                    },
                    {
                        table: 'sys_ui_action_view'
                        id: '2337e414a3e7428683f8c64ebc116a08'
                        key: {
                            sys_ui_action: 'f3f802813f7449e3a7b6de3a2907528d'
                            sys_ui_view: {
                                id: 'a3e7143618434f6fb631bec5e9d37867'
                                key: {
                                    name: 'ess'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_security_acl_role'
                        id: '6b67e3b4b0344ed481e69c13f23cae4c'
                        key: {
                            sys_security_acl: '9cb219d8c8da486cb6ba56c5f53a604c'
                            sys_user_role: {
                                id: 'ad1b3fb6a6814917a7caa2a18297120c'
                                key: {
                                    name: 'x_snc_bprobe.user'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_user_role_contains'
                        id: '76928bdf36d6486794bdf599c68432d0'
                        key: {
                            role: {
                                id: '19412ce8f2894686bb0f45e2d56fa407'
                                key: {
                                    name: 'x_snc_bprobe.manager'
                                }
                            }
                            contains: {
                                id: '4ba814936842427b9c26352eaa10aa01'
                                key: {
                                    name: 'itil'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_security_acl_role'
                        id: '8381affad1664f9da91040bd7103ad8b'
                        key: {
                            sys_security_acl: '711f224a6a1941f48aec5e76037ea64c'
                            sys_user_role: {
                                id: 'd0bb664c5e44405b86917e3b4e375d75'
                                key: {
                                    name: 'admin'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_ui_action_view'
                        id: '97cf83524d6b4d7d91dcfaed97f3c9eb'
                        key: {
                            sys_ui_action: 'f3f802813f7449e3a7b6de3a2907528d'
                            sys_ui_view: {
                                id: '5d474dfb02464beea0a9cdcbefc51ba8'
                                key: {
                                    name: 'itil'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_user_role'
                        id: 'ad1b3fb6a6814917a7caa2a18297120c'
                        key: {
                            name: 'x_snc_bprobe.user'
                        }
                    },
                    {
                        table: 'sys_security_acl_role'
                        id: 'adb4604e0f8f4f71b1150e1272e99d3b'
                        key: {
                            sys_security_acl: '9cb219d8c8da486cb6ba56c5f53a604c'
                            sys_user_role: {
                                id: '19412ce8f2894686bb0f45e2d56fa407'
                                key: {
                                    name: 'x_snc_bprobe.manager'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_user_role_contains'
                        id: 'c1fa89c67c9446c7b71d0605afffb911'
                        key: {
                            role: {
                                id: '19412ce8f2894686bb0f45e2d56fa407'
                                key: {
                                    name: 'x_snc_bprobe.manager'
                                }
                            }
                            contains: {
                                id: 'ad1b3fb6a6814917a7caa2a18297120c'
                                key: {
                                    name: 'x_snc_bprobe.user'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_ui_action_view'
                        id: 'e16b6fdc8ac5417582045ec4ae0e6a52'
                        key: {
                            sys_ui_action: 'f3f802813f7449e3a7b6de3a2907528d'
                            sys_ui_view: {
                                id: 'ff95c756bce8438fa037217adbe8cec2'
                                key: {
                                    name: 'default'
                                }
                            }
                        }
                    },
                ]
            }
        }
    }
}
