import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: '224ea03a47b14b2c8a1e4a5e607153e9'
                    }
                    'ctl-widget': {
                        table: 'sp_widget'
                        id: '9dc73746931644af9acdf5ca195791be'
                    }
                    'full-hf': {
                        table: 'sp_header_footer'
                        id: '344a7f5749134f4fac04f211f1c4b7bb'
                    }
                    'full-widget': {
                        table: 'sp_widget'
                        id: '12c15fec720f4b69849ad484f3d52d9b'
                    }
                    'min-hf': {
                        table: 'sp_header_footer'
                        id: 'f7dfeac4fef743959218657a4f27200c'
                    }
                    'min-widget': {
                        table: 'sp_widget'
                        id: '2b80cd89b9534f919ba3e1f164792e42'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '287102f60f6c4d7790cc7cb3d13b6bd1'
                    }
                    src_server_simple_server_js: {
                        table: 'sys_module'
                        id: '34a2c3fbd1594d45a2de225fcca1498c'
                    }
                    'str-demo': {
                        table: 'sp_widget'
                        id: '5607e0e20d1b43d29a8198622c719c6e'
                    }
                    'tpl-1': {
                        table: 'sp_ng_template'
                        id: '262f60cc825d4a988794396e18c5f3ae'
                    }
                    'w-dep': {
                        table: 'sp_dependency'
                        id: '2de1475032444377be5a8c937db70d52'
                    }
                    'w-prov': {
                        table: 'sp_angular_provider'
                        id: '10d309b958ba44e8b6f98633ce55cd52'
                    }
                }
                composite: [
                    {
                        table: 'm2m_sp_widget_dependency'
                        id: '5d2442c9ae6549028e753e062ba22a92'
                        key: {
                            sp_widget: '344a7f5749134f4fac04f211f1c4b7bb'
                            sp_dependency: '2de1475032444377be5a8c937db70d52'
                        }
                    },
                    {
                        table: 'm2m_sp_ng_pro_sp_widget'
                        id: '7e7c4dc4030b48dfad14e2fc2597129f'
                        key: {
                            sp_widget: '12c15fec720f4b69849ad484f3d52d9b'
                            sp_angular_provider: '10d309b958ba44e8b6f98633ce55cd52'
                        }
                    },
                    {
                        table: 'm2m_sp_ng_pro_sp_widget'
                        id: 'a594d2a7640b4fe4930e2231cbed774a'
                        key: {
                            sp_widget: '12c15fec720f4b69849ad484f3d52d9b'
                            sp_angular_provider: 'ccfbb128f13494f68c570b646ba5d335'
                        }
                    },
                    {
                        table: 'm2m_sp_widget_dependency'
                        id: 'c300ff1347d54e1c82e2e47964e54fb2'
                        key: {
                            sp_widget: '12c15fec720f4b69849ad484f3d52d9b'
                            sp_dependency: '5f41b53498566648389c9b40286de458'
                        }
                    },
                    {
                        table: 'm2m_sp_widget_dependency'
                        id: 'e8137e3dd1174fe58f515dc84613d910'
                        key: {
                            sp_widget: '12c15fec720f4b69849ad484f3d52d9b'
                            sp_dependency: '2de1475032444377be5a8c937db70d52'
                        }
                    },
                    {
                        table: 'sys_user_role'
                        id: 'fac2b25bec4b4dce9e464d29d5d988ca'
                        key: {
                            name: 'x_snc_bprobe.w_user'
                        }
                    },
                ]
            }
        }
    }
}
