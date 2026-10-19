import { Dashboard, Role, Workspace } from '@servicenow/sdk/core'

Role({ $id: Now.ID['viewer'], name: 'x_snc_bprobe.viewer' })

const space = Workspace({ $id: Now.ID['space'], title: 'Space', path: 'space', tables: [] })

Dashboard({
    $id: Now.ID['ops'],
    name: 'Operations',
    description: 'Ops overview',
    certified: true,
    topLayout: {
        widgets: [
            {
                $id: Now.ID['top_heading'],
                component: 'heading',
                componentProps: { title: 'Welcome', headingLevel: 1 },
                height: 2,
                width: 12,
                position: { x: 0, y: 0 },
            },
        ],
    },
    tabs: [
        {
            $id: Now.ID['tab_main'],
            name: 'Main',
            widgets: [
                {
                    $id: Now.ID['w_score'],
                    component: 'Single-Score',
                    componentProps: { chartVariation: 'grouped', dataSources: [{ tableOrViewName: 'incident' }] },
                    height: 4,
                    width: 6,
                    position: { x: 0, y: 2 },
                },
                {
                    $id: Now.ID['w_custom'],
                    component: '0123456789abcdef0123456789abcdef',
                    componentProps: {},
                    height: 4,
                    width: 6,
                    position: { x: 6, y: 2 },
                },
            ],
        },
        { $id: Now.ID['tab_hidden'], name: 'Hidden', active: false, widgets: [] },
    ],
    visibilities: [
        { $id: Now.ID['vis_space'], experience: space },
        { $id: Now.ID['vis_id'], experience: 'a84adaf4c700201072b211d4d8c260b7' },
    ],
    permissions: [
        { $id: Now.ID['perm_role'], role: 'x_snc_bprobe.viewer', canWrite: true },
        { $id: Now.ID['perm_user'], user: '6816f79cc0a8016401c5a33be04be441', canRead: false, canShare: true, owner: true },
        { $id: Now.ID['perm_group'], group: '019ad92ec7230010393d265c95c260dd' },
    ],
})

Dashboard({ $id: Now.ID['bare'], name: 'Bare', active: false })
