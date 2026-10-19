import '@servicenow/sdk/global'
import { Test, Record } from '@servicenow/sdk/core'

export const minimal = Test({ $id: Now.ID['minimal-test'], name: 'Minimal test' }, (_atf) => {})

export const user = Record({ $id: Now.ID['user'], table: 'sys_user', data: { user_name: 'probe' } })

export const full = Test(
    {
        $id: Now.ID['full-test'],
        name: 'Full <test> & more',
        active: false,
        description: 'Covers steps',
        failOnServerError: true,
        protectionPolicy: 'read',
    },
    (atf) => {
        atf.server.log({ $id: Now.ID['log1'], log: 'hello' })
        atf.server.impersonate({ $id: Now.ID['imp'], user: user })
        const inserted = atf.server.recordInsert({
            $id: Now.ID['ins'],
            table: 'incident',
            fieldValues: { short_description: 'a^b', priority: 1, active: true },
            description: 'insert it',
            notes: 'n',
            warning: 'w',
            timeout: Duration({ seconds: 30 }),
        })
        atf.server.recordUpdate({
            $id: Now.ID['upd'],
            table: 'incident',
            recordId: inserted.record_id,
            fieldValues: { short_description: `updated ${inserted.record_id}` },
            enforceSecurity: false,
        })
        atf.server.log({ $id: Now.ID['log2'], log: `id=${inserted.record_id} t=${inserted.table}`, active: false })
        atf.rest.sendRestRequest({
            $id: Now.ID['rest'],
            path: '/api/now/table/incident',
            method: 'post',
            headers: { Accept: 'application/json' },
            queryParameters: {},
            body: '{"a":1}',
        })
        atf.rest.assertStatusCode({ $id: Now.ID['code'], statusCode: 201 })
        atf.server.recordQuery({ $id: Now.ID['q'], table: 'incident', fieldValues: 'active=true' })
        atf.email.generateRandomString({ $id: Now.ID['rand'] })
        atf.form.openNewForm({ $id: Now.ID['form'], table: 'incident' })
    }
)
