import { ScheduledScript, ScriptAction } from '@servicenow/sdk/core'

ScheduledScript({ $id: Now.ID['ss_min'], name: 'Min Job', script: `gs.info('min');` })
ScheduledScript({ $id: Now.ID['ss_bare'], name: 'Bare Job' })
ScheduledScript({
    $id: Now.ID['ss_daily_ny'],
    name: 'Daily NY',
    frequency: 'daily',
    executionTime: { hours: 2, minutes: 30, seconds: 5 },
    executionStart: '2024-01-01 00:00:00',
    executionEnd: '2025-12-31 23:59:59',
    timeZone: 'America/New_York',
    conditional: true,
    condition: `answer = gs.getProperty('x') == 'true';`,
    script: Now.include('../server/sched/job.server.js'),
})
ScheduledScript({
    $id: Now.ID['ss_weekly'],
    name: 'Weekly Sofia',
    frequency: 'weekly',
    daysOfWeek: ['monday', 'wednesday', 'sunday'],
    dayOfWeek: 'friday',
    executionTime: Time({ hours: 9, minutes: 15 }, 'Europe/Sofia'),
    timeZone: 'Europe/Sofia',
    script: 'gs.info("weekly <&>");',
})
ScheduledScript({
    $id: Now.ID['ss_periodic'],
    name: 'Periodic',
    active: false,
    frequency: 'periodically',
    executionInterval: Duration({ hours: 4, minutes: 5 }),
    maxDrift: { minutes: 10 },
    offset: Duration({ days: 1, seconds: 3 }),
    offsetType: 'past',
    executionStart: '2024-03-01 10:00:00',
    timeZone: 'UTC',
    repeatEvery: 3,
    runAs: '6816f79cc0a8016401c5a33be04be441',
    userTimeZone: 'Asia/Kolkata',
    upgradeSafe: true,
    advanced: true,
    protectionPolicy: 'read',
    $meta: { installMethod: 'demo' },
    script: 'gs.info("p");',
})
ScheduledScript({
    $id: Now.ID['ss_monthly'],
    name: 'Monthly',
    frequency: 'day_week_month_year',
    dayOfMonth: 15,
    weekInMonth: 2,
    month: 11,
    offsetType: 'future',
    timeZone: 'floating',
    executionTime: { hours: 23, minutes: 59, seconds: 59 },
    executionStart: '2024-01-01 08:00:00',
    script: 'gs.info("m");',
})
ScheduledScript({
    $id: Now.ID['ss_cal'],
    name: 'Calendar',
    frequency: 'business_calendar_start',
    businessCalendar: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    timeZone: 'Asia/Kolkata',
    script: 'gs.info("c");',
})
ScheduledScript({
    $id: Now.ID['ss_ondemand'],
    name: 'On demand',
    frequency: 'on_demand',
    timeZone: 'America/Los_Angeles',
    executionStart: '2024-07-01 12:00:00',
    executionTime: Time({ hours: 0, minutes: 0, seconds: 30 }, 'America/Los_Angeles'),
    script: 'gs.info("o");',
})

ScriptAction({ $id: Now.ID['sa_min'], name: 'Min SA', eventName: 'x_snc_bprobe.min', script: `gs.info('sa');` })
ScriptAction({
    $id: Now.ID['sa_full'],
    name: 'Full SA',
    eventName: 'x_snc_bprobe.full',
    active: true,
    order: 250,
    description: 'Full <desc> & "q"',
    conditionScript: `event.parm1 == 'x'`,
    protectionPolicy: 'protected',
    $meta: { installMethod: 'first install' },
    script: Now.include('../server/sched/job.server.js'),
})
