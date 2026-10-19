import { SPWidget, SPHeaderFooter, SPWidgetDependency, SPAngularProvider, Role } from '@servicenow/sdk/core'

const dep = SPWidgetDependency({ $id: Now.ID['w-dep'], name: 'Widget Dep' })
const prov = SPAngularProvider({ $id: Now.ID['w-prov'], name: 'wProv' })
const r = Role({ $id: Now.ID['w-role'], name: 'x_snc_bprobe.w_user' })

SPWidget({ $id: Now.ID['min-widget'], name: 'Min Widget' })
SPWidget({ $id: Now.ID['ctl-widget'], name: 'Ctl Widget', controllerAs: 'vm' })
SPWidget({
  $id: Now.ID['full-widget'], name: 'Full Widget', id: 'full-widget_1', category: 'knowledgeBase',
  clientScript: 'api.controller = function ($scope) {\n  var c = this;\n};', serverScript: '(function () { data.x = 1; })();',
  htmlTemplate: '<div>{{c.data.x}}</div>', customCss: '.a { color: red; }', linkScript: 'function link() {}',
  dataTable: 'incident', fields: ['number', 'short_description'], demoData: { data: { x: 1, list: ['a'] } },
  description: 'A widget', docs: 'f8af18a5e6c71a3702c4f2038b43cf62', hasPreview: true, internal: true, public: true, servicenow: true,
  roles: ['itil', r, 'itil', 'admin'],
  optionSchema: [
    { name: 'title', label: 'Title', section: 'Presentation', type: 'string', defaultValue: 'Hi', hint: 'h' },
    { name: 'tbl', label: 'Table', section: 'Data', type: 'field_list', table: 'incident' },
    { name: 'pick', label: 'Pick', section: 'Behavior', type: 'choice', choices: [{ label: 'A', value: 'a' }] },
    { name: 'ref', label: 'Ref', section: 'Data', type: 'reference', ed: { reference: 'sys_user' }, displayValueList: ['x'] },
  ],
  dependencies: [dep, '5f41b53498566648389c9b40286de458'],
  angularProviders: [prov, 'ccfbb128f13494f68c570b646ba5d335'],
  templates: [{ $id: Now.ID['tpl-1'], id: 'tpl-one.html', htmlTemplate: '<p>one</p>' }],
})
SPWidget({ $id: Now.ID['str-demo'], name: 'Str Demo', demoData: '{"a":1}', fields: [] , roles: [] })

SPHeaderFooter({ $id: Now.ID['min-hf'], name: 'Min Header' })
SPHeaderFooter({ $id: Now.ID['full-hf'], name: 'Full Header', static: true, id: 'full-header', category: 'servicePortal', dependencies: [dep] })
