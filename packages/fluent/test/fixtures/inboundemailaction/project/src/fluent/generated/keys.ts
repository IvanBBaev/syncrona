import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: '842204afe739496c94810280986958ab'
                    }
                    iea_full: {
                        table: 'sysevent_in_email_action'
                        id: 'ebe8af3d19f74e858db1f7a32afa20fc'
                    }
                    iea_min: {
                        table: 'sysevent_in_email_action'
                        id: '580364318995454999e7a6781fb3c5ac'
                    }
                    iea_reply: {
                        table: 'sysevent_in_email_action'
                        id: '030b0b985a74444382c8a43c31e3a976'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: 'ad1dc6de160c4ef28eb7db5fee192ecc'
                    }
                }
                composite: [
                    {
                        table: 'sys_user_role'
                        id: '7c4f52aeb029400d85f8c3c5c88356df'
                        key: {
                            name: 'x_snc_bprobe.mailer'
                        }
                    },
                ]
            }
        }
    }
}
