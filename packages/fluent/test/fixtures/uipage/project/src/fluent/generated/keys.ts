import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: '65cee149d5b44d7ba79d0875445a1fb9'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '7d16f3a8a63d457f9d1213f24e15e3e9'
                    }
                }
                composite: [
                    {
                        table: 'sys_ui_page'
                        id: '28818abb179f4465b7d1b9d5b533cdc3'
                        key: {
                            endpoint: 'x_snc_bprobe_globals_theme.do'
                        }
                    },
                    {
                        table: 'sys_ui_page'
                        id: '42fe376dd17c497e92fdd2254e6db1ff'
                        key: {
                            endpoint: 'x_snc_bprobe_empty.do'
                        }
                    },
                    {
                        table: 'sys_ui_page'
                        id: '6b545bed88c547039fe0a8aa5c18bd0d'
                        key: {
                            endpoint: 'x_snc_bprobe_full.do'
                        }
                    },
                    {
                        table: 'sys_ui_page'
                        id: 'a882cfa508b147cd920ed50645aa7948'
                        key: {
                            endpoint: 'x_snc_bprobe_minimal.do'
                        }
                    },
                    {
                        table: 'sys_ui_page'
                        id: 'daaac552add7465f98e3f6491e327701'
                        key: {
                            endpoint: 'x_snc_bprobe_globals_min.do'
                        }
                    },
                    {
                        table: 'sys_ui_page'
                        id: 'fa7205f67c2241298282ed2b3f008501'
                        key: {
                            endpoint: 'x_snc_bprobe_globals_full.do'
                        }
                    },
                ]
            }
        }
    }
}
