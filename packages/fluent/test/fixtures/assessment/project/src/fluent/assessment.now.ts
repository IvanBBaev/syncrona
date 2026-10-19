import { Assessment, RiskAssessment, Role } from '@servicenow/sdk/core'

const reviewer = Role({ $id: Now.ID['reviewer'], name: 'x_snc_bprobe.reviewer' })

Assessment({
    $id: Now.ID['vendor'],
    name: 'Vendor Review',
    table: 'incident',
    description: 'Rates vendors',
    introduction: 'Please answer',
    endNote: 'Thanks',
    hideSurveyIntroductionNotes: true,
    active: true,
    condition: 'active=true',
    scoringType: 'allOrNothing',
    scaleFactor: 100,
    scheduleType: 'scheduled',
    schedulePeriod: 'weekly',
    assessmentDuration: Duration({ days: 3, hours: 4 }),
    allowRetake: true,
    anonymizeResponses: true,
    roles: [reviewer, 'admin', 'admin'],
    userField: 'assigned_to',
    filterField: 'short_description',
    returnUrl: 'home.do',
    liveFeed: true,
    portalPagination: 'question',
    owners: ['6816f79cc0a8016401c5a33be04be441'],
    sendNotifications: false,
    notifyIfOverdue: true,
    assessmentManager: '6816f79cc0a8016401c5a33be04be441',
    state: 'published',
    allowPublic: true,
    categories: [
        {
            $id: Now.ID['cat_quality'],
            name: 'Quality',
            description: 'Quality of service',
            details: '<p>Details</p>',
            weight: 20,
            order: 2,
            scoringType: 'percentage',
            roles: ['itil', reviewer],
            filter: 'priority=1',
            createStakeholders: true,
            metrics: [
                {
                    $id: Now.ID['m_speed'],
                    name: 'Speed',
                    question: 'How fast?',
                    dataType: 'numericScale',
                    min: 1,
                    max: 3,
                    scored: true,
                    weight: 5,
                    order: 200,
                    mandatory: true,
                },
                {
                    $id: Now.ID['m_choice'],
                    name: 'Choice',
                    question: 'Pick one',
                    dataType: 'choice',
                    randomizeAnswers: true,
                    definitions: {
                        '1': 'Bad',
                        '2': { label: 'Good', order: 50, normalizationInput: 7, selectedImage: 'a.png' },
                    },
                },
                {
                    $id: Now.ID['m_text'],
                    name: 'Text',
                    question: 'Comments?',
                    dataType: 'string',
                    stringOption: 'singleLineWide',
                    method: 'defaultAnswerFromScript',
                    dependentPlugin: 'CMDB',
                    script: 'answer = "x";',
                    condQuestion: 'ifScriptEmpty',
                    dependsOn: Now.ID['m_choice'],
                    allowAdditionalInformation: true,
                    additionalInformationLabel: 'More',
                    hideLabel: true,
                },
                {
                    $id: Now.ID['m_ref'],
                    name: 'Owner',
                    question: 'Who?',
                    dataType: 'reference',
                    referenceTable: 'sys_user',
                    defaultAnswer: 'assigned_to',
                    method: 'defaultAnswerFromField',
                },
            ],
        },
        {
            $id: Now.ID['cat_empty_scale'],
            name: 'Scale',
            metrics: [{ $id: Now.ID['m_yes'], name: 'Yes', question: 'Agree?', dataType: 'yesNo', correctAnswerYesNo: 'yes' }],
        },
    ],
})

Assessment({
    $id: Now.ID['survey'],
    name: 'Pulse Survey',
    evaluationMethod: 'survey',
    assessmentDuration: { hours: 5, minutes: 30 },
    categories: [
        {
            $id: Now.ID['cat_pulse'],
            name: 'Pulse',
            metrics: [{ $id: Now.ID['m_mood'], name: 'Mood', question: 'Mood?', dataType: 'likertScale', scaleDefinition: 'low' }],
        },
    ],
})

Assessment({
    $id: Now.ID['bare'],
    name: 'Bare',
    table: 'task',
    scaleFactor: 10,
})

RiskAssessment({
    $id: Now.ID['risk'],
    name: 'Change Risk',
    scaleFactor: 50,
    assessmentDuration: { days: 1 },
    thresholds: [
        { $id: Now.ID['t_high'], risk: 'high', scoreGreaterThan: 80 },
        { $id: Now.ID['t_low'], risk: 'low', scoreGreaterThan: 10 },
    ],
    categories: [
        {
            $id: Now.ID['cat_risk'],
            name: 'Impact',
            metrics: [{ $id: Now.ID['m_impact'], name: 'Impact', question: 'Impact?', dataType: 'number', max: 5 }],
        },
    ],
})
