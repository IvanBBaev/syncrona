import { Record, Sla } from '@servicenow/sdk/core'

export const sched = Record({
    $id: Now.ID['sched'],
    table: 'cmn_schedule',
    data: { name: 'Probe 8-5', label: 'P', calendar_name: 'P', plural_label: 'Ps' },
})

export const slaMin = Sla({
    $id: Now.ID['sla_min'],
    name: 'Min',
    schedule: '08fcd0830a0a0b2600079f56b1adb9ae',
    duration: Duration({ hours: 8 }),
})

export const slaFull = Sla({
    $id: Now.ID['sla_full'],
    name: 'Full & <all>',
    table: 'problem',
    type: 'OLA',
    active: false,
    advancedConditionType: 'advanced',
    conditionType: 'b9c6f0110a0a0b5b000ca1a1d7bd1c7d',
    duration: Duration({ days: 1, hours: 6, minutes: 30, seconds: 15 }),
    schedule: sched,
    relativeDurationWorksOn: 'SLA record',
    conditions: {
        start: 'active=true^EQ',
        stop: 'active=false^EQ',
        pause: 'state=3^EQ',
        resume: 'state=2^EQ',
        reset: 'priority=1^EQ',
        cancel: 'state=8^EQ',
    },
    resetAction: 'complete',
    whenTo: { resume: 'on_condition', cancel: 'on_condition' },
    retroactive: { start: true, pause: false, setStartTo: 'opened_at' },
    overrides: '0b9a6d3a0a0a0b2600e8b3c4d5e6f701',
    workflow: '1b9a6d3a0a0a0b2600e8b3c4d5e6f702',
    flow: '2b9a6d3a0a0a0b2600e8b3c4d5e6f703',
    vendor: '3b9a6d3a0a0a0b2600e8b3c4d5e6f704',
    timezone: 'Europe/Sofia',
    timezoneSource: 'sla.timezone',
    target: 'resolution',
    enableLogging: true,
    domainPath: '/x/',
})

export const slaRel = Sla({
    $id: Now.ID['sla_rel'],
    name: 'Relative',
    durationType: '4b9a6d3a0a0a0b2600e8b3c4d5e6f705',
    scheduleSource: 'no_schedule',
    whenTo: { resume: 'no_match', cancel: 'never' },
    retroactive: { start: false },
})

export const slaTask = Sla({
    $id: Now.ID['sla_task'],
    name: 'Task schedule',
    scheduleSource: 'task_field',
    scheduleSourceField: 'cmdb_ci.schedule',
    duration: Duration({ days: 2 }),
    retroactive: { start: true, setStartTo: 'sys_created_on' },
})
