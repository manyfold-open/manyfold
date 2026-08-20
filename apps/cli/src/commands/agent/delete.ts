import type { Command } from 'commander'
import kleur from 'kleur'
import { buildClient } from '@/client'
import { emit } from '@/output'

interface DeleteOptions {
    yes?: boolean
    json?: boolean
}

export const registerAgentDelete = (cmd: Command, program: Command): void => {
    cmd.command('delete <agentId>')
        .alias('rm')
        .description('Delete an agent (irreversible)')
        .option('-y, --yes', 'confirm irreversible deletion', false)
        .option('--json', 'output the result as JSON', false)
        .action(async (agentId: string, opts: DeleteOptions) => {
            const global = program.opts<{ apiUrl?: string; token?: string }>()
            const { client } = await buildClient(global)
            if (!opts.yes) {
                throw new Error(
                    `refusing to delete ${agentId} without --yes (or -y)`
                )
            }
            await client.agents.delete(agentId)
            emit(opts, { ok: true, id: agentId }, () =>
                console.log(kleur.dim(`✓ deleted ${agentId}`))
            )
        })
}
