import type { Command } from 'commander'
import kleur from 'kleur'
import type { UpdateAgentBody } from '@manyfold/shared'
import { buildClient } from '@/client'

interface UpdateOptions {
    name?: string
    model?: string
    clearModel?: boolean
    json?: boolean
}

export const registerAgentUpdate = (cmd: Command, program: Command): void => {
    cmd.command('update <agentId>')
        .description('Update agent name or model')
        .option('--name <name>', 'rename the agent')
        .option('--model <model>', 'set model id')
        .option('--clear-model', 'clear the model override', false)
        .option('--json', 'emit raw JSON', false)
        .action(async (agentId: string, opts: UpdateOptions) => {
            const global = program.opts<{ apiUrl?: string; token?: string }>()
            const { client } = await buildClient(global)
            const body: UpdateAgentBody = {}
            if (opts.name !== undefined) body.name = opts.name
            if (opts.clearModel) body.model = null
            else if (opts.model !== undefined) body.model = opts.model
            if (Object.keys(body).length === 0)
                throw new Error(
                    'nothing to update: pass --name, --model, or --clear-model'
                )
            const agent = await client.agents.update(agentId, body)
            if (opts.json) {
                console.log(JSON.stringify(agent, null, 2))
                return
            }
            console.log(
                `${agent.id}  ${kleur.cyan(agent.name)}  ${kleur.yellow(agent.framework)}/${agent.runtime}  ${agent.status}`
            )
        })
}
