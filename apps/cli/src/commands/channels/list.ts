import type { Command } from 'commander'
import kleur from 'kleur'
import { resolveOptionalAgentId } from '@/agent-context'
import { buildClient } from '@/client'
import { formatTable, type TableCell } from '@/table'
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
            const rows = filtered.map((c): TableCell[] => [
                c.id,
                [c.label, kleur.cyan],
                [c.provider, kleur.yellow],
                c.status,
                [c.agentId, kleur.dim]
            ])
            for (const line of formatTable(
                ['ID', 'LABEL', 'PROVIDER', 'STATUS', 'AGENT'],
                rows
            ))
                console.log(line)
        })
}
