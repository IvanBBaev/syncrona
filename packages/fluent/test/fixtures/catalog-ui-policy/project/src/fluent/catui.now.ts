import { CatalogItem, CatalogUiPolicy, CatalogClientScript, VariableSet, SingleLineTextVariable, CheckboxVariable } from '@servicenow/sdk/core'

export const vs = VariableSet({
    $id: Now.ID['ui_vs'],
    title: 'UI set',
    variables: { s: SingleLineTextVariable({ question: 'S' }) },
})

export const ci = CatalogItem({
    $id: Now.ID['ui_ci'],
    name: 'UI item',
    variableSets: [{ variableSet: vs, order: 100 }],
    variables: {
        a: SingleLineTextVariable({ question: 'A' }),
        b: CheckboxVariable({ question: 'B' }),
    },
})

CatalogUiPolicy({
    $id: Now.ID['p_full'],
    shortDescription: 'Full & <policy>',
    catalogItem: ci,
    catalogCondition: `${ci.variables.a}=x^${ci.variables.b}=true^EQ`,
    active: false,
    onLoad: false,
    runScripts: true,
    reverseIfFalse: false,
    executeIfTrue: 'function onCondition() { g_form.addInfoMessage("t"); }',
    runScriptsInUiType: 'desktop',
    order: 50,
    description: 'desc',
    vaSupported: false,
    actions: [
        { variableName: ci.variables.a, visible: true, mandatory: true },
        { variableName: vs.variables.s, readOnly: false, valueAction: 'setValue', value: 'v', variableMessageType: 'info', variableMessage: 'm', cleared: true, order: 5 },
    ],
})

CatalogUiPolicy({
    $id: Now.ID['p_set'],
    shortDescription: 'Set policy',
    appliesTo: 'set',
    variableSet: vs,
    catalogCondition: 'abc=1^ORdef=2^NQghi=3',
    actions: [{ variableName: 's', variable: 'other' }],
})

CatalogUiPolicy({
    $id: Now.ID['p_min'],
    shortDescription: 'Minimal',
})

CatalogClientScript({
    $id: Now.ID['cs_change'],
    name: 'On change',
    catalogItem: ci,
    type: 'onChange',
    variableName: ci.variables.a,
    script: 'function onChange(control, oldValue, newValue, isLoading) {}',
    uiType: 'mobileOrServicePortal',
    order: 7,
    appliesOnRequestedItems: true,
})

CatalogClientScript({
    $id: Now.ID['cs_set'],
    name: 'On load set',
    type: 'onLoad',
    appliesTo: 'set',
    variableSet: vs,
    script: 'function onLoad() {}',
})

CatalogClientScript({
    $id: Now.ID['cs_min'],
    name: 'Minimal',
    type: 'onSubmit',
    script: 'function onSubmit() {}',
})

CatalogClientScript({
    $id: Now.ID['cs_notype'],
    name: 'No type',
    catalogItem: '0123456789abcdef0123456789abcdef',
    variableName: ci.variables.b,
    script: 'function x() {}',
    vaSupported: true,
})
