import type { Command } from 'commander'
import type { AgentFramework, UsageBucket } from '@manyfold/shared'
import { resolveOptionalAgentId } from '@/agent-context'
import { buildClient } from '@/client'

interface RootOpts {
    apiUrl?: string
    token?: string
}

interface CommonOpts {
    from?: string
    to?: string
    framework?: string
    runtimeId?: string
    agentId?: string
    sessionId?: string
    json?: boolean
}

interface TimeseriesOpts extends CommonOpts {
    bucket?: string
}

interface EventsOpts extends CommonOpts {
    cursor?: string
    limit?: string
}

interface TopAgentsOpts {
    from?: string
    to?: string
    limit?: string
    json?: boolean
}

const buildQuery = (opts: CommonOpts, program: Command) => {
    const q: Record<string, string | undefined> = {}
    const agentId = resolveOptionalAgentId(opts.agentId, program)
    if (opts.from) q.from = opts.from
    if (opts.to) q.to = opts.to
    if (opts.framework) q.framework = opts.framework
    if (opts.runtimeId) q.runtimeId = opts.runtimeId
    if (agentId) q.agentId = agentId
    if (opts.sessionId) q.sessionId = opts.sessionId
    return q as {
        from?: string
        to?: string
        framework?: AgentFramework
        runtimeId?: string
        agentId?: string
        sessionId?: string
    }
}

const commonFilterOptions = (cmd: Command): Command =>
    cmd
        .option('--from <iso>', 'inclusive start (ISO8601)')
        .option('--to <iso>', 'exclusive end (ISO8601)')
        .option('--framework <name>', 'filter by framework')
        .option('--runtime-id <id>', 'filter by runtime')
        .option('--agent-id <id>', 'filter by agent')
        .option('--session-id <id>', 'filter by chat session')
        .option('--json', 'emit raw JSON (default)', true)

export const registerUsage = (program: Command): void => {
    const cmd = program
        .command('usage')
        .description('Read token + cost usage statistics')

    commonFilterOptions(
        cmd.command('summary').description('Aggregate usage in a window')
    ).action(async (opts: CommonOpts) => {
        const global = program.opts<RootOpts>()
        const { client } = await buildClient(global)
        const res = await client.usage.summary(buildQuery(opts, program))
        console.log(JSON.stringify(res, null, 2))
    })

    commonFilterOptions(
        cmd.command('timeseries').description('Bucketed usage time series')
    )
        .option('--bucket <bucket>', 'hour | day (default: day)')
        .action(async (opts: TimeseriesOpts) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const bucket =
                opts.bucket === 'hour' || opts.bucket === 'day'
                    ? (opts.bucket as UsageBucket)
                    : undefined
            const res = await client.usage.timeseries({
                ...buildQuery(opts, program),
                bucket
            })
            console.log(JSON.stringify(res, null, 2))
        })

    commonFilterOptions(
        cmd.command('events').description('Paginated usage events')
    )
        .option('--cursor <cursor>', 'opaque cursor from previous page')
        .option('--limit <n>', 'page size (1-200, default 50)')
        .action(async (opts: EventsOpts) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const limit = opts.limit ? Number(opts.limit) : undefined
            const res = await client.usage.events({
                ...buildQuery(opts, program),
                cursor: opts.cursor,
                limit
            })
            console.log(JSON.stringify(res, null, 2))
        })

    commonFilterOptions(
        cmd.command('sessions').description('Per-session usage summaries')
    ).action(async (opts: CommonOpts) => {
        const global = program.opts<RootOpts>()
        const { client } = await buildClient(global)
        const res = await client.usage.sessions(buildQuery(opts, program))
        console.log(JSON.stringify(res, null, 2))
    })

    cmd.command('top-agents')
        .description('Rank agents by usage (cross-agent — denied for bound tokens)')
        .option('--from <iso>', 'inclusive start')
        .option('--to <iso>', 'exclusive end')
        .option('--limit <n>', 'top N (default 10)')
        .option('--json', 'emit raw JSON (default)', true)
        .action(async (opts: TopAgentsOpts) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const limit = opts.limit ? Number(opts.limit) : undefined
            const res = await client.usage.topAgents({
                from: opts.from,
                to: opts.to,
                limit
            })
            console.log(JSON.stringify(res, null, 2))
        })
}
