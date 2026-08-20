import type { Command } from 'commander'
import kleur from 'kleur'
import type { AgentRuntimeSummary } from '@manyfold/shared'
import type { NcaClient } from '@manyfold/sdk'
import { buildClient } from '@/client'

interface JsonOption {
    json?: boolean
}

const POLL_INTERVAL_MS = 5_000
const POLL_TIMEOUT_MS = 15 * 60_000

const statePending = (state: string | null): boolean =>
    !!state && !state.startsWith('error:')

// Sprite hermes toggles run async server-side: the PATCH returns while
// dashboard_state is 'enabling@…'/'disabling@…' and the flag flips only when
// the orchestration lands. Poll until it settles so "✓ enabled" isn't a lie.
const awaitSettled = async (
    client: NcaClient,
    runtimeId: string,
    initial: AgentRuntimeSummary
): Promise<AgentRuntimeSummary> => {
    let current = initial
    const deadline = Date.now() + POLL_TIMEOUT_MS
    while (statePending(current.dashboardState) && Date.now() < deadline) {
        process.stderr.write(
            kleur.dim(
                `… ${current.dashboardState?.split('@')[0] ?? 'working'} (first enable builds the web UI)\n`
            )
        )
        await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS))
        current = await client.agentRuntimes.get(runtimeId)
    }
    return current
}

const report = (
    runtimeId: string,
    enabled: boolean,
    settled: AgentRuntimeSummary,
    opts: JsonOption
): void => {
    if (opts.json) {
        console.log(JSON.stringify(settled, null, 2))
        return
    }
    const errorState = settled.dashboardState?.startsWith('error:')
        ? settled.dashboardState.slice('error:'.length)
        : null
    if (errorState) {
        console.error(
            kleur.red(`✗ dashboard toggle failed on ${runtimeId}: ${errorState}`)
        )
        process.exitCode = 1
        return
    }
    if (statePending(settled.dashboardState)) {
        console.log(
            kleur.yellow(
                `… dashboard toggle still in progress on ${runtimeId} — check later with \`mf runtime get ${runtimeId}\``
            )
        )
        return
    }
    if (enabled)
        console.log(kleur.green(`✓ enabled dashboard on ${runtimeId}`))
    else console.log(kleur.dim(`✓ disabled dashboard on ${runtimeId}`))
}

export const registerRuntimeDashboard = (
    cmd: Command,
    program: Command
): void => {
    const dash = cmd
        .command('dashboard')
        .description('Manage the runtime dashboard (Hermes only)')

    dash.command('enable <runtimeId>')
        .description('Enable the Hermes dashboard')
        .option('--json', 'emit raw JSON', false)
        .action(async (runtimeId: string, opts: JsonOption) => {
            const global = program.opts<{ apiUrl?: string; token?: string }>()
            const { client } = await buildClient(global)
            const res = await client.agentRuntimes.setDashboard(runtimeId, true)
            const settled = await awaitSettled(client, runtimeId, res)
            report(runtimeId, true, settled, opts)
        })

    dash.command('disable <runtimeId>')
        .description('Disable the Hermes dashboard')
        .option('--json', 'emit raw JSON', false)
        .action(async (runtimeId: string, opts: JsonOption) => {
            const global = program.opts<{ apiUrl?: string; token?: string }>()
            const { client } = await buildClient(global)
            const res = await client.agentRuntimes.setDashboard(
                runtimeId,
                false
            )
            const settled = await awaitSettled(client, runtimeId, res)
            report(runtimeId, false, settled, opts)
        })
}
