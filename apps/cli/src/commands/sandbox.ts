import type { Command } from 'commander'
import kleur from 'kleur'
import type {
    AgentRuntimeSummary,
    SandboxSummary,
    SandboxUsageBreakdown
} from '@manyfold/shared'
import { ApiError } from '@manyfold/sdk'
import { buildClient } from '@/client'
import { resolveOptionalAgentId } from '@/agent-context'
import { emit, fail, jsonOption } from '@/output'
import { assertSandboxStorageContract } from '@/storage-contract'
import { resolveSandboxRef, UsageError } from '@/commands/agent/create-source'

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
            `${host.name} (${host.hostId})  ${bytesLabel(host.storageBytes)}  ${host.powerState ?? 'unknown'} / ${host.storageFreshness}`
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

// A sandbox with the framework instances on it: what `--sandbox` on
// `mf agent create` would join.
type SandboxRow = SandboxSummary & {
    runtimes: Array<Pick<AgentRuntimeSummary, 'id' | 'framework' | 'status'>>
}

const formatSandboxList = (
    rows: readonly SandboxRow[],
    quota: { used: number; limit: number; plan: string }
): string => {
    const lines =
        rows.length === 0
            ? [kleur.dim('No sandboxes yet.')]
            : rows.map((row) => {
                  const frameworks =
                      row.runtimes
                          .map((runtime) => runtime.framework)
                          .join(', ') || 'nothing installed'
                  const state = [row.status, row.powerState]
                      .filter(Boolean)
                      .join(', ')
                  const line = `${row.id}  ${kleur.cyan(row.name)}  ${state}  ${row.agentsCount} agent${row.agentsCount === 1 ? '' : 's'}  ${frameworks}  ${kleur.dim(`created ${row.createdAt.slice(0, 10)}`)}`
                  // Why a sandbox that never came up failed; mf sandbox
                  // delete clears it.
                  return row.status === 'failed' && row.failureReason
                      ? `${line}\n${kleur.red(`  ${row.failureReason}`)}`
                      : line
              })
    lines.push(
        kleur.dim(
            `${quota.used} of ${quota.limit} sandboxes in use (${quota.plan} plan)`
        )
    )
    return lines.join('\n')
}

export const registerSandbox = (program: Command): void => {
    const group = program
        .command('sandbox')
        .description('List, delete and inspect your sandboxes')
    jsonOption(
        group
            .command('list')
            .alias('ls')
            .description(
                'List your sandboxes, the frameworks on each, and how many your plan includes'
            )
    ).action(async (options: { json?: boolean }) => {
        const global = program.opts<{
            apiUrl?: string
            token?: string
            account?: boolean
        }>()
        const { client } = await buildClient(global)
        const [sandboxes, runtimes, access] = await Promise.all([
            client.sandboxes.list(),
            client.agentRuntimes.list(),
            client.runtimeAccess.summary()
        ])
        const rows: SandboxRow[] = sandboxes.map((sandbox) => ({
            ...sandbox,
            runtimes: runtimes
                .filter((runtime) => runtime.hostId === sandbox.id)
                .map(({ id, framework, status }) => ({ id, framework, status }))
        }))
        const quota = {
            used: access.statefulSandboxUsage,
            limit: access.statefulSandboxLimit,
            plan: access.plan.name
        }
        emit(options, { sandboxes: rows, quota }, () =>
            console.log(formatSandboxList(rows, quota))
        )
    })
    const remove = group
        .command('delete <sandbox>')
        .alias('rm')
        .description(
            'Delete a sandbox (id or name) and its files (irreversible); refused while agents are on it'
        )
        .option('-y, --yes', 'confirm irreversible deletion', false)
        .option('--json', 'output the result as JSON', false)
    remove.action(
        async (ref: string, opts: { yes?: boolean; json?: boolean }) => {
            const global = program.opts<{
                apiUrl?: string
                token?: string
                account?: boolean
            }>()
            const { client } = await buildClient(global)
            let sandbox: SandboxSummary
            try {
                sandbox = resolveSandboxRef(await client.sandboxes.list(), ref)
            } catch (err) {
                if (err instanceof UsageError)
                    remove.error(`error: ${err.message}`)
                throw err
            }
            if (!opts.yes)
                throw new Error(
                    `refusing to delete sandbox ${sandbox.name} (${sandbox.id}) without --yes (or -y)`
                )
            try {
                await client.sandboxes.delete(sandbox.id)
            } catch (err) {
                if (!(err instanceof ApiError) || err.code !== 'HOST_NOT_EMPTY')
                    throw err
                const agents = (await client.agents.list()).filter(
                    (agent) => agent.hostId === sandbox.id
                )
                fail(opts, err, {
                    hint:
                        agents.length > 0
                            ? `Delete its agents first: ${agents.map((agent) => `mf agent delete ${agent.id} --yes (${agent.name})`).join('; ')}`
                            : 'Delete its agents first; mf agent list shows them.'
                })
                return
            }
            emit(opts, { ok: true, id: sandbox.id }, () =>
                console.log(
                    kleur.dim(`✓ deleted ${sandbox.name} (${sandbox.id})`)
                )
            )
        }
    )
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
