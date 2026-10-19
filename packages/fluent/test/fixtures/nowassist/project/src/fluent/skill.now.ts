import { NowAssistSkillConfig } from '@servicenow/sdk/core'

NowAssistSkillConfig(
  {
    $id: Now.ID['my_skill'],
    name: 'Customer Support Helper',
    shortDescription: 'Helps with customer inquiries',
    description: 'AI-powered customer support assistant',
    inputs: [
      {
        $id: Now.ID['customer_inquiry_input'],
        name: 'customer inquiry',
        description: 'Customer question or issue',
        mandatory: true,
        dataType: 'string'
      }
    ],
    outputs: [
      {
        $id: Now.ID['customer_support_custom_response'],
        name: 'support response',
        description: 'Support response',
        dataType: 'string'
      }
    ],
    securityControls: {
      userAccess: { $id: Now.ID['customer_support_acl'], type: 'authenticated' },
      roleRestrictions: ['2831a114c611228501d4ea6c309d626d']
    }
  },
  {
    providers: [
      {
        provider: 'Now LLM Service',
        prompts: [
          {
            name: 'Support Prompt',
            versions: [
              {
                $id: Now.ID['support_prompt_v1'],
                version: 1,
                model: 'llm_generic_small',
                temperature: 0.3,
                prompt: 'You are a helpful customer support agent...',
                promptState: 'draft'
              }
            ]
          }
        ]
      }
    ]
  }
)
