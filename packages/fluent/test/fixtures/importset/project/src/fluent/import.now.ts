import { ImportSet } from '@servicenow/sdk/core'

ImportSet({
    $id: Now.ID['users'],
    name: 'Users import',
    sourceTable: 'x_snc_bprobe_users_import',
    targetTable: 'sys_user',
    active: true,
    order: 50,
    runBusinessRules: true,
    enforceMandatoryFields: 'onlyMappedFields',
    copyEmptyFields: true,
    createOnEmptyCoalesce: true,
    runScript: true,
    script: `(function transformRow(source, target, map, log, isUpdate) {
    target.active = true;
})(source, target, map, log, action==="update");`,
    fields: {
        user_name: { sourceField: 'u_login', coalesce: true, coalesceCaseSensitive: true, coalesceEmptyFields: true },
        email: 'u_email',
        manager: { sourceField: 'u_manager', referenceValueField: 'user_name', choiceAction: 'ignore' },
        title: { useSourceScript: true, sourceScript: 'answer = source.u_title.toUpperCase();' },
        hire_date: { sourceField: 'u_hired', dateFormat: 'yyyy-MM-dd' },
    },
    scripts: [
        { $id: Now.ID['before'], when: 'onBefore', order: 10, script: 'log.info("before");' },
        { $id: Now.ID['done'], when: 'onComplete', active: false },
    ],
})

ImportSet({
    $id: Now.ID['bare'],
    name: 'Bare import',
    sourceTable: 'x_snc_bprobe_bare_import',
    targetTable: 'cmdb_ci',
    fields: { name: 'u_name' },
})
