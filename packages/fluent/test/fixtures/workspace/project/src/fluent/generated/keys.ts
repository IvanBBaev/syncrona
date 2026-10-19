import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: '8472de07a4ae4137bc3b5b153ce1deac'
                    }
                    incidents_category: {
                        table: 'sys_ux_list_category'
                        id: '7c250406bcbb49a7b6f327473f1a1ec3'
                    }
                    incidents_open: {
                        table: 'sys_ux_list'
                        id: '75e825bb54874d17b43c39fa61f65c2d'
                    }
                    incidents_open_applicability: {
                        table: 'sys_ux_applicability_m2m_list'
                        id: 'e7c683a5be3c4a739418cfd96e6a1019'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '60ec2780f54345d09e08b9f33b804916'
                    }
                    workspace_applicability: {
                        table: 'sys_ux_applicability'
                        id: 'e1f8d68e6737402fa2f66d31920b838c'
                    }
                    workspace_list_config: {
                        table: 'sys_ux_list_menu_config'
                        id: '9c12beba98b74b7fb593c367389602e8'
                    }
                    'workspace-with-list': {
                        table: 'sys_ux_page_registry'
                        id: '3e9b81b8e94545e59c93cd781b066ef7'
                    }
                    'workspace-with-list_sys_ux_app_config_workspace': {
                        table: 'sys_ux_app_config'
                        id: 'bf6ce86f098346ec8c4d720f261f75c2'
                    }
                    'workspace-with-list_sys_ux_app_route_home': {
                        table: 'sys_ux_app_route'
                        id: 'e0009d9f69a8443793f7d63bee7a50df'
                    }
                    'workspace-with-list_sys_ux_app_route_list': {
                        table: 'sys_ux_app_route'
                        id: '1c6782b580af4283a7a18adf2da3d2bb'
                    }
                    'workspace-with-list_sys_ux_app_route_record': {
                        table: 'sys_ux_app_route'
                        id: '42d2dac434b642629ba46458b4c040d0'
                    }
                    'workspace-with-list_sys_ux_app_route_simple-list': {
                        table: 'sys_ux_app_route'
                        id: '15fa1a6ec2d0446d92fcb4b38fbe2b56'
                    }
                    'workspace-with-list_sys_ux_macroponent_record': {
                        table: 'sys_ux_macroponent'
                        id: '816a4d0e355d4b9b81d283e2eab1a72e'
                    }
                    'workspace-with-list_sys_ux_page_property_chrome_footer': {
                        table: 'sys_ux_page_property'
                        id: 'febf98cece764fb487ddea9c9143df86'
                    }
                    'workspace-with-list_sys_ux_page_property_chrome_header': {
                        table: 'sys_ux_page_property'
                        id: 'a0cab0da17674dd6b956e1b8ebc9e68b'
                    }
                    'workspace-with-list_sys_ux_page_property_chrome_tab': {
                        table: 'sys_ux_page_property'
                        id: '15ca183300b848e0bf34c2a33d8a564f'
                    }
                    'workspace-with-list_sys_ux_page_property_chrome_toolbar': {
                        table: 'sys_ux_page_property'
                        id: 'edd7ab41056545438373d63f8e162474'
                    }
                    'workspace-with-list_sys_ux_page_property_listConfigId': {
                        table: 'sys_ux_page_property'
                        id: 'b45ff5f7d2b2490e8846b40fba1eb1ef'
                    }
                    'workspace-with-list_sys_ux_page_property_view': {
                        table: 'sys_ux_page_property'
                        id: 'f5865ccaef2546fa94a891a2328a3b72'
                    }
                    'workspace-with-list_sys_ux_page_property_wbApplicabilityConfigId': {
                        table: 'sys_ux_page_property'
                        id: 'b7cb9f372c5a40dfbbd4ccbe725d8fd3'
                    }
                    'workspace-with-list_sys_ux_registry_m2m_category_unifiedNav': {
                        table: 'sys_ux_registry_m2m_category'
                        id: '851b7737c6cc43ab9ae4d4a6023402f0'
                    }
                    'workspace-with-list_sys_ux_screen_home': {
                        table: 'sys_ux_screen'
                        id: '4f46c60f838e43faa3fa23e6b0626cb0'
                    }
                    'workspace-with-list_sys_ux_screen_list': {
                        table: 'sys_ux_screen'
                        id: 'a34ec7c9cc914d458ed4c75403cc8956'
                    }
                    'workspace-with-list_sys_ux_screen_record': {
                        table: 'sys_ux_screen'
                        id: '89f35259db3f41e9b31fc5d4f4334702'
                    }
                    'workspace-with-list_sys_ux_screen_simple-list': {
                        table: 'sys_ux_screen'
                        id: 'a5f63428f7a14632841b9d5747523253'
                    }
                    'workspace-with-list_sys_ux_screen_type_home': {
                        table: 'sys_ux_screen_type'
                        id: 'd7e2564a33c64a9c82a06f4ea2ddbcc5'
                    }
                    'workspace-with-list_sys_ux_screen_type_list': {
                        table: 'sys_ux_screen_type'
                        id: '72b8749f45ed46dba147e295a6807428'
                    }
                    'workspace-with-list_sys_ux_screen_type_record': {
                        table: 'sys_ux_screen_type'
                        id: '10fbf2bb940a4f6197a826449486c840'
                    }
                    'workspace-with-list_sys_ux_screen_type_simple-list': {
                        table: 'sys_ux_screen_type'
                        id: '5d697cb10df64850b0c269bd44a6a8fa'
                    }
                    ws_min: {
                        table: 'sys_ux_page_registry'
                        id: '753753ea582f49f8a8813edc182b31b9'
                    }
                    ws_min_sys_ux_app_config_workspace: {
                        table: 'sys_ux_app_config'
                        id: '7f4bf680998847ee990f4af42f0d0940'
                    }
                    ws_min_sys_ux_app_route_home: {
                        table: 'sys_ux_app_route'
                        id: '4f40e02dc1444a6da92a3e14e852cf89'
                    }
                    ws_min_sys_ux_app_route_list: {
                        table: 'sys_ux_app_route'
                        id: '8ce1ec7402ed462bbcd2dc891b6d4798'
                    }
                    ws_min_sys_ux_app_route_record: {
                        table: 'sys_ux_app_route'
                        id: '0ae4962b25994d4cb647272d2f58e399'
                    }
                    'ws_min_sys_ux_app_route_simple-list': {
                        table: 'sys_ux_app_route'
                        id: 'fc4d1676d7e2468b9e6e83cab6cf2025'
                    }
                    ws_min_sys_ux_macroponent_record: {
                        table: 'sys_ux_macroponent'
                        id: '6a4513e94d1e43cfa81ccc1259524812'
                    }
                    ws_min_sys_ux_page_property_chrome_footer: {
                        table: 'sys_ux_page_property'
                        id: '4da6c05334a94863a2c4a59638bbdf88'
                    }
                    ws_min_sys_ux_page_property_chrome_header: {
                        table: 'sys_ux_page_property'
                        id: '4baaa174f1494faa9b5e15e915a273af'
                    }
                    ws_min_sys_ux_page_property_chrome_tab: {
                        table: 'sys_ux_page_property'
                        id: 'e1f72aa3c7f94760b6814edda14ba11f'
                    }
                    ws_min_sys_ux_page_property_chrome_toolbar: {
                        table: 'sys_ux_page_property'
                        id: '395cef40e4ff48f98b7bc7c45f0190fd'
                    }
                    ws_min_sys_ux_page_property_listConfigId: {
                        table: 'sys_ux_page_property'
                        id: '2d2b1a392c124977bb30190f1daddf9a'
                    }
                    ws_min_sys_ux_page_property_view: {
                        table: 'sys_ux_page_property'
                        id: 'bfe6828d913c4ecaad4e044b076653b5'
                    }
                    ws_min_sys_ux_page_property_wbApplicabilityConfigId: {
                        table: 'sys_ux_page_property'
                        id: 'fd826995bfd3462bb046b16501b795af'
                    }
                    ws_min_sys_ux_registry_m2m_category_unifiedNav: {
                        table: 'sys_ux_registry_m2m_category'
                        id: '74cc00cb5b3a4c95a230f2497ae3eae0'
                    }
                    ws_min_sys_ux_screen_home: {
                        table: 'sys_ux_screen'
                        id: 'd827af8f7c864fe5957eb5b6b7345724'
                    }
                    ws_min_sys_ux_screen_list: {
                        table: 'sys_ux_screen'
                        id: '0f05ec582eea4c4dbf16e6db4a7bf278'
                    }
                    ws_min_sys_ux_screen_record: {
                        table: 'sys_ux_screen'
                        id: 'fb06adabedae4c6f94666546a3541fed'
                    }
                    'ws_min_sys_ux_screen_simple-list': {
                        table: 'sys_ux_screen'
                        id: '76b708dbd28c4c1badde98f9dba28f70'
                    }
                    ws_min_sys_ux_screen_type_home: {
                        table: 'sys_ux_screen_type'
                        id: '1089ae84f8f546c88148dd11a2106826'
                    }
                    ws_min_sys_ux_screen_type_list: {
                        table: 'sys_ux_screen_type'
                        id: '30e16398d5964ced8f3e366e2f2e5a35'
                    }
                    ws_min_sys_ux_screen_type_record: {
                        table: 'sys_ux_screen_type'
                        id: 'da4c2903e4b64be2a2bf5a7dff2b58e6'
                    }
                    'ws_min_sys_ux_screen_type_simple-list': {
                        table: 'sys_ux_screen_type'
                        id: 'e98ffb50bed94349a71e52c60f281e3d'
                    }
                }
                composite: [
                    {
                        table: 'sys_user_role_contains'
                        id: '47abb6b83dee4a7fb7107fa18ac2e051'
                        deleted: true
                        key: {
                            role: {
                                id: 'fdceda502b6841d5a3d7d4c283936964'
                                key: {
                                    name: 'x_snc_bprobe.user'
                                }
                            }
                            contains: {
                                id: 'ac418a76e4bd46e98a230d849e738bd5'
                                key: {
                                    name: 'canvas_user'
                                }
                            }
                        }
                    },
                    {
                        table: 'sys_user_role'
                        id: 'fdceda502b6841d5a3d7d4c283936964'
                        key: {
                            name: 'x_snc_bprobe.user'
                        }
                    },
                ]
            }
        }
    }
}
