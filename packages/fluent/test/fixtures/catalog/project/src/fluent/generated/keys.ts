import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: '6a01fc0f45a4445c9343f574f66679f3'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '1943c3ce542d485caff75c82f229202e'
                    }
                    vs_full: {
                        table: 'item_option_new_set'
                        id: '45149637c2784e6e9b1189aa3eaafc53'
                    }
                    vs_min: {
                        table: 'item_option_new_set'
                        id: '58dd8498b616496b8df3f7185fd5a5bc'
                    }
                    vs_multi: {
                        table: 'item_option_new_set'
                        id: 'f63f28bcf56645ce8e1e48349dba83d3'
                    }
                }
                composite: [
                    {
                        table: 'item_option_new'
                        id: '0547d69e905f4da588fb02d401779550'
                        key: {
                            cat_item: 'NULL'
                            variable_set: 'f63f28bcf56645ce8e1e48349dba83d3'
                            name: 'item'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: '0ce566396239491d9acef0aa4a9ba040'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                            name: 'short'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: '0ff34e0d5bf4479ca6ef945a9fb25552'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                            name: 'ce'
                        }
                    },
                    {
                        table: 'fx_price'
                        id: '1eed6ddb9ff64138acb1bc12194736ee'
                        key: {
                            id: '86560332ec744f91a60e87453718af62'
                            field: 'recurring_price'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: '288e2eaeab75465e814ff0c70d59d310'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                            name: 'cs'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: '34fd931426854fd39e85ca2a8fe9bfab'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                            name: 'lookup'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: '4698e34986564e4fa3a02bbbd9ca64ed'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                            name: 'manager'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: '4eac1a78090441e89c9cceb3329463df'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                            name: 'mail'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: '69def791fda94ac4a66e0675ac0d10e5'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                            name: 'html'
                        }
                    },
                    {
                        table: 'question_choice'
                        id: '71a12435f59e437bae24ba4d5d0dcdeb'
                        key: {
                            question: {
                                id: 'd33da8a69d76427da0f2f0a555a856e2'
                                key: {
                                    cat_item: 'NULL'
                                    variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                                    name: 'size'
                                }
                            }
                            value: 'l'
                        }
                    },
                    {
                        table: 'fx_price'
                        id: '756f241d21cd4a9285511fe98b2a5828'
                        key: {
                            id: '0ce566396239491d9acef0aa4a9ba040'
                            field: 'price'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: '7e1cdeb992ee4174aa5f2dff491bc94b'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                            name: 'agree'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: '83642b0963204d55886a2b20fd250efc'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                            name: 'plain'
                        }
                    },
                    {
                        table: 'question_choice'
                        id: '86560332ec744f91a60e87453718af62'
                        key: {
                            question: {
                                id: 'd33da8a69d76427da0f2f0a555a856e2'
                                key: {
                                    cat_item: 'NULL'
                                    variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                                    name: 'size'
                                }
                            }
                            value: 'm'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: '927ceceb19ee4b1e80d03172a08c243b'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                            name: 'br'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: '970232fbb2a144d290523777e38045cd'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                            name: 'secret'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: 'a2831a129cf14953b769eed36a81095e'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                            name: 'color'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: 'a5b767f08aaf4e32ab05b43b22bae8e5'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                            name: 'long'
                        }
                    },
                    {
                        table: 'question_choice'
                        id: 'af626818046a484ebc3b7a0b019e73a6'
                        key: {
                            question: {
                                id: 'a2831a129cf14953b769eed36a81095e'
                                key: {
                                    cat_item: 'NULL'
                                    variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                                    name: 'color'
                                }
                            }
                            value: 'red'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: 'c80c1106becb46e38f1535e151bf73c5'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                            name: 'requested_for'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: 'cf72349b6bd94314b3d125a1893b5f13'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                            name: 'scale'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: 'd19b6be3f625413bbc4c0d23bcebda7b'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                            name: 'yes'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: 'd22c80841ec5437ab448b77fd787de39'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                            name: 'list'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: 'd33da8a69d76427da0f2f0a555a856e2'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                            name: 'size'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: 'e07e8d8ed67b443a9c77bff9b54b29b5'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                            name: 'when'
                        }
                    },
                    {
                        table: 'question_choice'
                        id: 'e679443bd1754c709db8d325e88d3fc8'
                        key: {
                            question: {
                                id: 'd33da8a69d76427da0f2f0a555a856e2'
                                key: {
                                    cat_item: 'NULL'
                                    variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                                    name: 'size'
                                }
                            }
                            value: 's'
                        }
                    },
                    {
                        table: 'item_option_new'
                        id: 'f8b42dc7ba2a47bba5a91b6d0034d206'
                        key: {
                            cat_item: 'NULL'
                            variable_set: '45149637c2784e6e9b1189aa3eaafc53'
                            name: 'label'
                        }
                    },
                ]
            }
        }
    }
}
