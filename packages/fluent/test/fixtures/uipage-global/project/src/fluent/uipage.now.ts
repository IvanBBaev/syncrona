import '@servicenow/sdk/global'
import { UiPage } from '@servicenow/sdk/core'

UiPage({
    $id: Now.ID['g_page'],
    endpoint: 'my_global_page.do',
    html: '<div>global</div>',
    clientScript: 'var a = 1;',
})

UiPage({
    $id: Now.ID['g_dash'],
    endpoint: 'dash-page.do',
    direct: false,
})
