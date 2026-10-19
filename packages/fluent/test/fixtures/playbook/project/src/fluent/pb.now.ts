import { PlaybookDefinition, PlaybookTriggerTypes, ActivityDefinitions, wfa } from '@servicenow/sdk/automation'

PlaybookDefinition(
    {
        $id: Now.ID['pb'],
        label: 'Simple Playbook',
        parentTable: 'incident',
        description: 'Handles P1 incidents',
        restartable: 'RESTARTABLE_TRUE',
    },
    {
        triggers: [
            wfa.playbook.trigger(
                PlaybookTriggerTypes.RecordUpdate,
                { $id: Now.ID['pb_trig'], label: 'On update' },
                { table: 'incident', condition: 'priority=1', runTriggerOnExtendedTables: true }
            ),
        ],
    },
    {
        lanes: () => {
            const main = wfa.playbook.lane({
                config: {
                    $id: Now.ID['lane_main'],
                    label: 'Main Lane',
                    order: 1,
                    startRule: wfa.playbook.run.Immediately(),
                    restartRule: 'RUN_ONLY_ONCE',
                },
                activities: () => {
                    const first = wfa.playbook.activity(ActivityDefinitions.Core.Instruction, {
                        $id: Now.ID['act_first'],
                        label: 'First',
                        order: 1,
                        startRule: wfa.playbook.run.Immediately(),
                        restartRule: 'RUN_ONLY_ONCE',
                    })
                    const second = wfa.playbook.activity(
                        ActivityDefinitions.Core.TwoStepInstruction,
                        {
                            $id: Now.ID['act_second'],
                            label: 'Review it',
                            name: 'review',
                            order: 2,
                            description: 'Second step',
                            startRule: wfa.playbook.run.After(first),
                            restartRule: 'RUN_ALWAYS',
                        },
                        { initial_message: 'Start now', completed_message: 'Done' },
                        { tagline: 'Custom tagline', icon: 'star' }
                    )
                    return { first: first, second: second }
                },
            })
            const follow = wfa.playbook.lane({
                config: {
                    $id: Now.ID['lane_follow'],
                    label: 'Follow up',
                    order: 2,
                    description: 'Later work',
                    startRule: wfa.playbook.run.After(main),
                    restartRule: 'RUN_ALWAYS',
                },
                activities: () => {
                    const note = wfa.playbook.activity(
                        ActivityDefinitions.Core.Instruction,
                        {
                            $id: Now.ID['act_note'],
                            label: 'First',
                            order: 1,
                            startRule: wfa.playbook.run.Immediately(),
                            restartRule: 'RUN_ONLY_ONCE',
                        },
                        { message: 'Hello', wait: 'no' }
                    )
                    return { note: note }
                },
            })
            return { main: main, follow: follow }
        },
    }
)
