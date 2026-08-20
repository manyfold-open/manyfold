import type { Command } from 'commander'
import kleur from 'kleur'
import { buildClient } from '@/client'
import { emit, jsonOption } from '@/output'

export const registerAgentList = (cmd: Command, program: Command): void => {
    jsonOption(
        cmd
            .command('list')
            .alias('ls')
            .description('List agents owned by the current user')
    ).action(async (opts: { json?: boolean }) => {
        const global = program.opts<{ apiUrl?: string; token?: string }>()
        const { client } = await buildClient(global)
        const agents = await client.agents.list()
        emit(opts, agents, () => {
            if (agents.length === 0) {
                console.log(kleur.dim('No agents yet.'))
                return
            }
            for (const a of agents) {
                console.log(
                    `${a.id}  ${kleur.cyan(a.name)}  ${kleur.yellow(a.framework)}/${a.runtime}  ${a.status}`
                )
            }
        })
    })
}
