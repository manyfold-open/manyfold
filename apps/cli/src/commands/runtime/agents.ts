import type { Command } from 'commander'
import kleur from 'kleur'
import type { AddRuntimeAgentBody } from '@manyfold/shared'
import { buildClient } from '@/client'
import { emit } from '@/output'

interface AddOptions {
    name: string
    workspace?: string
    model?: string
    cloneFrom?: string
    json?: boolean
}

interface ListOptions {
    json?: boolean
}

interface RemoveOptions {
    yes?: boolean
    json?: boolean
}

export const registerRuntimeAgents = (cmd: Command, program: Command): void => {
    const sub = cmd
        .command('agents')
        .description('Manage framework agents hosted on a runtime')

    sub.command('add <runtimeId>')
        .description('Add a framework agent to an existing runtime')
        .requiredOption('--name <name>', 'agent display name')
        .option('--workspace <path>', 'workspace path (coding agents only)')
        .option('--model <model>', 'model override')
        .option('--clone-from <agentId>', 'clone state from another agent')
        .option('--json', 'emit raw JSON', false)
        .action(async (runtimeId: string, opts: AddOptions) => {
            const global = program.opts<{ apiUrl?: string; token?: string }>()
            const { client } = await buildClient(global)
            const body: AddRuntimeAgentBody = { name: opts.name }
            if (opts.workspace) body.workspace = opts.workspace
            if (opts.model) body.model = opts.model
            if (opts.cloneFrom) body.cloneFrom = opts.cloneFrom
            const res = await client.agentRuntimes.addAgent(runtimeId, body)
            if (opts.json) {
                console.log(JSON.stringify(res, null, 2))
                return
            }
            console.log(
                `${res.id}  ${kleur.cyan(res.name)}  ${kleur.yellow(res.framework)}/${res.runtime}  ${res.status}`
            )
        })

    sub.command('list <runtimeId>')
        .alias('ls')
        .description('List framework agents on a runtime')
        .option('--json', 'emit raw JSON', false)
        .action(async (runtimeId: string, opts: ListOptions) => {
            const global = program.opts<{ apiUrl?: string; token?: string }>()
            const { client } = await buildClient(global)
            const list = await client.agentRuntimes.listAgents(runtimeId)
            if (opts.json) {
                console.log(JSON.stringify(list, null, 2))
                return
            }
            if (list.length === 0) {
                console.log(kleur.dim('(no framework agents)'))
                return
            }
            for (const a of list) {
                console.log(
                    `${a.id}  ${kleur.cyan(a.name)}  ${kleur.dim(a.model ?? '')}`
                )
            }
        })

    sub.command('remove <agentId>')
        .alias('rm')
        .description('Remove a framework agent (by agent id)')
        .option('-y, --yes', 'confirm removal', false)
        .option('--json', 'output the result as JSON', false)
        .action(async (agentId: string, opts: RemoveOptions) => {
            const global = program.opts<{ apiUrl?: string; token?: string }>()
            const { client } = await buildClient(global)
            if (!opts.yes)
                throw new Error(
                    `refusing to remove ${agentId} without --yes (or -y)`
                )
            await client.agentRuntimes.removeAgent(agentId)
            emit(opts, { ok: true, id: agentId }, () =>
                console.log(kleur.dim(`✓ removed ${agentId}`))
            )
        })
}
