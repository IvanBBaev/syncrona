import { Record } from '@servicenow/sdk/core'

const logo = Now.attach('../assets/dot.png')

Record({
    $id: Now.ID['portal-a'],
    table: 'sp_portal',
    data: {
        title: 'Portal A',
        url_suffix: 'portal-a',
        icon: logo,
        logo: logo,
    },
})

Record({
    $id: Now.ID['portal-b'],
    table: 'sp_portal',
    data: {
        title: 'Portal B',
        url_suffix: 'portal-b',
        icon: Now.attach('../assets/big.svg'),
    },
})
