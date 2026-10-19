import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: 'f73e8f44e5e8448aad79504006ba508a'
                    }
                    'child-provider': {
                        table: 'sp_angular_provider'
                        id: '0baef81194ae4965b4d2f38dcdc3511a'
                    }
                    'full-dep': {
                        table: 'sp_dependency'
                        id: '29fee90408f14088af3c544c00c7cc41'
                    }
                    'full-theme': {
                        table: 'sp_theme'
                        id: '0577c28b5d63489592bc97092e3af7e7'
                    }
                    'min-dep': {
                        table: 'sp_dependency'
                        id: '920e50ffc7a94855bbf9cc274e1c8193'
                    }
                    'min-provider': {
                        table: 'sp_angular_provider'
                        id: 'c9ff155de42e49aca41483c34d0fff64'
                    }
                    'min-theme': {
                        table: 'sp_theme'
                        id: '8d44b57c58fc475c8c19c9e8fb8f5b88'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '4aa733c90dc34dafa796d70918d0b2dc'
                    }
                    'parent-provider': {
                        table: 'sp_angular_provider'
                        id: '9b0a809582bc41019863ed82210aac6b'
                    }
                    'sp-css': {
                        table: 'sp_css_include'
                        id: '2a84296b659a428dbcb6d600d73815e2'
                    }
                    src_server_simple_server_js: {
                        table: 'sys_module'
                        id: 'f03a6ce64b4b459a89682938c6824f0d'
                    }
                    'ui-js': {
                        table: 'sp_js_include'
                        id: 'a5f3151df8144dca8272912c7befa093'
                    }
                    'url-css': {
                        table: 'sp_css_include'
                        id: '3a94f4b8e935487ab4895dc41158e3a3'
                    }
                    'url-js': {
                        table: 'sp_js_include'
                        id: '4fe8e62547c94fb7b33fa1e728a12cdb'
                    }
                }
                composite: [
                    {
                        table: 'm2m_sp_ng_pro_sp_ng_pro'
                        id: '0901c18130b342d883b0b26649fcdc76'
                        key: {
                            required_by: '9b0a809582bc41019863ed82210aac6b'
                            requires: '5f41b53498566648389c9b40286de458'
                        }
                    },
                    {
                        table: 'm2m_sp_dependency_css_include'
                        id: '0a46e781d0da4f84878a3355833ead54'
                        key: {
                            sp_css_include: '3a94f4b8e935487ab4895dc41158e3a3'
                            sp_dependency: '29fee90408f14088af3c544c00c7cc41'
                        }
                    },
                    {
                        table: 'm2m_sp_theme_js_include'
                        id: '10d4186b5dd649a7a576811cbf0cb106'
                        key: {
                            sp_js_include: '4fe8e62547c94fb7b33fa1e728a12cdb'
                            sp_theme: '0577c28b5d63489592bc97092e3af7e7'
                        }
                    },
                    {
                        table: 'm2m_sp_dependency_js_include'
                        id: '2e6c26f7ca12443bb4b6f6cb571ce23f'
                        key: {
                            sp_js_include: 'a5f3151df8144dca8272912c7befa093'
                            sp_dependency: '29fee90408f14088af3c544c00c7cc41'
                        }
                    },
                    {
                        table: 'm2m_sp_theme_js_include'
                        id: '45967f62bdcb4dbead97243212383b06'
                        key: {
                            sp_js_include: 'f8af18a5e6c71a3702c4f2038b43cf62'
                            sp_theme: '0577c28b5d63489592bc97092e3af7e7'
                        }
                    },
                    {
                        table: 'm2m_sp_theme_css_include'
                        id: '5289f9d60e7743c3a5311ed63ac4cae4'
                        key: {
                            sp_css_include: '3a94f4b8e935487ab4895dc41158e3a3'
                            sp_theme: '0577c28b5d63489592bc97092e3af7e7'
                        }
                    },
                    {
                        table: 'sys_user_role'
                        id: '57aa3f44fa0b4f2fbce8476fae72145a'
                        key: {
                            name: 'x_snc_bprobe.sp_user'
                        }
                    },
                    {
                        table: 'm2m_sp_ng_pro_sp_ng_pro'
                        id: '62758f2804c24c8ebe47658eb509e001'
                        key: {
                            required_by: '9b0a809582bc41019863ed82210aac6b'
                            requires: '0baef81194ae4965b4d2f38dcdc3511a'
                        }
                    },
                    {
                        table: 'm2m_sp_dependency_css_include'
                        id: '8040655930664b8c97f7e9f1fc438b9f'
                        key: {
                            sp_css_include: '2a84296b659a428dbcb6d600d73815e2'
                            sp_dependency: '29fee90408f14088af3c544c00c7cc41'
                        }
                    },
                    {
                        table: 'm2m_sp_dependency_js_include'
                        id: 'a121bfa8ba5c433caea81a7b1e25bc76'
                        key: {
                            sp_js_include: '4fe8e62547c94fb7b33fa1e728a12cdb'
                            sp_dependency: '29fee90408f14088af3c544c00c7cc41'
                        }
                    },
                    {
                        table: 'm2m_sp_theme_css_include'
                        id: 'c15554f497144c7b976da584c61737d1'
                        key: {
                            sp_css_include: '94112ccb0fb3c2ed072b01d3cb401196'
                            sp_theme: '0577c28b5d63489592bc97092e3af7e7'
                        }
                    },
                    {
                        table: 'sp_page_route_map'
                        id: 'e549d293da99427c91f348604569da75'
                        key: {
                            route_from_page: 'a4e3c21047132100ba13a5554ee49001'
                            portals: 'NULL'
                        }
                    },
                    {
                        table: 'sp_page_route_map'
                        id: 'e6604bade2ea4733b3a44485a7f2494a'
                        key: {
                            route_from_page: 'b5f4d31047132100ba13a5554ee49002'
                            portals: 'fe12dbbed14bd3f712f0787141c2f656'
                        }
                    },
                ]
            }
        }
    }
}
