import '@servicenow/sdk/global'

declare global {
    namespace Now {
        namespace Internal {
            interface Keys extends KeysRegistry {
                explicit: {
                    bom_json: {
                        table: 'sys_module'
                        id: 'a409a05c382e457d942dd83aa824dcdf'
                    }
                    full: {
                        table: 'sysevent_email_action'
                        id: 'e9c6a6c6a3a1475c9603219bb37b6330'
                    }
                    group: {
                        table: 'sys_user_group'
                        id: '8c02729b768b4d6e8b5c3998aca952fc'
                    }
                    minimal: {
                        table: 'sysevent_email_action'
                        id: 'a9a03f547acc4729989e967ca98eef67'
                    }
                    package_json: {
                        table: 'sys_module'
                        id: '87aabd4df048406193a472f1f1883f76'
                    }
                    templated: {
                        table: 'sysevent_email_action'
                        id: 'd9a97200b75d41ba9d6f3ef3e73e8cdf'
                    }
                    tpl: {
                        table: 'sysevent_email_template'
                        id: 'd494bafb0eda477ba8a096b4ca8233e0'
                    }
                    user: {
                        table: 'sys_user'
                        id: 'a6de8239e1a844a98b349699da5734f0'
                    }
                }
            }
        }
    }
}
