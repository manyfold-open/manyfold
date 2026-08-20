import type { Command } from 'commander'
import kleur from 'kleur'
import { buildClient } from '@/client'

interface JsonOption {
    json?: boolean
}

export const registerRuntimeControlUi = (
    cmd: Command,
    program: Command
): void => {
    const ui = cmd
        .command('control-ui')
        .description('Manage the runtime control UI sidecar')

    ui.command('get-url <runtimeId>')
        .description('Get the control UI URL for a runtime')
        .option('--json', 'emit raw JSON', false)
        .action(async (runtimeId: string, opts: JsonOption) => {
            const global = program.opts<{ apiUrl?: string; token?: string }>()
            const { client } = await buildClient(global)
            const res = await client.agentRuntimes.getControlUiUrl(runtimeId)
            if (opts.json) {
                console.log(JSON.stringify(res, null, 2))
                return
            }
            if (!res.url) {
                console.log(kleur.dim('(no control UI url)'))
                return
            }
            console.log(res.url)
        })

    ui.command('enable <runtimeId>')
        .description('Enable the control UI sidecar')
        .option('--json', 'emit raw JSON', false)
        .action(async (runtimeId: string, opts: JsonOption) => {
            const global = program.opts<{ apiUrl?: string; token?: string }>()
            const { client } = await buildClient(global)
            const res = await client.agentRuntimes.setControlUi(runtimeId, true)
            if (opts.json) console.log(JSON.stringify(res, null, 2))
            else console.log(kleur.green(`✓ enabled control-ui on ${runtimeId}`))
        })

    ui.command('disable <runtimeId>')
        .description('Disable the control UI sidecar')
        .option('--json', 'emit raw JSON', false)
        .action(async (runtimeId: string, opts: JsonOption) => {
            const global = program.opts<{ apiUrl?: string; token?: string }>()
            const { client } = await buildClient(global)
            const res = await client.agentRuntimes.setControlUi(runtimeId, false)
            if (opts.json) console.log(JSON.stringify(res, null, 2))
            else
                console.log(
                    kleur.dim(`✓ disabled control-ui on ${runtimeId}`)
                )
        })
}
