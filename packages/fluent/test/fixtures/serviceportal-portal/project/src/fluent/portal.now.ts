import { ServicePortal, SPPage, SPMenu, SPTheme, Record } from '@servicenow/sdk/core'

const home = SPPage({ pageId: 'portal_home', title: 'Home' })
const theme = SPTheme({ $id: Now.ID['theme'], name: 'Portal Theme' })
const menu = SPMenu({ $id: Now.ID['menu'], title: 'Main' })
const kb = Record({ $id: Now.ID['kb'], table: 'kb_knowledge_base', data: { title: 'KB', owner: '6816f79cc0a8016401c5a33be04be441', application: 'x' } })

ServicePortal({ $id: Now.ID['min-portal'], title: 'Min Portal', urlSuffix: 'min' })
ServicePortal({
  $id: Now.ID['full-portal'], title: 'Full Portal', urlSuffix: 'full-portal_x',
  icon: 'icon-id', logo: 'logo-id', logoAltText: 'Logo', quickStartConfig: '{"a":1}',
  embeddableMacroponents: ['m1', 'm2'], communicationChannels: ['c1', 'c2'], cssVariables: '$a: 1;',
  theme: theme, darkTheme: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', mainMenu: menu,
  categoryHomePage: home, homePage: home, searchResultsConfiguration: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  searchApplication: 'cccccccccccccccccccccccccccccccc', catalogHomePage: 'dddddddddddddddddddddddddddddddd',
  loginPage: home, knowledgeHomePage: '88888888888888888888888888888888', chatQueue: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee', notFoundPage: home,
  textIndexGroup: 'ffffffffffffffffffffffffffffffff', enableAiSearch: true, enableCertificateBasedAuthentication: true,
  enableWebEmbeddables: true, enableFavorites: true, inactive: true, alternatePortal: '11111111111111111111111111111111',
  hidePortalName: true, supportRightToLeftLanguages: true, defaultPortal: true,
  searchSources: [{ searchSource: '22222222222222222222222222222222', order: 5 }, { searchSource: '33333333333333333333333333333333' }],
  taxonomies: [{ taxonomy: '44444444444444444444444444444444', active: false }],
  knowledgeBases: [{ knowledgeBase: kb, order: 10 }, { knowledgeBase: '55555555555555555555555555555555', active: false, order: 0 }],
  catalogs: [{ catalog: '66666666666666666666666666666666', order: 7, active: true }],
})
ServicePortal({ $id: Now.ID['dep-portal'], title: 'Deprecated Portal', urlSuffix: 'dep', knowledgeBase: kb, catalog: '77777777777777777777777777777777' })
