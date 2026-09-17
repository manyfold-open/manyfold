import type { Command } from 'commander'
import type { SandboxUsageBreakdown } from '@manyfold/shared'
import { buildClient } from '@/client'
import { resolveOptionalAgentId } from '@/agent-context'
import { emit, jsonOption } from '@/output'
import { assertSandboxStorageContract } from '@/storage-contract'

const bytesLabel = (bytes: number | null): string => {
    if (bytes === null) return 'unknown'
    if (bytes >= 1_000_000_000)
        return `${(bytes / 1_000_000_000).toFixed(2)} GB`
    if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(2)} MB`
    if (bytes >= 1000) return `${(bytes / 1000).toFixed(2)} KB`
    return `${bytes} B`
}

export const formatSandboxStorage = (report: SandboxUsageBreakdown): string => {
    const lines = [
        `Scope: ${report.scope === 'account' ? 'whole account' : 'current sandbox'}`,
        `Storage: ${bytesLabel(report.storageBytesTotal)} (${report.storageFreshness.state})`,
        `Measured: ${report.storageFreshness.oldestMeasuredAt ?? 'unknown'}`
    ]
    for (const host of report.hosts) {
        lines.push(
            '',
            `${host.name} (${host.hostId})  ${bytesLabel(host.storageBytes)}  ${host.asleep ? 'asleep / ' : ''}${host.storageFreshness}`
        )
        lines.push(`  Measured: ${host.storageMeasuredAt ?? 'unknown'}`)
        for (const runtime of host.runtimes)
            lines.push(
                `  Runtime: ${runtime.name} (${runtime.runtimeId})  ${runtime.framework}`
            )
        for (const agent of host.agents)
            lines.push(
                `  Workspace: ${agent.name} (${agent.agentId})  ${bytesLabel(agent.workspaceBytes)} measured / ${bytesLabel(agent.attributedBytes)} attributed`
            )
        for (const home of host.homes)
            lines.push(
                `  Config/state: ${home.framework} ${home.path ?? ''}  ${bytesLabel(home.measuredBytes)} measured / ${bytesLabel(home.bytes)} attributed`
            )
    }
    return lines.join('\n')
}

export const registerSandbox = (program: Command): void => {
    const group = program
        .command('sandbox')
        .description('Inspect sandbox storage')
    jsonOption(
        group
            .command('storage-usage')
            .description(
                'Report cached current-sandbox storage; --account reports the whole account'
            )
    ).action(async (options: { json?: boolean }) => {
        const global = program.opts<{
            apiUrl?: string
            token?: string
            account?: boolean
        }>()
        const { client } = await buildClient(global)
        let agentId: string | undefined
        if (!global.account) {
            agentId = resolveOptionalAgentId(undefined, program)
            if (!agentId) {
                const identity = await client.auth.whoami()
                if (
                    identity.kind === 'agent-runtime' ||
                    identity.kind === 'legacy-runtime'
                )
                    agentId = identity.agentId
            }
            if (!agentId)
                throw new Error(
                    'select --agent-id for the current sandbox or --account for whole-account storage'
                )
        }
        const report = await client.runtimeAccess.sandboxUsage(
            agentId ? { agentId } : undefined
        )
        assertSandboxStorageContract(
            report,
            global.account ? 'account' : 'sandbox'
        )
        emit(options, report, () => console.log(formatSandboxStorage(report)))
    })
}
