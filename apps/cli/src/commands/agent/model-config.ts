import type { Command } from 'commander'
import kleur from 'kleur'
import type {
    AgentModelConfig,
    AgentModelConfigSource,
    UpdateAgentModelConfigBody
} from '@manyfold/shared'
import { buildClient } from '@/client'
import { parseJsonArg } from '@/commands/channels/helpers'

interface UpdateOptions {
    source?: string
    model?: string
    clearModel?: boolean
    config?: string
    clearConfig?: boolean
    json?: boolean
}

interface RefreshOptions {
    source?: string
    json?: boolean
}

interface JsonOptions {
    json?: boolean
}

export const registerAgentModelConfig = (
    cmd: Command,
    program: Command
): void => {
    const mc = cmd
        .command('model-config')
        .description('Manage agent model config')
    addModelConfigCommands(mc, program)
}

export const addModelConfigCommands = (
    mc: Command,
    program: Command
): void => {
    mc.command('get <agentId>')
        .description('Get the agent model config view')
        .option('--json', 'emit raw JSON (default)', true)
        .action(async (agentId: string, _opts: JsonOptions) => {
            const global = program.opts<{ apiUrl?: string; token?: string }>()
            const { client } = await buildClient(global)
            const view = await client.agents.getModelConfig(agentId)
            console.log(JSON.stringify(view, null, 2))
        })

    mc.command('update <agentId>')
        .description('Update agent model config')
        .option(
            '--source <source>',
            'modelConfigSource value (platform|runtime-local)'
        )
        .option('--model <model>', 'set model id')
        .option('--clear-model', 'clear model', false)
        .option(
            '--config <json>',
            'modelConfig JSON object (or @file)',
            undefined
        )
        .option('--clear-config', 'clear modelConfig override', false)
        .option('--json', 'emit raw JSON', false)
        .action(async (agentId: string, opts: UpdateOptions) => {
            const global = program.opts<{ apiUrl?: string; token?: string }>()
            const { client } = await buildClient(global)
            const body: UpdateAgentModelConfigBody = {}
            if (opts.source)
                body.modelConfigSource = opts.source as AgentModelConfigSource
            if (opts.clearModel) body.model = null
            else if (opts.model !== undefined) body.model = opts.model
            if (opts.clearConfig) body.modelConfig = null
            else if (opts.config !== undefined) {
                body.modelConfig = (await parseJsonArg(
                    opts.config,
                    '--config'
                )) as unknown as AgentModelConfig
            }
            if (Object.keys(body).length === 0)
                throw new Error(
                    'nothing to update: pass --source / --model / --clear-model / --config / --clear-config'
                )
            const view = await client.agents.updateModelConfig(agentId, body)
            if (opts.json) {
                console.log(JSON.stringify(view, null, 2))
                return
            }
            console.log(
                `${kleur.cyan(agentId)} source=${view.source} ${kleur.dim(JSON.stringify(view.config ?? null))}`
            )
        })

    mc.command('refresh-models <agentId>')
        .description('Refresh the provider model list for an agent')
        .option(
            '--source <source>',
            'modelConfigSource value to refresh (optional)'
        )
        .option('--json', 'emit raw JSON', false)
        .action(async (agentId: string, opts: RefreshOptions) => {
            const global = program.opts<{ apiUrl?: string; token?: string }>()
            const { client } = await buildClient(global)
            const res = await client.agents.refreshModelConfigModels(
                agentId,
                opts.source
                    ? { source: opts.source as AgentModelConfigSource }
                    : undefined
            )
            if (opts.json) {
                console.log(JSON.stringify(res, null, 2))
                return
            }
            const status = res.ok ? kleur.green('ok') : kleur.red('failed')
            console.log(
                `${status} models=${res.models.length} latency=${res.latencyMs ?? '-'}ms`
            )
            if (res.message) console.log(kleur.dim(`  ${res.message}`))
        })
}
