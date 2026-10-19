import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: '8734bceaaf8c48d695ca45805919c4b7'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: 'd237bbe7a861471682f2dcdef93ad2a8'
                    }
                    'portal-a': {
                        table: 'sp_portal'
                        id: 'ed59168f90f64f01963f069c85906a64'
                    }
                    'portal-b': {
                        table: 'sp_portal'
                        id: '883dc950931c4e84abc12dd43ac70425'
                    }
                }
            }
        }
    }
}
