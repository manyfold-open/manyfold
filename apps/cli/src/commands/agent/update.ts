import type { Command } from 'commander'
import kleur from 'kleur'
import {
    isModelConfigFramework,
    type AgentSummary,
    type UpdateAgentBody
} from '@manyfold/shared'
import type { NcaClient } from '@manyfold/sdk'
import { buildClient } from '@/client'
import {
    modelOptionsFromView,
    providerModelOf,
    resolveAgentModel,
    type ModelOption
} from '@/model-options'
import { UsageError } from '@/usage-error'

interface UpdateOptions {
    name?: string
    model?: string
    clearModel?: boolean
    json?: boolean
}

export const registerAgentUpdate = (cmd: Command, program: Command): void => {
    const update = cmd
        .command('update <agentId>')
        .description('Update agent name or model')
        .option('--name <name>', 'rename the agent')
        .option(
            '--model <model>',
            'the model to run: an alias such as sonnet, an id, or a name such as "Sonnet 5"'
        )
        .option('--clear-model', 'clear the model override', false)
        .option('--json', 'emit raw JSON', false)
    update.action(async (agentId: string, opts: UpdateOptions) => {
        try {
            await runUpdate(program, agentId, opts)
        } catch (err) {
            if (err instanceof UsageError) update.error(`error: ${err.message}`)
            throw err
        }
    })
}

const runUpdate = async (
    program: Command,
    agentId: string,
    opts: UpdateOptions
): Promise<void> => {
    const global = program.opts<{ apiUrl?: string; token?: string }>()
    const { client } = await buildClient(global)
    const model = opts.clearModel ? null : opts.model
    if (opts.name === undefined && model === undefined)
        throw new Error(
            'nothing to update: pass --name, --model, or --clear-model'
        )
    // Claude Code, Codex and the other model-config frameworks keep their
    // model in the agent's model settings, which the agent update refuses to
    // touch: the model goes there, as `mf model-config update` sends it.
    const inSettings =
        model !== undefined &&
        isModelConfigFramework((await client.agents.get(agentId)).framework)
    let agent: AgentSummary
    let options: ModelOption[] | null = null
    if (inSettings) {
        const view = await client.agents.getModelConfig(agentId)
        const next = await client.agents.updateModelConfig(agentId, {
            model: model === null ? null : resolveAgentModel(view, model)
        })
        options = modelOptionsFromView(next)
        agent = await renameOrGet(client, agentId, opts.name)
    } else {
        const body: UpdateAgentBody = {}
        if (opts.name !== undefined) body.name = opts.name
        if (model !== undefined) body.model = model
        agent = await client.agents.update(agentId, body)
    }
    if (opts.json) {
        console.log(JSON.stringify(agent, null, 2))
        return
    }
    console.log(
        `${agent.id}  ${kleur.cyan(agent.name)}  ${kleur.yellow(agent.framework)}/${agent.runtime}  ${agent.status}`
    )
    if (model === undefined) return
    const providerModel = providerModelOf(options, agent.model)
    console.log(
        `  model  ${
            agent.model
                ? `${agent.model}${providerModel && providerModel !== agent.model ? ` (${providerModel})` : ''}`
                : kleur.dim(`${agent.framework}'s default`)
        }`
    )
    // Each of these frameworks' turns names its model, so open sessions
    // switch too; a hermes session keeps the one it started with.
    if (inSettings)
        console.error(
            kleur.dim(
                'Every session runs it from its next turn, including sessions already open.'
            )
        )
}

// The name changes after the model, whose checks are the likelier to fail.
const renameOrGet = (
    client: NcaClient,
    agentId: string,
    name: string | undefined
): Promise<AgentSummary> =>
    name === undefined
        ? client.agents.get(agentId)
        : client.agents.update(agentId, { name })
