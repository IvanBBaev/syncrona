import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: '05c16803c68d469f8ff4ea313a95d6d3'
                    }
                    'dep-portal': {
                        table: 'sp_portal'
                        id: '6e5a56d99a354a0f81fb19cee53129b5'
                    }
                    'full-portal': {
                        table: 'sp_portal'
                        id: 'a2fbb68d123e4b4a9b35c1d3a7f38348'
                    }
                    kb: {
                        table: 'kb_knowledge_base'
                        id: 'fda06637df9145929c272447c1a03ca3'
                    }
                    menu: {
                        table: 'sp_instance_menu'
                        id: 'e170d52af25247cb9f69018d5ed7a69e'
                    }
                    'min-portal': {
                        table: 'sp_portal'
                        id: 'e980ad7a63d444ce829412bae728c42c'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '715d1d22733b470a9cc78bd5b9098748'
                    }
                    src_server_simple_server_js: {
                        table: 'sys_module'
                        id: '7abdd69254394925ba5f19c709d9854e'
                    }
                    theme: {
                        table: 'sp_theme'
                        id: 'e5f45bc476a94985b2b94bec9b1e7036'
                    }
                }
                composite: [
                    {
                        table: 'm2m_sp_portal_knowledge_base'
                        id: '17a18ee8febc4b6ea832ba87479c15ef'
                        key: {
                            sp_portal: 'a2fbb68d123e4b4a9b35c1d3a7f38348'
                            kb_knowledge_base: 'fda06637df9145929c272447c1a03ca3'
                        }
                    },
                    {
                        table: 'm2m_sp_portal_knowledge_base'
                        id: '23f22ecd90ef4c788bccd9c4f327e8f8'
                        key: {
                            sp_portal: 'a2fbb68d123e4b4a9b35c1d3a7f38348'
                            kb_knowledge_base: '55555555555555555555555555555555'
                        }
                    },
                    {
                        table: 'm2m_sp_portal_search_source'
                        id: '363f8e1a20e840e5854ca7c155e7b5ec'
                        key: {
                            sp_portal: 'a2fbb68d123e4b4a9b35c1d3a7f38348'
                            sp_search_source: '33333333333333333333333333333333'
                        }
                    },
                    {
                        table: 'm2m_sp_portal_taxonomy'
                        id: '4afd39575f8f418289d85eb622b208ea'
                        key: {
                            sp_portal: 'a2fbb68d123e4b4a9b35c1d3a7f38348'
                            taxonomy: '44444444444444444444444444444444'
                        }
                    },
                    {
                        table: 'm2m_sp_portal_catalog'
                        id: '60ff53ba535a46819aede74426eb570f'
                        key: {
                            sp_portal: 'a2fbb68d123e4b4a9b35c1d3a7f38348'
                            sc_catalog: '66666666666666666666666666666666'
                        }
                    },
                    {
                        table: 'm2m_sp_portal_search_source'
                        id: 'ac5bbf85434b474db8286e4941766718'
                        key: {
                            sp_portal: 'a2fbb68d123e4b4a9b35c1d3a7f38348'
                            sp_search_source: '22222222222222222222222222222222'
                        }
                    },
                    {
                        table: 'sp_page'
                        id: 'b073ad636c6642aeaad4401bba501432'
                        key: {
                            id: 'portal_home'
                        }
                    },
                ]
            }
        }
    }
}
