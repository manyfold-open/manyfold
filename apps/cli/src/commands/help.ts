import type { Command } from 'commander'
import { agentHelpDocs } from '@/agent-help/docs'
import {
    buildAgentHelpEnvelope,
    renderAgentHelp,
    resolveAgentHelpTopic,
    suggestAgentHelpTopics
} from '@/agent-help/helpers'

const findCommand = (program: Command, words: string[]): Command => {
    let current = program
    for (const [i, word] of words.entries()) {
        const next = current.commands.find(
            (cmd) => cmd.name() === word || cmd.aliases().includes(word)
        )
        if (!next)
            throw new Error(
                `unknown command '${words.slice(0, i + 1).join(' ')}' for help. ` +
                    `Run 'mf help' to list commands.`
            )
        current = next
    }
    return current
}

export const registerHelp = (program: Command): void => {
    program.helpCommand(false)
    program
        .command('help [topic...]')
        .description(
            'display help for a command; --agent prints the agent operations guide'
        )
        .option(
            '--agent',
            'print agent-oriented guidance (auth, scopes, safety, recovery)',
            false
        )
        .option(
            '--json',
            'with --agent: emit a machine-readable JSON envelope',
            false
        )
        .action((words: string[], opts: { agent: boolean; json: boolean }) => {
            if (!opts.agent) {
                if (opts.json) throw new Error('--json requires --agent')
                findCommand(program, words).outputHelp()
                return
            }
            const topic = resolveAgentHelpTopic(words)
            if (!topic)
                throw new Error(
                    `unknown agent help topic '${words.join(' ')}'. ` +
                        `Did you mean: ${suggestAgentHelpTopics(words).join(', ')}? ` +
                        `Run 'mf help --agent' to list all topics.`
                )
            const content = renderAgentHelp(agentHelpDocs[topic])
            if (opts.json) {
                console.log(
                    JSON.stringify(buildAgentHelpEnvelope(topic, content), null, 2)
                )
                return
            }
            console.log(content)
        })
}
