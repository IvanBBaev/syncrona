import '@servicenow/sdk/global'
import { Test, Record } from '@servicenow/sdk/core'

export const app = Record({ $id: Now.ID['app'], table: 'sys_app_application', data: { title: 'A' } })

export const noid = Test({ $id: Now.ID['t2'], name: 'Second test' }, (atf) => {
    atf.server.log({ $id: 3, log: 'numeric id step' })
    atf.applicationNavigator.applicationMenuVisibility({
        $id: Now.ID['vis'],
        visible: [app, '0123456789abcdef0123456789abcdef'],
        timeout: { minutes: 1, seconds: 5 },
    })
    // @ts-ignore
    atf.server.nope({ $id: Now.ID['nope'] })
    // @ts-ignore
    atf.bogus.log({ $id: Now.ID['bogus'] })
    atf.server.log({ $id: Now.ID['after'], log: 'after' })
})
