import type { Command } from 'commander'
import kleur from 'kleur'
import { buildClient } from '@/client'
import { emit, jsonOption } from '@/output'
import { formatTable, type TableCell } from '@/table'

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
            const rows = runtimes.map((rt): TableCell[] => [
                rt.id,
                [rt.name, kleur.cyan],
                [rt.framework, kleur.yellow],
                rt.kind,
                rt.status,
                String(rt.agentsCount)
            ])
            for (const line of formatTable(
                ['ID', 'NAME', 'FRAMEWORK', 'KIND', 'STATUS', 'AGENTS'],
                rows
            ))
                console.log(line)
        })
    })
}
