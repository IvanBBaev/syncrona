import '@servicenow/sdk/global'
import { TestSuite } from '@servicenow/sdk/core'

export const minimal = TestSuite({
    $id: Now.ID['minimal-suite'],
    name: 'Minimal suite',
})

export const parentSuite = TestSuite({
    $id: Now.ID['parent-suite'],
    name: 'Full Regression',
    description: 'All regression tests',
    tests: ['0a1b2c3d4e5f40718293a4b5c6d7e8f9'],
})

export const full = TestSuite({
    $id: Now.ID['full-suite'],
    name: 'Smoke Suite <a & b>',
    active: false,
    description: 'Smoke tests',
    protectionPolicy: 'read',
    parent: parentSuite,
    tests: [
        { test: '4a1b2c3d4e5f40718293a4b5c6d7e8f9', abortOnFailure: true },
        '5a1b2c3d4e5f40718293a4b5c6d7e8f9',
        { test: '1a1b2c3d4e5f40718293a4b5c6d7e8f9', order: 10 },
        { test: '2a1b2c3d4e5f40718293a4b5c6d7e8f9' },
        { test: '3a1b2c3d4e5f40718293a4b5c6d7e8f9', abortOnFailure: false, order: 50 },
    ],
})

export const filtered = TestSuite({
    $id: Now.ID['filtered-suite'],
    name: 'Filtered',
    testFilter: 'nameSTARTSWITHsmoke',
    parent: 'b1b2c3d4e5f6407182930a4b5c6d7e8f',
    protectionPolicy: 'protected',
})
