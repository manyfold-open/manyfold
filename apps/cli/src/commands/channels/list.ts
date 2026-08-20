import type { Command } from 'commander'
import kleur from 'kleur'
import { resolveOptionalAgentId } from '@/agent-context'
import { buildClient } from '@/client'
import { maskSensitive, type RootChannelOptions } from './helpers'

interface ListOptions {
    agentId?: string
    json?: boolean
}

export const registerChannelsList = (
    cmd: Command,
    program: Command
): void => {
    cmd.command('list')
        .alias('ls')
        .description('List channels (optionally filter by agent)')
        .option(
            '--agent-id <id>',
            'filter to channels owned by this agent (client-side filter)'
        )
        .option('--json', 'emit raw JSON array', false)
        .action(async (opts: ListOptions) => {
            const root = program.opts<RootChannelOptions>()
            const { client } = await buildClient(root)
            const channels = await client.channels.list()
            const filterId = resolveOptionalAgentId(opts.agentId, program)
            const filtered = filterId
                ? channels.filter((c) => c.agentId === filterId)
                : channels
            if (opts.json) {
                console.log(
                    JSON.stringify(
                        filtered.map((c) => maskSensitive(c)),
                        null,
                        2
                    )
                )
                return
            }
            if (filtered.length === 0) {
                console.log(kleur.dim('No channels.'))
                return
            }
            for (const c of filtered) {
                console.log(
                    `${c.id}  ${kleur.cyan(c.label)}  ${kleur.yellow(c.provider)}  ${c.status}  ${kleur.dim(c.agentId)}`
                )
            }
        })
}
