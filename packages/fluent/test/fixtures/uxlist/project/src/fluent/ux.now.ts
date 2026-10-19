import { UxListMenuConfig, Applicability, Role } from '@servicenow/sdk/core'

const viewer = Role({ $id: Now.ID['viewer_role'], name: 'x_snc_bprobe.viewer' })

export const full = Applicability({
    $id: Now.ID['app_full'],
    name: 'Full Audience',
    description: 'Viewers and helpdesk',
    active: false,
    roles: [viewer, viewer],
    roleNames: 'itil,x_snc_bprobe.viewer',
})

export const minimal = Applicability({
    $id: Now.ID['app_minimal'],
    name: 'Minimal',
    $meta: { installMethod: 'demo' },
})

export const bySysId = Applicability({
    $id: Now.ID['app_sysid'],
    name: 'By sys_id',
    roles: ['282bf1fac6112285017366cb5f867469', '2831a114c611228501d4ea6c309d626d'],
})

export const empty = UxListMenuConfig({
    $id: Now.ID['menu_empty'],
    name: 'Empty Menu',
})

export const menu = UxListMenuConfig({
    $id: Now.ID['menu_full'],
    name: 'Full Menu',
    active: false,
    description: 'Every list option',
    categories: [
        {
            $id: Now.ID['cat_defaults'],
            title: 'Defaults',
            lists: [],
        },
        {
            $id: Now.ID['cat_lists'],
            title: 'Lists',
            active: false,
            order: 20,
            description: 'All the lists',
            lists: [
                {
                    $id: Now.ID['list_defaults'],
                    table: 'problem',
                    title: 'Problems',
                },
                {
                    $id: Now.ID['list_full'],
                    active: false,
                    table: 'incident',
                    title: 'Everything',
                    columns: 'number,state',
                    condition: 'active=true',
                    enableInfiniteScroll: true,
                    fixedQuery: 'priority=1',
                    groupByColumn: 'state',
                    groups: 'state',
                    hideCellFilter: true,
                    hideCheckboxHover: true,
                    hideColumnFiltering: true,
                    hideColumnGrouping: true,
                    hideColumnResizing: true,
                    hideColumnSorting: true,
                    hideDragAndDrop: true,
                    hideEmptyStateImage: true,
                    hideFirstPage: true,
                    hideHeader: true,
                    hideHighlightContent: true,
                    hideHighlightedValues: true,
                    hideInlineEditing: true,
                    hideLastPage: true,
                    hideLastRefreshedText: true,
                    hideLinks: true,
                    hideListActions: true,
                    hideMenuButton: true,
                    hideNextPage: true,
                    hideOptionToSaveAs: true,
                    hidePages: true,
                    hidePagination: true,
                    hidePanelAdvanced: true,
                    hidePanelButton: true,
                    hidePanelConditionDelete: true,
                    hidePanelFooter: true,
                    hidePanelRestore: true,
                    hidePersonalization: true,
                    hidePreviousPage: true,
                    hideQuickEdit: true,
                    hideRange: true,
                    hideRecordCountBadge: true,
                    hideReferenceLinks: true,
                    hideRefreshButton: true,
                    hideRowCount: true,
                    hideRowSelector: true,
                    hideRowsPerPageSelector: true,
                    hideSelectAll: true,
                    hideSharingButton: true,
                    hideTitle: true,
                    highlightContentColor: 'red',
                    highlightContentPattern: 'P1',
                    listAttributes: 'a=b',
                    liveUpdates: 'on',
                    maxCharacters: 200,
                    order: 5,
                    overrideWordWrapUserPref: true,
                    roles: 'itil,admin',
                    view: 'workspace',
                    wordWrap: true,
                    applicabilities: [
                        { $id: Now.ID['m2m_record'], applicability: full },
                        { $id: Now.ID['m2m_string'], applicability: 'e1f8d68e6737402fa2f66d31920b838c', active: false, order: 3 },
                    ],
                },
            ],
        },
    ],
})
