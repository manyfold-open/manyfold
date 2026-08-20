import type { Command } from 'commander'
import kleur from 'kleur'
import { buildClient } from '@/client'
import { emit } from '@/output'

export const registerRuntimeDelete = (cmd: Command, program: Command): void => {
    cmd.command('delete <id>')
        .alias('rm')
        .description(
            'Delete an agent runtime (tears down sprite/pod and cascades to agents)'
        )
        .option('--json', 'output the result as JSON', false)
        .action(async (id: string, opts: { json?: boolean }) => {
            const global = program.opts<{ apiUrl?: string; token?: string }>()
            const { client } = await buildClient(global)
            await client.agentRuntimes.delete(id)
            emit(opts, { ok: true, id }, () =>
                console.log(kleur.green(`✓ deleted ${id}`))
            )
        })
}
