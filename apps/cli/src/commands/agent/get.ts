import type { Command } from 'commander'
import kleur from 'kleur'
import { buildClient } from '@/client'

interface GetOptions {
    json?: boolean
}

export const registerAgentGet = (cmd: Command, program: Command): void => {
    cmd.command('get <agentId>')
        .description('Show a single agent')
        .option('--json', 'emit raw JSON', false)
        .action(async (agentId: string, opts: GetOptions) => {
            const global = program.opts<{ apiUrl?: string; token?: string }>()
            const { client } = await buildClient(global)
            const agent = await client.agents.get(agentId)
            if (opts.json) {
                console.log(JSON.stringify(agent, null, 2))
                return
            }
            console.log(
                `${agent.id}  ${kleur.cyan(agent.name)}  ${kleur.yellow(agent.framework)}/${agent.runtime}  ${agent.status}`
            )
            if (agent.model) console.log(kleur.dim(`  model: ${agent.model}`))
            if (agent.spriteName)
                console.log(kleur.dim(`  sprite: ${agent.spriteName}`))
        })
}
