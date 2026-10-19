import { EmailNotification, Record } from '@servicenow/sdk/core'

const user = Record({ $id: Now.ID['user'], table: 'sys_user', data: { user_name: 'probe.user' } })
const group = Record({ $id: Now.ID['group'], table: 'sys_user_group', data: { name: 'Probe Group' } })
const template = Record({ $id: Now.ID['tpl'], table: 'sysevent_email_template', data: { name: 'Probe Tpl' } })

EmailNotification({
    $id: Now.ID['minimal'],
    table: 'incident',
    triggerConditions: { onRecordInsert: true },
})

EmailNotification({
    $id: Now.ID['full'],
    name: 'Full notification',
    description: 'Every option',
    table: 'incident',
    category: 'b69d6f5c2b200200f2b6e4e3c8da1500',
    active: false,
    mandatory: true,
    notificationType: 'email',
    enableDynamicTranslation: true,
    triggerConditions: {
        generationType: 'event',
        eventName: 'incident.probe',
        weight: 5,
        order: 50,
        condition: 'active=true^priority=1',
        advancedCondition: 'answer = current.active;',
        itemTable: 'incident',
        affectedFieldOnEvent: 'parm1',
        item: 'event.parm2',
    },
    recipientDetails: {
        recipientUsers: [user, 'probe@example.com', '0c441abbc6112275000025157c651c89'],
        recipientFields: ['assigned_to', 'caller_id'],
        recipientGroups: [group, '477a05d153013010b846ddeeff7b1225'],
        excludeDelegates: true,
        isSubscribableByAllUsers: true,
        sendToCreator: true,
        eventParm1WithRecipient: true,
        eventParm2WithRecipient: false,
    },
    emailContent: {
        contentType: 'multipart/mixed',
        style: '9f3cdbd2c3132100b9c1a8bb8a40ddd0',
        subject: 'Incident ${number} <updated>',
        message: 'Legacy & message',
        messageHtml: '<p>Hello ${caller_id}</p>',
        messageText: 'Hello ${caller_id}',
        smsAlternate: 'SMS text',
        importance: 'high',
        includeAttachments: true,
        omitWatermark: true,
        from: 'noreply@example.com',
        replyTo: 'reply@example.com',
        pushMessageOnly: false,
        pushMessageList: ['a1b2c3d4e5f60718293a4b5c6d7e8f90'],
        forceDelivery: true,
    },
    digest: {
        allow: true,
        default: true,
        defaultInterval: '2b7da2e1c3021000ed0c9d5d1d4a1c5b',
        type: 'multiple',
        template: template,
        subject: 'Digest subject',
        html: '<p>Digest</p>',
        text: 'Digest text',
        separatorHtml: '<hr/>',
        separatorText: '----\n',
        from: 'digest@example.com',
        replyTo: 'digest-reply@example.com',
    },
})

EmailNotification({
    $id: Now.ID['templated'],
    name: 'Templated',
    table: 'incident',
    notificationType: 'vcalendar',
    triggerConditions: { generationType: 'triggered', order: 100, weight: 0 },
    emailContent: { template: template, contentType: 'text/plain' },
})
