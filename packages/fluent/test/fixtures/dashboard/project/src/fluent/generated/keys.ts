import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bare: {
                        table: 'par_dashboard'
                        id: 'c0f9eba0f59d4d90950ffb78abc0dc2d'
                    }
                    bom_json: {
                        table: 'sys_module'
                        id: 'ddc246a2eee349929c3695809322e15b'
                    }
                    ops: {
                        table: 'par_dashboard'
                        id: '2c030594ec7349398bf8ebf019ae6645'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '462167b8594c471695d828e3030f4141'
                    }
                    space: {
                        table: 'sys_ux_page_registry'
                        id: '73391a4a7a6d4f118381de6cde20a84f'
                    }
                    space_sys_ux_app_config_workspace: {
                        table: 'sys_ux_app_config'
                        id: '64739e81d80b47a295d7c0d45c34cb52'
                    }
                    space_sys_ux_app_route_home: {
                        table: 'sys_ux_app_route'
                        id: 'ff6938e7374e48cb9b05033aec7037d9'
                    }
                    space_sys_ux_app_route_list: {
                        table: 'sys_ux_app_route'
                        id: '3953bffbce404a2f96a1d2dd564d896c'
                    }
                    space_sys_ux_app_route_record: {
                        table: 'sys_ux_app_route'
                        id: '4f785f0487674378973191a9ec1549f8'
                    }
                    'space_sys_ux_app_route_simple-list': {
                        table: 'sys_ux_app_route'
                        id: '13c38e4d192a4415a8670306b2adee8b'
                    }
                    space_sys_ux_macroponent_record: {
                        table: 'sys_ux_macroponent'
                        id: 'd1dad31c97984d5da5c1357a538e7442'
                    }
                    space_sys_ux_page_property_chrome_footer: {
                        table: 'sys_ux_page_property'
                        id: '2b295e11a2e64dfcb8461c9d9a32859f'
                    }
                    space_sys_ux_page_property_chrome_header: {
                        table: 'sys_ux_page_property'
                        id: 'bd00f158be424625ba57717ba9b9e15d'
                    }
                    space_sys_ux_page_property_chrome_tab: {
                        table: 'sys_ux_page_property'
                        id: '2a1a25380fad41eabe94a7ea362b6c8a'
                    }
                    space_sys_ux_page_property_chrome_toolbar: {
                        table: 'sys_ux_page_property'
                        id: 'cc94b49a2d64438f892d02cf9905185e'
                    }
                    space_sys_ux_page_property_listConfigId: {
                        table: 'sys_ux_page_property'
                        id: '397bcaba88894ec4b727fc66eeccba33'
                    }
                    space_sys_ux_page_property_view: {
                        table: 'sys_ux_page_property'
                        id: '1b50cf430d884b00b75cc855e99045a7'
                    }
                    space_sys_ux_page_property_wbApplicabilityConfigId: {
                        table: 'sys_ux_page_property'
                        id: '8451a39178dc4954b2a7d9731c9655a2'
                    }
                    space_sys_ux_registry_m2m_category_unifiedNav: {
                        table: 'sys_ux_registry_m2m_category'
                        id: 'a886263b5fbe46498f6169121fc52d0b'
                    }
                    space_sys_ux_screen_home: {
                        table: 'sys_ux_screen'
                        id: '9385b7c5959e419a83aa4b3f385979a0'
                    }
                    space_sys_ux_screen_list: {
                        table: 'sys_ux_screen'
                        id: '45b48a85defd468697cae2927ef86a62'
                    }
                    space_sys_ux_screen_record: {
                        table: 'sys_ux_screen'
                        id: '9b1d2cd899134fa786f8a2ce33b3177e'
                    }
                    'space_sys_ux_screen_simple-list': {
                        table: 'sys_ux_screen'
                        id: '02eb50b59af24e378802b5ae18667784'
                    }
                    space_sys_ux_screen_type_home: {
                        table: 'sys_ux_screen_type'
                        id: '26122d2df9c54b17b68a067eebd1d85e'
                    }
                    space_sys_ux_screen_type_list: {
                        table: 'sys_ux_screen_type'
                        id: 'e8aac8b9246a44fb8a7d293a01391b4c'
                    }
                    space_sys_ux_screen_type_record: {
                        table: 'sys_ux_screen_type'
                        id: 'e46a6d2f52254e34ac02f25a08ae377b'
                    }
                    'space_sys_ux_screen_type_simple-list': {
                        table: 'sys_ux_screen_type'
                        id: '8f22fa14c2cf416f995156007508871a'
                    }
                    tab_hidden: {
                        table: 'par_dashboard_tab'
                        id: 'a900e711d8244f14a24f97e8db876b54'
                    }
                    tab_main: {
                        table: 'par_dashboard_tab'
                        id: '024475e50afc44708d1dae58b3b78590'
                    }
                    top_heading: {
                        table: 'par_dashboard_widget'
                        id: '86556f2d04ad4ed38f9e30a8c38e381a'
                    }
                    w_custom: {
                        table: 'par_dashboard_widget'
                        id: '97971211a06243e6914ed9b090849fb3'
                    }
                    w_score: {
                        table: 'par_dashboard_widget'
                        id: '4e2a5a7673e440ae82cf231464e93441'
                    }
                }
                composite: [
                    {
                        table: 'par_dashboard_visibility'
                        id: '0086d6b035ea40cdab5e028a9efb3203'
                        key: {
                            dashboard: 'c0f9eba0f59d4d90950ffb78abc0dc2d'
                            experience: '08c73d60537101100834ddeeff7b1287'
                        }
                    },
                    {
                        table: 'par_dashboard_permission'
                        id: '04a06c0e4e084c0481525e5303e70431'
                        key: {
                            dashboard: '2c030594ec7349398bf8ebf019ae6645'
                            user: 'NULL'
                            group: '019ad92ec7230010393d265c95c260dd'
                            role: 'NULL'
                        }
                    },
                    {
                        table: 'par_dashboard_canvas'
                        id: '0b640c66a5ec4fc3ba9c5e5e894693b5'
                        key: {
                            dashboard: '2c030594ec7349398bf8ebf019ae6645'
                            dashboard_tab: 'NULL'
                        }
                    },
                    {
                        table: 'sys_user_role'
                        id: '4542480c990b45279e23c488878a828b'
                        key: {
                            name: 'x_snc_bprobe.viewer'
                        }
                    },
                    {
                        table: 'par_dashboard_permission'
                        id: '616c1e1680bb40a8bbd251240fe108ea'
                        key: {
                            dashboard: '2c030594ec7349398bf8ebf019ae6645'
                            user: 'NULL'
                            group: 'NULL'
                            role: 'x_snc_bprobe.viewer'
                        }
                    },
                    {
                        table: 'par_dashboard_visibility'
                        id: '72cd8ef1d47a417488ce00e5cd0c34a6'
                        key: {
                            dashboard: '2c030594ec7349398bf8ebf019ae6645'
                            experience: 'a84adaf4c700201072b211d4d8c260b7'
                        }
                    },
                    {
                        table: 'par_dashboard_visibility'
                        id: '7ad78e1d60c94274a763b911b97701d0'
                        key: {
                            dashboard: '2c030594ec7349398bf8ebf019ae6645'
                            experience: '73391a4a7a6d4f118381de6cde20a84f'
                        }
                    },
                    {
                        table: 'par_dashboard_canvas'
                        id: '9fefb8edd1584bfda1a2e468e2eb7274'
                        key: {
                            dashboard: '2c030594ec7349398bf8ebf019ae6645'
                            dashboard_tab: '024475e50afc44708d1dae58b3b78590'
                        }
                    },
                    {
                        table: 'par_dashboard_permission'
                        id: 'b2f3226a31304decae9e361774c0f22b'
                        key: {
                            dashboard: '2c030594ec7349398bf8ebf019ae6645'
                            user: '6816f79cc0a8016401c5a33be04be441'
                            group: 'NULL'
                            role: 'NULL'
                        }
                    },
                    {
                        table: 'par_dashboard_canvas'
                        id: 'd8a0ebe987124d71af320ef8ba01363f'
                        key: {
                            dashboard: '2c030594ec7349398bf8ebf019ae6645'
                            dashboard_tab: 'a900e711d8244f14a24f97e8db876b54'
                        }
                    },
                ]
            }
        }
    }
}
