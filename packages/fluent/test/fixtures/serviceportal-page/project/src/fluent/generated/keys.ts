import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: '855af2572274423aa6a3257021fc6b98'
                    }
                    c1: {
                        table: 'sp_container'
                        id: '9871d3fd20c745bdbfe73c6d1df930d0'
                    }
                    c2: {
                        table: 'sp_container'
                        id: '1028d4b60a174fcf9ca6149d15820ac3'
                    }
                    col1: {
                        table: 'sp_column'
                        id: 'ccc7145a171541188702383c6a011cd2'
                    }
                    col2: {
                        table: 'sp_column'
                        id: 'e08c4b760aae4d398e0bc24745c4dfe6'
                    }
                    'full-menu': {
                        table: 'sp_instance_menu'
                        id: 'f6c956798fc041788162110aefed0d60'
                    }
                    i1: {
                        table: 'sp_instance'
                        id: '464db77d28f64b5bb2bb20ead124cf32'
                    }
                    i2: {
                        table: 'sp_instance'
                        id: '568996dc1ffd4d64b02facfe1a4b2003'
                    }
                    i3: {
                        table: 'sp_instance'
                        id: '235540e129764ca7a3cfb389d0a992c4'
                    }
                    mi1: {
                        table: 'sp_rectangle_menu_item'
                        id: 'f2ba92938f434378bbb43b711add805d'
                    }
                    mi1c: {
                        table: 'sp_rectangle_menu_item'
                        id: '7db9ec5c9bc4483fa2860eb5f1d1982b'
                    }
                    mi2: {
                        table: 'sp_rectangle_menu_item'
                        id: '662d84a9cab84d6f962ba0a3e255e304'
                    }
                    'min-menu': {
                        table: 'sp_instance_menu'
                        id: '19d721310c2e452089ccec965a02b655'
                    }
                    ncol: {
                        table: 'sp_column'
                        id: 'fe9e2a7b49c044e9b79ece082e958f6b'
                    }
                    nr: {
                        table: 'sp_row'
                        id: '9214b345a0cc4706b0fa297b629e35ab'
                    }
                    'p-widget': {
                        table: 'sp_widget'
                        id: '5ec34342fa424ae3939401f6d14a9b73'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '69b1dd94cc194e278da4b5ea77fec102'
                    }
                    r1: {
                        table: 'sp_row'
                        id: 'd52ddefeb13f4b10bbdc16230d2b45a3'
                    }
                    r2: {
                        table: 'sp_row'
                        id: '99bcfc8121ad434096897208728c44c5'
                    }
                    src_server_simple_server_js: {
                        table: 'sys_module'
                        id: 'd960be3bdf17406c8a3f515767e02508'
                    }
                }
                composite: [
                    {
                        table: 'sys_user_role'
                        id: '1c0e103ee3054772986676c010367845'
                        key: {
                            name: 'x_snc_bprobe.p_user'
                        }
                    },
                    {
                        table: 'sp_page'
                        id: '1f7a3355f8934808bdf7c01c079fc3f9'
                        key: {
                            id: 'min_page'
                        }
                    },
                    {
                        table: 'sp_page'
                        id: '313624f3811b46c4af6be87a299d8719'
                        key: {
                            id: 'full_page'
                        }
                    },
                ]
            }
        }
    }
}
