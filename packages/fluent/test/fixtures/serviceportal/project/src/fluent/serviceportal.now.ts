import { SPAngularProvider, SPWidgetDependency, CssInclude, JsInclude, SPTheme, SPPageRouteMap, Role } from '@servicenow/sdk/core'

export const child = SPAngularProvider({ $id: Now.ID['child-provider'], name: 'childProvider', script: '// child script', type: 'directive' })
SPAngularProvider({ $id: Now.ID['min-provider'], name: 'minProvider' })
SPAngularProvider({ $id: Now.ID['parent-provider'], name: 'parentProvider', script: '// svc', type: 'service', requires: ['5f41b53498566648389c9b40286de458', child] })

const urlCss = CssInclude({ $id: Now.ID['url-css'], name: 'Bootstrap CSS', url: 'https://cdn.example.com/b.css', rtlCssUrl: 'https://cdn.example.com/b.rtl.css' })
const spCss = CssInclude({ $id: Now.ID['sp-css'], name: 'Portal CSS', spCss: 'ccfbb128f13494f68c570b646ba5d335', lazyLoad: true })
const urlJs = JsInclude({ $id: Now.ID['url-js'], name: 'Chart.js', url: 'https://cdn.example.com/chart.js' })
const uiJs = JsInclude({ $id: Now.ID['ui-js'], name: 'UI Script', sysUiScript: '5f41b53498566648389c9b40286de458' })

SPWidgetDependency({ $id: Now.ID['min-dep'], name: 'Min Dependency' })
SPWidgetDependency({
  $id: Now.ID['full-dep'], name: 'Full Dependency', angularModuleName: 'myModule', includeOnPageLoad: true,
  portalsForPageLoad: ['fe12dbbed14bd3f712f0787141c2f656', '0ae1e6c6c0a8016400b98a06818d57c7'],
  jsIncludes: [{ order: 100, include: urlJs }, { order: 200, include: uiJs }],
  cssIncludes: [{ order: 100, include: urlCss }, { order: 200, include: spCss }],
})

SPTheme({ $id: Now.ID['min-theme'], name: 'Min Theme' })
SPTheme({
  $id: Now.ID['full-theme'], name: 'Full Theme', customCss: '--primary-color: blue;', header: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', footer: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  fixedHeader: false, fixedFooter: true, turnOffScssCompilation: true, matchingNextExperienceTheme: 'now-dark',
  icon: 'test-icon-sys-id', logo: 'test-logo-sys-id', logoAltText: 'Logo',
  cssIncludes: [{ order: 100, include: urlCss }, { order: 200, include: '94112ccb0fb3c2ed072b01d3cb401196' }],
  jsIncludes: [{ order: 100, include: urlJs }, { order: 200, include: 'f8af18a5e6c71a3702c4f2038b43cf62' }],
})

const r = Role({ $id: Now.ID['sp-role'], name: 'x_snc_bprobe.sp_user' })
SPPageRouteMap({ $id: Now.ID['min-route'], routeFromPage: 'a4e3c21047132100ba13a5554ee49001', routeToPage: '07261a2147132100ba13a5554ee49092' })
SPPageRouteMap({
  $id: Now.ID['full-route'], routeFromPage: 'b5f4d31047132100ba13a5554ee49002', routeToPage: 'c6e5e42047132100ba13a5554ee49003',
  shortDescription: 'Redirect ITIL', portals: ['fe12dbbed14bd3f712f0787141c2f656'], roles: ['itil', r, 'admin'], active: false, order: 50,
})
