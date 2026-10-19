import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: '89a6e37dd87a46048b3e5b090313fcb8'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '0e217e3aa4ff43dea6a73a90d8d8ac7b'
                    }
                    sa_full: {
                        table: 'sysevent_script_action'
                        id: '0f9e58cd6c8144ff888e9d0d7669b94a'
                    }
                    sa_min: {
                        table: 'sysevent_script_action'
                        id: '2e8bae6a165e4b9bbaa9dce57e1c15d4'
                    }
                    src_server_sched_job_server_js: {
                        table: 'sys_module'
                        id: 'db18c44be9a043268d2a977142a3760f'
                    }
                    ss_bare: {
                        table: 'sysauto_script'
                        id: 'c56b0154a5364e54a8bc69a916401939'
                    }
                    ss_cal: {
                        table: 'sysauto_script'
                        id: 'e1483196bc6f408880843f54fa123f65'
                    }
                    ss_daily_ny: {
                        table: 'sysauto_script'
                        id: '8b342449288b4e618e0dc6d1429689be'
                    }
                    ss_min: {
                        table: 'sysauto_script'
                        id: 'fe4731fa0d2741dc90bb91438b5ae1ef'
                    }
                    ss_monthly: {
                        table: 'sysauto_script'
                        id: '909541cd0f364e78bb435d139adc3dcc'
                    }
                    ss_ondemand: {
                        table: 'sysauto_script'
                        id: '4f5e5c04e31c4dd492d960d61d210323'
                    }
                    ss_periodic: {
                        table: 'sysauto_script'
                        id: 'dfea9beb0bad415898a0ed68b7511169'
                    }
                    ss_weekly: {
                        table: 'sysauto_script'
                        id: 'b6e41d1f685247af93721a2e666ed50d'
                    }
                }
            }
        }
    }
}
