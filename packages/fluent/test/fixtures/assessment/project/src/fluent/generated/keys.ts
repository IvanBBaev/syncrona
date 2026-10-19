import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bare: {
                        table: 'asmt_metric_type'
                        id: '56cd31053f5e405e9091253ff2aa5448'
                    }
                    bare__assessment_business_rule: {
                        table: 'sys_script'
                        id: '60ce41070e9949ccbfc678c65a606ba0'
                    }
                    bare__assessment_delete_business_rule: {
                        table: 'sys_script'
                        id: '668e8b891f63478a91beca7d68153577'
                    }
                    bom_json: {
                        table: 'sys_module'
                        id: 'd6722817f51d4c21bded11eb97637dac'
                    }
                    cat_empty_scale: {
                        table: 'asmt_metric_category'
                        id: '87ec65174b084628abe671a25d670d5b'
                    }
                    cat_pulse: {
                        table: 'asmt_metric_category'
                        id: 'ee7a6676f46e45d488b769d01d6bd07f'
                    }
                    cat_quality: {
                        table: 'asmt_metric_category'
                        id: '735c74f89ac547f49c71cfe561504011'
                    }
                    cat_risk: {
                        table: 'asmt_metric_category'
                        id: 'a6ef1c519279428cbe9b53d425671856'
                    }
                    m_choice: {
                        table: 'asmt_metric'
                        id: '72cb1eee44ae4b3da3eed67d8c7ca98c'
                    }
                    m_impact: {
                        table: 'asmt_metric'
                        id: '5eca5943207845ce8b38b7dcd976bc89'
                    }
                    m_mood: {
                        table: 'asmt_metric'
                        id: '915d5c4623ec48d1b59a6aa0238a32c3'
                    }
                    m_ref: {
                        table: 'asmt_metric'
                        id: '03e6290c0eff4f8ba66bb5edee49fc56'
                    }
                    m_speed: {
                        table: 'asmt_metric'
                        id: '44107a5cb6b5464489a4f8616fbdfe8d'
                    }
                    m_text: {
                        table: 'asmt_metric'
                        id: '2bc6f67a2fe74270a517d0954ef4da8a'
                    }
                    m_yes: {
                        table: 'asmt_metric'
                        id: '989784075bca4509adcd77657e42e484'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: 'c3a0caaa554a4b1d876963af10788fa7'
                    }
                    risk: {
                        table: 'change_risk_asmt'
                        id: '92a17095559242dfbea8640bb3eb9bcd'
                    }
                    survey: {
                        table: 'asmt_metric_type'
                        id: '135c21fc62024c198d3e7c7e4f332b25'
                    }
                    t_high: {
                        table: 'change_risk_asmt_threshold'
                        id: '9aa535fea82941db80c05d1fb3d0c186'
                    }
                    t_low: {
                        table: 'change_risk_asmt_threshold'
                        id: '0368d75a2c8243169f5ec541ccabbcdf'
                    }
                    vendor: {
                        table: 'asmt_metric_type'
                        id: 'c7ebefdc2cce432489fd5a534b9a7853'
                    }
                    vendor__assessment_business_rule: {
                        table: 'sys_script'
                        id: '6041662ad37c4d3eb149ca162d13a171'
                    }
                    vendor__assessment_delete_business_rule: {
                        table: 'sys_script'
                        id: '1b1bb5273edf4dd2bbec8cbb3be3f8b6'
                    }
                    vendor__assessment_schedule_job: {
                        table: 'sys_trigger'
                        id: '3d5318dc77cb434eb2f2366430e41069'
                    }
                    vendor__assessment_user_field_business_rule: {
                        table: 'sys_script'
                        id: '07978b0d275943049fae5347ae6d7648'
                    }
                }
                composite: [
                    {
                        table: 'asmt_metric_definition'
                        id: '2040b3223e71435080f2ee083ce11a8b'
                        key: {
                            metric: '72cb1eee44ae4b3da3eed67d8c7ca98c'
                            value: '2'
                        }
                    },
                    {
                        table: 'asmt_metric_definition'
                        id: '67c9d3445b614254999e3b087f40e8fd'
                        key: {
                            metric: '72cb1eee44ae4b3da3eed67d8c7ca98c'
                            value: '1'
                        }
                    },
                    {
                        table: 'asmt_metric_definition'
                        id: 'a432e4412b164600ac5d092d8d5dd86f'
                        key: {
                            metric: '44107a5cb6b5464489a4f8616fbdfe8d'
                            value: '1'
                        }
                    },
                    {
                        table: 'sys_user_role'
                        id: 'b8afc580fe4b42478df0b74aba87a81f'
                        key: {
                            name: 'x_snc_bprobe.reviewer'
                        }
                    },
                    {
                        table: 'asmt_metric_definition'
                        id: 'bdbd369129b04d72b461f03dd1c8017e'
                        key: {
                            metric: '44107a5cb6b5464489a4f8616fbdfe8d'
                            value: '2'
                        }
                    },
                    {
                        table: 'asmt_metric_definition'
                        id: 'e67172b043d54100a1b71245e43c16cd'
                        key: {
                            metric: '44107a5cb6b5464489a4f8616fbdfe8d'
                            value: '3'
                        }
                    },
                ]
            }
        }
    }
}
