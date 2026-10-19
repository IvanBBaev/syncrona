import '@servicenow/sdk/global'
import { Interceptor, Record, Role } from '@servicenow/sdk/core'

export const minimal = Interceptor({
    name: 'Minimal',
})

export const follow = Interceptor({
    name: 'Follow-up question',
    question: 'Which category?',
    intercepts: 'incident.do',
    answers: [
        {
            $id: Now.ID['follow-only'],
            answer: 'Only answer',
            targetUrl: 'incident.do?sys_id=-1',
        },
    ],
})

export const wizardUser = Role({
    $id: Now.ID['wizard-user'],
    name: 'x_snc_bprobe.wizard_user',
})

export const recordWizard = Record({
    $id: Now.ID['record-wizard'],
    table: 'sys_wizard',
    data: { name: 'Record wizard', question: 'From Record()' },
})

export const full = Interceptor({
    name: 'Full "quoted" Interceptor',
    question: 'Create <what> & "why"?',
    intercepts: 'x_snc_bprobe_task.do',
    backPanel: '0123456789abcdef0123456789abcdef',
    nextPanel: minimal,
    protectionPolicy: 'read',
    answers: [
        {
            $id: Now.ID['full-form'],
            answer: 'Go to the form',
            targetUrl: 'x_snc_bprobe_task.do?sys_id=-1',
        },
        {
            $id: Now.ID['full-leading'],
            name: 'Leading',
            answer: 'Ask a follow-up',
            type: 'leadingQuestion',
            nextQuestion: follow,
            roles: ['itil', wizardUser, 'itil'],
            order: 200,
            active: false,
        },
        {
            $id: Now.ID['full-button'],
            type: 'button',
            buttonLabel: 'Press <me>',
            script: Now.include('./scripts/answer.js'),
            order: 300,
        },
        {
            $id: Now.ID['full-external'],
            answer: 'Pick a subcategory',
            type: 'externalChoice',
            table: 'incident',
            element: 'subcategory',
            dependentValue: 'network',
            script: "gs.info('external & <chosen>');",
            order: 400,
        },
        {
            $id: Now.ID['full-yes-no'],
            answer: 'Confirm?',
            type: 'yesNo',
            payloadName: 'confirm',
            order: 500,
        },
        {
            $id: Now.ID['full-free'],
            answer: 'Describe it',
            type: 'freeformText',
            order: 600,
        },
        {
            $id: Now.ID['full-multi'],
            answer: 'Choose one',
            type: 'multipleChoice',
            order: 700,
        },
        {
            $id: Now.ID['full-custom'],
            answer: 'Custom code',
            type: '7',
            nextQuestion: recordWizard,
            roles: [],
            order: 800,
        },
    ],
})

export const demo = Interceptor({
    name: 'Demo wizard',
    backPanel: recordWizard,
    nextPanel: Now.ref('sys_wizard', 'fedcba9876543210fedcba9876543210'),
    answers: [
        {
            $id: Now.ID['demo-guid'],
            answer: 'By sys_id',
            type: 'leadingQuestion',
            nextQuestion: 'aaaabbbbccccddddeeeeffff00001111',
            order: 50,
        },
    ],
})

export const keyed = Interceptor({
    name: 'Keyed refs',
    protectionPolicy: 'protected',
    backPanel: Now.ref('sys_wizard', { name: 'Minimal' }),
    nextPanel: Now.ref('sys_wizard', '11112222333344445555666677778888', { name: 'Elsewhere' }),
})
