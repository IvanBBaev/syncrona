import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: '213e6725a3404e42b05c26e4220e8c50'
                    }
                    ct_bare: {
                        table: 'scan_column_type_check'
                        id: '98874d143fcd4dcf9ae2f471cec0c8e2'
                    }
                    ct_min: {
                        table: 'scan_column_type_check'
                        id: '782ca0f451904787af1ddf8771d4a45d'
                    }
                    lc_min: {
                        table: 'scan_linter_check'
                        id: 'd63cda37cb304d2bbcbd881a6739cb1a'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: 'a4cf2190af5f437b8e9e1f6a5fe62c7c'
                    }
                    so_explicit_guid_0000000000000001: {
                        table: 'scan_script_only_check'
                        id: 'd1e9e8dc43a44e38b0e02ff227c7cc25'
                    }
                    so_min: {
                        table: 'scan_script_only_check'
                        id: 'a04149bfedf54f7ab69b9327bedc9100'
                    }
                    src_server_scan_table_server_js: {
                        table: 'sys_module'
                        id: 'eef41dac2cb94899840daf47b8281164'
                    }
                    tc_full: {
                        table: 'scan_table_check'
                        id: '2608989e7dcb40689f469b7762327e38'
                    }
                    tc_min: {
                        table: 'scan_table_check'
                        id: 'fdd25aecc7d348a08b82ee3ffb71bb13'
                    }
                }
            }
        }
    }
}
