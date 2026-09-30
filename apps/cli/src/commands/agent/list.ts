import type { Command } from 'commander'
import kleur from 'kleur'
import { buildClient } from '@/client'
import { emit, jsonOption } from '@/output'
import { formatTable, type TableCell } from '@/table'
import { assertAgentStorageContract } from '@/storage-contract'

export const registerAgentList = (cmd: Command, program: Command): void => {
    jsonOption(
        cmd
            .command('list')
            .alias('ls')
            .description('List visible agents: runtime identity defaults to self; --account requires consent')
    ).action(async (opts: { json?: boolean }) => {
        const global = program.opts<{ apiUrl?: string; token?: string; account?: boolean }>()
        const { client } = await buildClient(global)
        const identity = await client.auth.whoami()
        const agents = await client.agents.list()
        for (const agent of agents) assertAgentStorageContract(agent)
        const scope = identity.kind === 'legacy-runtime' || (identity.kind === 'agent-runtime' && !global.account) ? 'agent' : 'account'
        emit(opts, { scope, agents }, () => {
            console.log(`Scope: ${scope === 'account' ? 'whole account' : 'current agent'}`)
            if (agents.length === 0) {
                console.log(kleur.dim('No agents yet.'))
                return
            }
            const rows = agents.map((a): TableCell[] => [
                a.id,
                [a.name, kleur.cyan],
                [a.framework, kleur.yellow],
                a.runtime,
                a.status
            ])
            for (const line of formatTable(
                ['ID', 'NAME', 'FRAMEWORK', 'RUNTIME', 'STATUS'],
                rows
            ))
                console.log(line)
        })
    })
}
