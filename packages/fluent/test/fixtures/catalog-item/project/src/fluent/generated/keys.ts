import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: '97c98164bcf74b638bc3a785b4c1d61c'
                    }
                    ci_full: {
                        table: 'sc_cat_item'
                        id: 'c8788f2b2e384d1493b66797ecfb49bf'
                    }
                    ci_min: {
                        table: 'sc_cat_item'
                        id: 'ffc2a2c47cb9405ca9a3b9e523f05802'
                    }
                    ci_vars: {
                        table: 'sc_cat_item'
                        id: '6b502868eb56468fa5adc83d06407268'
                    }
                    ci_vs: {
                        table: 'item_option_new_set'
                        id: '05058ad7f6a04e898aae234241f2e528'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: 'abc2102c3d2f49d1935d48c6cc118009'
                    }
                }
                composite: [
                    {
                        table: 'sc_cat_item_user_criteria_mtom'
                        id: '065a7dc61cd541f4a7e91de303bd63b2'
                        key: {
                            sc_cat_item: 'c8788f2b2e384d1493b66797ecfb49bf'
                            user_criteria: '22222222222222222222222222222222'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: '20015bd1d60345879cbaf3466953af0c'
                        key: {
                            cat_item: '6b502868eb56468fa5adc83d06407268'
                            variable_set: 'NULL'
                            name: 'local'
                        }
                    },
                    {
                        table: 'question_choice'
                        id: '2540fc92c55b400e899061022a6c5270'
                        key: {
                            question: {
                                id: '8bbc2cb1e8034860951377efffe09100'
                                key: {
                                    cat_item: '6b502868eb56468fa5adc83d06407268'
                                    variable_set: 'NULL'
                                    name: 'size'
                                }
                            }
                            value: 's'
                        }
                    },
                    {
                        table: 'io_set_item'
                        id: '323be3680d3a4d5ba9eee2c2519f171a'
                        key: {
                            sc_cat_item: '6b502868eb56468fa5adc83d06407268'
                            variable_set: '05058ad7f6a04e898aae234241f2e528'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: '339a0fc88b764d9baf8b1c9e15502276'
                        key: {
                            cat_item: '6b502868eb56468fa5adc83d06407268'
                            variable_set: 'NULL'
                            name: 'manager'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: '3705ef5e5c974d90b940805eb0b2de81'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '05058ad7f6a04e898aae234241f2e528'
                            name: 'note'
                        }
                    },
                    {
                        table: 'sc_cat_item_user_criteria_no_mtom'
                        id: '37e6f6e871ad4469b35b455b4115c9ca'
                        key: {
                            sc_cat_item: 'c8788f2b2e384d1493b66797ecfb49bf'
                            user_criteria: '33333333333333333333333333333333'
                        }
                    },
                    {
                        table: 'io_set_item'
                        id: '387b074c71154e8c9490bf26f03f1c88'
                        key: {
                            sc_cat_item: '6b502868eb56468fa5adc83d06407268'
                            variable_set: '66666666666666666666666666666666'
                        }
                    },
                    {
                        table: 'sys_user_role'
                        id: '456d121833104edea02891d97e33e071'
                        key: {
                            name: 'x_snc_bprobe.approver'
                        }
                    },
                    {
                        table: 'sc_cat_item_catalog'
                        id: '4bc3ef52f1494044b37f5d64ddbca1f4'
                        key: {
                            sc_cat_item: 'c8788f2b2e384d1493b66797ecfb49bf'
                            sc_catalog: '742ce428d7211100f2d224837e61036d'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: '4dd43548eabe4a36810b4569481134ca'
                        key: {
                            cat_item: '6b502868eb56468fa5adc83d06407268'
                            variable_set: 'NULL'
                            name: 'late'
                        }
                    },
                    {
                        table: 'fx_price'
                        id: '508f8bb46df4497a93733eb40b0d59ee'
                        key: {
                            id: '8bbc2cb1e8034860951377efffe09100'
                            field: 'price'
                        }
                    },
                    {
                        table: 'sc_cat_item_user_criteria_no_mtom'
                        id: '53da9a0275cf4e6ab82acdceb839f99a'
                        key: {
                            sc_cat_item: 'c8788f2b2e384d1493b66797ecfb49bf'
                            user_criteria: '44444444444444444444444444444444'
                        }
                    },
                    {
                        table: 'sc_cat_item_catalog'
                        id: '6b97c96ff4b6456883dcf2c1589df858'
                        key: {
                            sc_cat_item: 'c8788f2b2e384d1493b66797ecfb49bf'
                            sc_catalog: 'e0d08b13c3330100c8b837659bba8fb4'
                        }
                    },
                    {
                        table: 'fx_price'
                        id: '6c079389ed3e402cb8747ca02687209f'
                        key: {
                            id: 'c8788f2b2e384d1493b66797ecfb49bf'
                            field: 'price'
                        }
                    },
                    {
                        table: 'sc_cat_item_category'
                        id: '73943b1df5a949fda9718f46c2924ff2'
                        key: {
                            sc_cat_item: 'c8788f2b2e384d1493b66797ecfb49bf'
                            sc_category: 'd258b953c611227a0146101fb1be7c31'
                        }
                    },
                    {
                        table: 'sc_cat_item_category'
                        id: '784c8cf0009d453eaaa77dfad6a89a43'
                        key: {
                            sc_cat_item: 'c8788f2b2e384d1493b66797ecfb49bf'
                            sc_category: '2c0b59874f7b4200086eeed18110c71f'
                        }
                    },
                    {
                        table: 'm2m_connected_content'
                        id: '8ba7327698334351a5195e70514aa874'
                        key: {
                            catalog_item: 'c8788f2b2e384d1493b66797ecfb49bf'
                            topic: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: '8bbc2cb1e8034860951377efffe09100'
                        key: {
                            cat_item: '6b502868eb56468fa5adc83d06407268'
                            variable_set: 'NULL'
                            name: 'size'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: 'a0f7194c4b444912883e8b27822bed21'
                        key: {
                            cat_item: '6b502868eb56468fa5adc83d06407268'
                            variable_set: 'NULL'
                            name: 'early'
                        }
                    },
                    {
                        table: 'fx_price'
                        id: 'a860149e0fd04c208c6d02a4fa1ddf31'
                        key: {
                            id: 'c8788f2b2e384d1493b66797ecfb49bf'
                            field: 'recurring_price'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: 'ac89f57fef2a45a4842df3329aea37de'
                        key: {
                            cat_item: '6b502868eb56468fa5adc83d06407268'
                            variable_set: 'NULL'
                            name: 'fromSet'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: 'bcbb8153104143f1927f80a0b1dc887e'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '05058ad7f6a04e898aae234241f2e528'
                            name: 'employee'
                        }
                    },
                    {
                        table: 'question_choice'
                        id: 'e1cfb54515e549bd89d8bccaec0c7bf1'
                        key: {
                            question: {
                                id: '8bbc2cb1e8034860951377efffe09100'
                                key: {
                                    cat_item: '6b502868eb56468fa5adc83d06407268'
                                    variable_set: 'NULL'
                                    name: 'size'
                                }
                            }
                            value: 'l'
                        }
                    },
                ]
            }
        }
    }
}
