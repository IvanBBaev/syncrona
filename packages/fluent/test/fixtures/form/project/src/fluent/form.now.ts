import { AnnotationType, Form, Formatter, Record, default_view } from '@servicenow/sdk/core'

Form({
    table: 'incident',
    view: default_view,
    sections: [
        {
            caption: 'Details',
            content: [
                {
                    layout: 'one-column',
                    elements: [
                        { field: 'number', type: 'table_field' },
                        { field: 'short_description', type: 'table_field' },
                    ],
                },
            ],
        },
    ],
})

const ops = Record({
    $id: Now.ID['ops-view'],
    table: 'sys_ui_view',
    data: { name: 'x_snc_bprobe_ops', title: 'Operations' },
})

const rel = Record({
    $id: Now.ID['rel'],
    table: 'sys_relationship',
    data: { name: 'Probe rel' },
})

Form({
    table: 'x_snc_bprobe_task',
    view: ops,
    roles: ['admin', 'itil'],
    user: 'abel.tuter',
    sections: [
        {
            caption: 'Overview',
            header: true,
            title: true,
            content: [
                {
                    layout: 'two-column',
                    leftElements: [
                        { field: 'name', type: 'table_field' },
                        { field: 'category', type: 'table_field' },
                    ],
                    rightElements: [{ field: 'priority', type: 'table_field' }],
                },
                {
                    layout: 'one-column',
                    elements: [
                        {
                            type: 'annotation',
                            annotationId: Now.ID['note-1'],
                            text: 'Review <b>all</b> fields & save.',
                            isPlainText: false,
                            annotationType: AnnotationType.Info_Box_Red,
                        },
                        { type: 'annotation', annotationId: Now.ID['note-2'], text: 'Plain' },
                        {
                            type: 'annotation',
                            annotationId: Now.ID['note-3'],
                            text: 'Keyed',
                            annotationType: 'Section_Details',
                        },
                        { field: 'description', type: 'table_field' },
                    ],
                },
            ],
        },
        {
            caption: 'Activity & lists',
            content: [
                {
                    layout: 'one-column',
                    elements: [
                        { type: 'formatter', formatterRef: 'Activities_Filtered' },
                        { type: 'formatter', formatterRef: Formatter.Attached_Knowledge },
                        { type: 'formatter', formatterRef: '0123456789abcdef0123456789abcdef', formatterName: 'custom.xml' },
                        { type: 'list', listType: '12M', listRef: 'task_sla.task' },
                        { type: 'list', listType: 'M2M', listRef: 'x_m2m.parent' },
                        { type: 'list', listType: 'custom', listRef: rel },
                        { type: 'list', listType: 'custom', listRef: 'fedcba9876543210fedcba9876543210' },
                    ],
                },
            ],
        },
    ],
})

Form({
    table: 'x_snc_bprobe_task',
    view: 'x_snc_bprobe_byname',
    sections: [
        {
            caption: 'Only',
            content: [{ layout: 'one-column', elements: [{ field: 'name', type: 'table_field' }] }],
        },
    ],
})
