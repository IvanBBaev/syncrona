import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: 'd07b78f33e44460ba3a3d7d0135f4511'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '14f91748068f42fd885f0d4137b55aef'
                    }
                    sched: {
                        table: 'cmn_schedule'
                        id: 'd55502989bae40958c17fd39a0adc155'
                    }
                    sla_full: {
                        table: 'contract_sla'
                        id: '6cb9f4c0da824063b8772fbc919f4b02'
                    }
                    sla_min: {
                        table: 'contract_sla'
                        id: '8f177b2a0e46499bb7e6336dc56ee590'
                    }
                    sla_rel: {
                        table: 'contract_sla'
                        id: '902310e163fe4eea9b974119f7011034'
                    }
                    sla_task: {
                        table: 'contract_sla'
                        id: 'ce90a2ea47f14509acf2272c0d178aa2'
                    }
                }
            }
        }
    }
}
