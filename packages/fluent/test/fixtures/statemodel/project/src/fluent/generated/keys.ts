import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    a1: {
                        table: 'sttrm_state_attribute'
                        id: '5830e3755d41433983657367dcf00ee2'
                    }
                    a2: {
                        table: 'sttrm_state_attribute'
                        id: 'ac88922621444efa9cb6b3ed63e767c2'
                    }
                    base: {
                        table: 'sttrm_model'
                        id: '241e9bfb2ce143139130a28d0c8eeb89'
                    }
                    bom_json: {
                        table: 'sys_module'
                        id: 'b53b7803055249e09a8f4508602e8d7d'
                    }
                    c1: {
                        table: 'sttrm_transition_condition'
                        id: 'f8b971f7283246a5a469f35c58d32778'
                    }
                    c2: {
                        table: 'sttrm_transition_condition'
                        id: '9151083c4b7840d89b2ea98949c0c8b4'
                    }
                    chg: {
                        table: 'chg_model'
                        id: '04b563b7ff2444c3bac9ced048cd0bd6'
                    }
                    chgmin: {
                        table: 'chg_model'
                        id: '80f1d020ed154e669dfa70d9931a53c9'
                    }
                    crit: {
                        table: 'user_criteria'
                        id: 'a90bd5112e344ece938b68a24ed5f8eb'
                    }
                    f1: {
                        table: 'sttrm_transition_condition_field'
                        id: 'd1c927f59a4f4cb4902d2596a909734a'
                    }
                    min: {
                        table: 'sttrm_model'
                        id: '850cd87983fe491486c5aea83d60a322'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '19c46a8efc14412cb5bf42ca391a6786'
                    }
                    prb: {
                        table: 'prb_model'
                        id: '2634b8ed54da467184899addb929fe07'
                    }
                    prbtask: {
                        table: 'prb_task_model'
                        id: 'f7a4209324224f8f8f1899e2484c5a40'
                    }
                    's-done': {
                        table: 'sttrm_state'
                        id: '19a3820868174207bfb21bbc784d0f00'
                    }
                    's-new': {
                        table: 'sttrm_state'
                        id: '74cd9a3ae4454d73b2d21ee981d44818'
                    }
                    's-work': {
                        table: 'sttrm_state'
                        id: '96c37db38e414b3fa265b34d846b0965'
                    }
                    t1: {
                        table: 'sttrm_state_transition'
                        id: '11c9816b82ea4bedace52911b397c096'
                    }
                    t2: {
                        table: 'sttrm_state_transition'
                        id: '023773ec747b4a079b868d962ed78203'
                    }
                    user: {
                        table: 'sys_user'
                        id: '4396842a1b08478d83ea377f93f43d5c'
                    }
                }
                composite: [
                    {
                        table: 'sttrm_model_user_criteria_read_mtom'
                        id: '15d0dee70bec44ada85b2cfa9763c3d4'
                        key: {
                            sttrm_model: '241e9bfb2ce143139130a28d0c8eeb89'
                            user_criteria: 'a90bd5112e344ece938b68a24ed5f8eb'
                        }
                    },
                    {
                        table: 'sttrm_model_user_criteria_read_mtom'
                        id: '17dacc6763514de3bebba18f742c5561'
                        key: {
                            sttrm_model: '241e9bfb2ce143139130a28d0c8eeb89'
                            user_criteria: '0c441abbc6112275000025157c651c89'
                        }
                    },
                    {
                        table: 'sttrm_model_user_criteria_write_mtom'
                        id: '1c0303c467e84c25a18a65359f143e91'
                        key: {
                            sttrm_model: '241e9bfb2ce143139130a28d0c8eeb89'
                            user_criteria: 'a90bd5112e344ece938b68a24ed5f8eb'
                        }
                    },
                    {
                        table: 'sttrm_model_user_criteria_hide_mtom'
                        id: '26db75d2666c4ee98d3f4f3200fa7072'
                        key: {
                            sttrm_model: '241e9bfb2ce143139130a28d0c8eeb89'
                            user_criteria: '0c441abbc6112275000025157c651c89'
                        }
                    },
                    {
                        table: 'sys_user_role'
                        id: '66aeaddc579d4907bdc602a84e55cf4e'
                        key: {
                            name: 'x_snc_bprobe.approver'
                        }
                    },
                ]
            }
        }
    }
}
