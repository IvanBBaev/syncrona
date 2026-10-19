import { SPPage, SPMenu, SPWidget, Role } from '@servicenow/sdk/core'

const w = SPWidget({ $id: Now.ID['p-widget'], name: 'Page Widget' })
const r = Role({ $id: Now.ID['p-role'], name: 'x_snc_bprobe.p_user' })

SPPage({ pageId: 'min_page' })
SPPage({
  pageId: 'full_page', title: 'Full Page', category: 'sc', css: '.p{}', draft: true, internal: true, omitWatcher: true, public: true,
  shortDescription: 'sd', dynamicTitleStructure: 'T ${number}', humanReadableUrlStructure: 'kb/%sys_id', roles: ['itil', r, 'itil'],
  containers: [
    { $id: Now.ID['c1'], rows: [{ $id: Now.ID['r1'], columns: [{ $id: Now.ID['col1'], instances: [{ $id: Now.ID['i1'], widget: w }] }] }] },
    {
      $id: Now.ID['c2'], name: 'Named', width: 'container-fluid', backgroundStyle: 'cover', backgroundColor: '#fff', backgroundImage: 'img.png',
      cssClass: 'cc', parentClass: 'pc', subheader: true, bootstrapAlt: true, semanticTag: 'main', title: 'CT', order: 7,
      rows: [{
        $id: Now.ID['r2'], cssClass: 'rc', semanticTag: 'main', order: 3,
        columns: [{
          $id: Now.ID['col2'], size: 6, sizeSm: 4, sizeLg: 8, sizeXs: 12, cssClass: 'colc', order: 2,
          nestedRows: [{ $id: Now.ID['nr'], columns: [{ $id: Now.ID['ncol'] }] }],
          instances: [{
            $id: Now.ID['i2'], title: 'I', id: 'inst', widget: '5f41b53498566648389c9b40286de458', widgetParameters: { a: 1, b: true, c: 'x' },
            css: 'ic', url: '/u', glyph: 'home', size: 'lg', color: 'primary', cssClass: 'icc', active: false, order: 5, roles: [r, 'admin'],
            shortDescription: 'isd', asyncLoad: true, preservePlaceholderSize: true, advancedPlaceholderDimensions: true,
            placeholderDimensions: { mobile: { height: '1px' } }, placeholderConfigurationScript: 'function x() {}', placeholderTemplate: '<i></i>',
            asyncLoadTrigger: 'parallel', asyncLoadDeviceType: 'mobile',
          }, { $id: Now.ID['i3'], widgetParameters: '{"k":"v"}' }],
        }],
      }],
    },
  ],
})

SPMenu({ $id: Now.ID['min-menu'] })
SPMenu({
  $id: Now.ID['full-menu'], title: 'Menu', id: 'menu1', widget: w, widgetParameters: { a: 1, b: true }, css: 'm', url: '/m', glyph: 'g',
  size: 'sm', color: 'info', cssClass: 'mc', active: false, order: 4, roles: ['itil', r], shortDescription: 'msd', asyncLoad: true,
  asyncLoadTrigger: 'parallel', asyncLoadDeviceType: 'tablet', preservePlaceholderSize: true, advancedPlaceholderDimensions: true,
  placeholderDimensions: { a: 1 }, placeholderConfigurationScript: 's', placeholderTemplate: 't',
  items: [
    { $id: Now.ID['mi1'], label: 'Home', type: 'page', page: 'f8af18a5e6c71a3702c4f2038b43cf62', childItems: [{ $id: Now.ID['mi1c'], label: 'Kid', type: 'url', url: '/k', urlTarget: '_blank' }] },
    { $id: Now.ID['mi2'], label: 'Filtered', type: 'filtered', order: 3, active: false, roles: [r], glyph: 'x', color: 'danger', hint: 'h', shortDescription: 's',
      condition: 'c', table: 'incident', filter: 'active=true', display1: 'number', display2: 'short_description', displayDate: 'sys_created_on', script: 'x()' },
  ],
})
