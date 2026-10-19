import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: '1cc0d5d67a9c47fa9bd0a21b23b59ffc'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: 'c7b83c7ea513443b8c16f69cca00b83a'
                    }
                    rel: {
                        table: 'sys_relationship'
                        id: '41675f184cbd489192c06622a6cfb384'
                    }
                }
                composite: [
                    {
                        table: 'sys_ui_list'
                        id: '0830c086c37c44b1aa4649b8823376ee'
                        key: {
                            name: 'incident'
                            view: {
                                id: 'Default view'
                                key: {
                                    name: 'NULL'
                                }
                            }
                            sys_domain: 'global'
                            element: 'NULL'
                            relationship: 'NULL'
                            parent: 'NULL'
                        }
                    },
                    {
                        table: 'sys_ui_list'
                        id: '08a8e852f121435eb11d511e855e99f4'
                        key: {
                            name: 'x_snc_bprobe_sub'
                            view: {
                                id: 'c0652f644de74db690e7f9cae70fd927'
                                key: {
                                    name: 'x_snc_bprobe_byname'
                                }
                            }
                            sys_domain: 'mydomain'
                            element: 'NULL'
                            relationship: 'NULL'
                            parent: 'x_snc_bprobe_task'
                        }
                    },
                    {
                        table: 'sys_ui_list'
                        id: '12c531e963fd455189be59900ee22038'
                        key: {
                            name: 'x_snc_bprobe_expense'
                            view: {
                                id: 'e44dd44c7d824eb6a255e5bfd2a56937'
                                key: {
                                    name: 'x_snc_bprobe_detailed'
                                }
                            }
                            sys_domain: 'global'
                            element: 'NULL'
                            relationship: 'NULL'
                            parent: 'NULL'
                        }
                    },
                    {
                        table: 'sys_ui_list_element'
                        id: '4ed066dc5dfe438992614f6dc5f2372a'
                        key: {
                            list_id: {
                                id: '0830c086c37c44b1aa4649b8823376ee'
                                key: {
                                    name: 'incident'
                                    view: {
                                        id: 'Default view'
                                        key: {
                                            name: 'NULL'
                                        }
                                    }
                                    sys_domain: 'global'
                                    element: 'NULL'
                                    relationship: 'NULL'
                                    parent: 'NULL'
                                }
                            }
                            element: 'short_description'
                        }
                    },
                    {
                        table: 'sys_ui_list_element'
                        id: '89bf5b8af7f1497d9d725cccc6198cf5'
                        key: {
                            list_id: {
                                id: '12c531e963fd455189be59900ee22038'
                                key: {
                                    name: 'x_snc_bprobe_expense'
                                    view: {
                                        id: 'e44dd44c7d824eb6a255e5bfd2a56937'
                                        key: {
                                            name: 'x_snc_bprobe_detailed'
                                        }
                                    }
                                    sys_domain: 'global'
                                    element: 'NULL'
                                    relationship: 'NULL'
                                    parent: 'NULL'
                                }
                            }
                            element: 'other'
                        }
                    },
                    {
                        table: 'sys_ui_list_element'
                        id: 'a51a1139106a494881714a2598f3f69d'
                        key: {
                            list_id: {
                                id: 'b9b29732134a438ab789cfa6dbec176c'
                                key: {
                                    name: 'x_snc_bprobe_sub'
                                    view: {
                                        id: 'Default view'
                                        key: {
                                            name: 'NULL'
                                        }
                                    }
                                    sys_domain: 'global'
                                    element: 'NULL'
                                    relationship: '41675f184cbd489192c06622a6cfb384'
                                    parent: 'x_snc_bprobe_task'
                                }
                            }
                            element: 'state'
                        }
                    },
                    {
                        table: 'sys_ui_list_element'
                        id: 'a60e14e0b35d4b9cb6fa9ed34d0d80b2'
                        key: {
                            list_id: {
                                id: '0830c086c37c44b1aa4649b8823376ee'
                                key: {
                                    name: 'incident'
                                    view: {
                                        id: 'Default view'
                                        key: {
                                            name: 'NULL'
                                        }
                                    }
                                    sys_domain: 'global'
                                    element: 'NULL'
                                    relationship: 'NULL'
                                    parent: 'NULL'
                                }
                            }
                            element: 'caller_id.name'
                        }
                    },
                    {
                        table: 'sys_ui_list_element'
                        id: 'a8d4ffcdf8934cdd8601633064e90871'
                        key: {
                            list_id: {
                                id: '12c531e963fd455189be59900ee22038'
                                key: {
                                    name: 'x_snc_bprobe_expense'
                                    view: {
                                        id: 'e44dd44c7d824eb6a255e5bfd2a56937'
                                        key: {
                                            name: 'x_snc_bprobe_detailed'
                                        }
                                    }
                                    sys_domain: 'global'
                                    element: 'NULL'
                                    relationship: 'NULL'
                                    parent: 'NULL'
                                }
                            }
                            element: 'category'
                        }
                    },
                    {
                        table: 'sys_ui_list_element'
                        id: 'ab9544353f3d4a9e9122631ade4d97c7'
                        key: {
                            list_id: {
                                id: '12c531e963fd455189be59900ee22038'
                                key: {
                                    name: 'x_snc_bprobe_expense'
                                    view: {
                                        id: 'e44dd44c7d824eb6a255e5bfd2a56937'
                                        key: {
                                            name: 'x_snc_bprobe_detailed'
                                        }
                                    }
                                    sys_domain: 'global'
                                    element: 'NULL'
                                    relationship: 'NULL'
                                    parent: 'NULL'
                                }
                            }
                            element: 'amount'
                        }
                    },
                    {
                        table: 'sys_ui_list'
                        id: 'b9b29732134a438ab789cfa6dbec176c'
                        key: {
                            name: 'x_snc_bprobe_sub'
                            view: {
                                id: 'Default view'
                                key: {
                                    name: 'NULL'
                                }
                            }
                            sys_domain: 'global'
                            element: 'NULL'
                            relationship: '41675f184cbd489192c06622a6cfb384'
                            parent: 'x_snc_bprobe_task'
                        }
                    },
                    {
                        table: 'sys_ui_list_element'
                        id: 'bc7b20d213d6467ba1b91fbb94ec271a'
                        key: {
                            list_id: {
                                id: '12c531e963fd455189be59900ee22038'
                                key: {
                                    name: 'x_snc_bprobe_expense'
                                    view: {
                                        id: 'e44dd44c7d824eb6a255e5bfd2a56937'
                                        key: {
                                            name: 'x_snc_bprobe_detailed'
                                        }
                                    }
                                    sys_domain: 'global'
                                    element: 'NULL'
                                    relationship: 'NULL'
                                    parent: 'NULL'
                                }
                            }
                            element: 'date'
                        }
                    },
                    {
                        table: 'sys_ui_list'
                        id: 'c262350a8e4e4fe5b70d88954ed83d20'
                        key: {
                            name: 'x_snc_bprobe_sub'
                            view: {
                                id: 'e44dd44c7d824eb6a255e5bfd2a56937'
                                key: {
                                    name: 'x_snc_bprobe_detailed'
                                }
                            }
                            sys_domain: 'global'
                            element: 'NULL'
                            relationship: '0123456789abcdef0123456789abcdef'
                            parent: 'NULL'
                        }
                    },
                    {
                        table: 'sys_ui_list_element'
                        id: 'd0ed822bdb504ddbb0d96caee0260860'
                        key: {
                            list_id: {
                                id: '08a8e852f121435eb11d511e855e99f4'
                                key: {
                                    name: 'x_snc_bprobe_sub'
                                    view: {
                                        id: 'c0652f644de74db690e7f9cae70fd927'
                                        key: {
                                            name: 'x_snc_bprobe_byname'
                                        }
                                    }
                                    sys_domain: 'mydomain'
                                    element: 'NULL'
                                    relationship: 'NULL'
                                    parent: 'x_snc_bprobe_task'
                                }
                            }
                            element: 'short_description'
                        }
                    },
                    {
                        table: 'sys_ui_view'
                        id: 'e44dd44c7d824eb6a255e5bfd2a56937'
                        key: {
                            name: 'x_snc_bprobe_detailed'
                        }
                    },
                    {
                        table: 'sys_ui_list_element'
                        id: 'f05ff16d915547f0b3aa02760b42794a'
                        key: {
                            list_id: {
                                id: '0830c086c37c44b1aa4649b8823376ee'
                                key: {
                                    name: 'incident'
                                    view: {
                                        id: 'Default view'
                                        key: {
                                            name: 'NULL'
                                        }
                                    }
                                    sys_domain: 'global'
                                    element: 'NULL'
                                    relationship: 'NULL'
                                    parent: 'NULL'
                                }
                            }
                            element: 'number'
                        }
                    },
                ]
            }
        }
    }
}
