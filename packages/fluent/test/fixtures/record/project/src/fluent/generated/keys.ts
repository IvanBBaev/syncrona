import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    '0123456789abcdef0123456789abcdef': {
                        table: 'x_snc_bprobe_thing'
                        id: '0123456789abcdef0123456789abcdef'
                    }
                    bom_json: {
                        table: 'sys_module'
                        id: '28ffa88c353f4f059ca2f2697189eca8'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: 'a68494a2dc794d3a835809f54855dd1f'
                    }
                    rec_demo: {
                        table: 'x_snc_bprobe_thing'
                        id: '6d30429306064140a8439bbd870a510d'
                    }
                    rec_edge: {
                        table: 'x_snc_bprobe_thing'
                        id: 'a1d7227fd8494ee1949ebfa427c83b1c'
                    }
                    rec_plain: {
                        table: 'x_snc_bprobe_thing'
                        id: '8b2dd6cadc804957b42506ddd02e17d6'
                    }
                    rec_prop: {
                        table: 'sys_properties'
                        id: 'd798befc03fe4f39b8d77b3660e07e4d'
                    }
                    rec_refs: {
                        table: 'x_snc_bprobe_thing'
                        id: '3d2658318c6e40cf9a36ea816c04be21'
                    }
                    rec_role_ref: {
                        table: 'sys_user_has_role'
                        id: '57ba6f64156041d98498a57566032b8d'
                    }
                    rec_ua: {
                        table: 'sys_ui_action'
                        id: '4bf5129b56954d0ba3655d71e17e2368'
                    }
                    rec_ua2: {
                        table: 'sys_ui_action'
                        id: '02cddd358c024d23a78448224eb0556e'
                    }
                }
                composite: [
                    {
                        table: 'sys_ui_action_view'
                        id: '166ac721880840c1a334b709702ed6a6'
                        key: {
                            sys_ui_action: '02cddd358c024d23a78448224eb0556e'
                            sys_ui_view: {
                                id: 'Default view'
                                key: {
                                    name: 'NULL'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_user_role_contains'
                        id: '2f093454f5c042c7befd2875901f0c13'
                        key: {
                            role: {
                                id: '79e35298f74f4470b694cb03fe4af2f9'
                                key: {
                                    name: 'x_snc_bprobe.via_record'
                                }
                            }
                            contains: {
                                id: 'b0eeab4ab4674c5299db0362212fdbef'
                                key: {
                                    name: 'itil'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_ui_action_role'
                        id: '2f17bd8884f24713a93500b6c40d48cf'
                        key: {
                            sys_ui_action: '02cddd358c024d23a78448224eb0556e'
                            sys_user_role: {
                                id: 'b0eeab4ab4674c5299db0362212fdbef'
                                key: {
                                    name: 'itil'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_user_role'
                        id: '788724aa2f634f19afd35ea98bb69a7d'
                        key: {
                            name: 'x_snc_bprobe.manager'
                        }
                    },
                    {
                        table: 'sys_user_role'
                        id: '79e35298f74f4470b694cb03fe4af2f9'
                        key: {
                            name: 'x_snc_bprobe.via_record'
                        }
                    },
                    {
                        table: 'sys_ui_action_role'
                        id: 'e49910663f5040ae8580756b0d056fc0'
                        key: {
                            sys_ui_action: '02cddd358c024d23a78448224eb0556e'
                            sys_user_role: {
                                id: '788724aa2f634f19afd35ea98bb69a7d'
                                key: {
                                    name: 'x_snc_bprobe.manager'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_ui_action_view'
                        id: 'ef444208bc294d3fa9691c2a2f844eb7'
                        key: {
                            sys_ui_action: '02cddd358c024d23a78448224eb0556e'
                            sys_ui_view: {
                                id: 'e26d1b382d2b420e9406730afe496e67'
                                key: {
                                    name: 'mobile'
                                }
                            }
                        }
                    },
                ]
            }
        }
    }
}
