import type { Command } from 'commander'
import kleur from 'kleur'
import { buildClient } from '@/client'
import { emit, jsonOption } from '@/output'

export const registerRuntimeList = (cmd: Command, program: Command): void => {
    jsonOption(
        cmd
            .command('list')
            .alias('ls')
            .description('List your agent runtimes')
    ).action(async (opts: { json?: boolean }) => {
        const global = program.opts<{ apiUrl?: string; token?: string }>()
        const { client } = await buildClient(global)
        const runtimes = await client.agentRuntimes.list()
        emit(opts, runtimes, () => {
            if (runtimes.length === 0) {
                console.log(kleur.dim('(no agent runtimes)'))
                return
            }
            for (const rt of runtimes) {
                console.log(
                    `${rt.id}  ${kleur.cyan(rt.name)}  ${kleur.yellow(rt.framework)}/${rt.kind}  ${rt.status}  ${kleur.dim(`agents=${rt.agentsCount}`)}`
                )
            }
        })
    })
}
