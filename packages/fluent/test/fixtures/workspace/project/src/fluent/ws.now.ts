import { Workspace, UxListMenuConfig, Applicability, Role } from '@servicenow/sdk/core'

const role1 = Role({ $id: Now.ID['r1'], name: 'x_snc_bprobe.user' })

const applicability = Applicability({
    $id: Now.ID['workspace_applicability'],
    name: 'Workspace Audience',
    roles: [role1],
})

const listConfig = UxListMenuConfig({
    $id: Now.ID['workspace_list_config'],
    name: 'Workspace List Config',
    description: 'List configuration for workspace',
    categories: [
        {
            $id: Now.ID['incidents_category'],
            title: 'Incidents',
            order: 10,
            lists: [
                {
                    $id: Now.ID['incidents_open'],
                    title: 'Open',
                    order: 10,
                    condition: 'active=true^EQ',
                    table: 'incident',
                    columns: 'number,short_description,priority,state',
                    applicabilities: [{ $id: Now.ID['incidents_open_applicability'], applicability: applicability }],
                },
            ],
        },
    ],
})

export const W = Workspace({
    $id: Now.ID['workspace-with-list'],
    title: 'Probe Space',
    path: 'probe-space',
    landingPath: 'home',
    tables: ['incident', 'problem'],
    listConfig: listConfig,
})

export const W2 = Workspace({
    $id: Now.ID['ws_min'],
    title: 'Minimal',
    path: 'minimal',
    order: 5,
    active: false,
    listConfig: 'abc123',
    tables: [],
    landingPath: 'list',
})
