import '@servicenow/sdk/global'
import { AiAgent } from '@servicenow/sdk/core'

export const minimal = AiAgent({
  $id: Now.ID['minimal_agent'],
  name: 'Minimal Agent',
  description: 'Minimal',
  agentRole: 'Assistant',
  securityAcl: { $id: Now.ID['minimal_acl'], type: 'Any authenticated user' },
  runAsUser: '82ef6be43bc7a2103542c11f23e45a61',
})

export const full = AiAgent({
  $id: Now.ID['full_agent'],
  name: 'Full Agent',
  description: 'Full agent',
  agentRole: 'Specialist',
  recordType: 'custom',
  channel: 'nap',
  processingMessage: 'Working...',
  postProcessingMessage: 'Done',
  active: false,
  advancedMode: true,
  agentDescriptor: 'created_by_build_agent',
  agentLearning: true,
  docUrl: 'https://example.com/doc',
  iconUrl: 'https://example.com/icon.png',
  public: true,
  memoryCategories: ['projects', 'workplace'],
  contextProcessingScript: 'function process(context) { return context; }',
  versionDetails: [
    { name: 'V1', number: 1, state: 'published', instructions: 'Do things.' },
    { name: 'V2', number: 2, instructions: 'Draft.', condition: 'active=true' },
  ],
  securityAcl: {
    $id: Now.ID['full_acl'],
    type: 'Specific role',
    roles: ['282bf1fac6112285017366cb5f867469', 'b05926fa0a0a0aa7000130023e0bde98'],
  },
  dataAccess: { roleMap: ['itil', 'admin'], description: 'Role access' },
  tools: [
    { name: 'Web Search', description: 'Searches', type: 'web_automation', executionMode: 'autopilot', maxAutoExecutions: 5, displayOutput: true, outputTransformationStrategy: 'paraphrase', preMessage: 'Searching', postMessage: 'Searched' },
    { name: 'Run Script', description: 'Runs', type: 'script', script: 'function run(inputs) { return inputs.content; }', inputs: [{ name: 'content', description: 'Content', mandatory: true, value: '', invalidMessage: null }] },
  ],
  triggerConfig: [
    { name: 'Create Trigger', channel: 'nap', objectiveTemplate: 'Handle ${number}', targetTable: 'incident', triggerFlowDefinitionType: 'record_create', triggerCondition: 'active=true', showNotifications: true },
    { name: 'Daily Trigger', channel: 'nap_and_va', objectiveTemplate: 'Daily', targetTable: 'incident', triggerFlowDefinitionType: 'daily', triggerCondition: 'active=true', schedule: { time: '1970-01-01 08:00:00', triggerStrategy: 'every' } },
  ],
})

export const pub = AiAgent({
  $id: Now.ID['public_agent'],
  name: 'Public Agent',
  description: 'Public',
  agentRole: 'Greeter',
  agentType: 'external',
  securityAcl: { $id: Now.ID['public_acl'], type: 'Public' },
  dataAccess: { roleList: ['282bf1fac6112285017366cb5f867469'] },
  $override: { sys_class_name: 'sn_aia_agent' },
})
