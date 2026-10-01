import { Option, type Command } from 'commander'
import kleur from 'kleur'
import type { AgentFramework, UsageBucket } from '@manyfold/shared'
import {
    resolveExplicitAgentId,
    resolveOptionalAgentId
} from '@/agent-context'
import { buildClient } from '@/client'
import { refuseStrayWords } from '@/default-command'
import { instantOption, limitOption } from '@/option-parsers'
import { emit, jsonOption } from '@/output'
import {
    formatEvents,
    formatSessions,
    formatSummary,
    formatTimeseries,
    formatTopAgents
} from './render'

interface RootOpts {
    apiUrl?: string
    token?: string
    account?: boolean
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
    limit?: number
}

interface TopAgentsOpts {
    from?: string
    to?: string
    limit?: number
    json?: boolean
}

const buildQuery = (opts: CommonOpts, program: Command) => {
    const q: Record<string, string | undefined> = {}
    const agentId = program.opts<RootOpts>().account
        ? resolveExplicitAgentId(opts.agentId, program)
        : resolveOptionalAgentId(opts.agentId, program)
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
    jsonOption(
        cmd
            .option('--from <iso>', 'inclusive start (ISO8601)', instantOption)
            .option('--to <iso>', 'exclusive end (ISO8601)', instantOption)
            .option('--framework <name>', 'filter by framework')
            .option('--runtime-id <id>', 'filter by runtime')
            .option('--agent-id <id>', 'filter by agent')
            .option('--session-id <id>', 'filter by chat session')
    )

// A table on stdout, or a dim line on stderr when there is nothing to show.
const print = (lines: string[], empty: string): void => {
    if (lines.length === 0) console.error(kleur.dim(empty))
    for (const line of lines) console.log(line)
}

export const registerUsage = (program: Command): void => {
    const cmd = program
        .command('usage')
        .description('Read token + cost usage statistics')

    commonFilterOptions(
        cmd
            .command('summary', { isDefault: true })
            .description('Aggregate usage in a window')
    ).action(async (opts: CommonOpts, command: Command) => {
        refuseStrayWords(command)
        const global = program.opts<RootOpts>()
        const { client } = await buildClient(global)
        const res = await client.usage.summary(buildQuery(opts, program))
        emit(opts, res, () =>
            print(formatSummary(res), 'no usage in this window')
        )
    })

    commonFilterOptions(
        cmd.command('timeseries').description('Bucketed usage time series')
    )
        .addOption(
            new Option('--bucket <bucket>', 'bucket size (default: day)').choices(
                ['hour', 'day']
            )
        )
        .action(async (opts: TimeseriesOpts) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const bucket = (opts.bucket ?? 'day') as UsageBucket
            const res = await client.usage.timeseries({
                ...buildQuery(opts, program),
                bucket
            })
            emit(opts, res, () =>
                print(formatTimeseries(res, bucket), 'no usage in this window')
            )
        })

    commonFilterOptions(
        cmd.command('events').description('Paginated usage events')
    )
        .option('--cursor <cursor>', 'opaque cursor from previous page')
        .option('--limit <n>', 'page size (1-200, default 50)', limitOption(200))
        .action(async (opts: EventsOpts) => {
            const global = program.opts<RootOpts>()
            const { client } = await buildClient(global)
            const res = await client.usage.events({
                ...buildQuery(opts, program),
                cursor: opts.cursor,
                limit: opts.limit
            })
            emit(opts, res, () => {
                print(formatEvents(res), 'no usage events in this window')
                if (res.nextCursor)
                    console.error(
                        kleur.dim(
                            `(more — continue with --cursor ${res.nextCursor})`
                        )
                    )
            })
        })

    commonFilterOptions(
        cmd.command('sessions').description('Per-session usage summaries')
    ).action(async (opts: CommonOpts) => {
        const global = program.opts<RootOpts>()
        const { client } = await buildClient(global)
        const res = await client.usage.sessions(buildQuery(opts, program))
        emit(opts, res, () =>
            print(
                formatSessions(res, Date.now()),
                'no sessions with usage in this window'
            )
        )
    })

    jsonOption(
        cmd
            .command('top-agents')
            .description(
                'Rank agents by usage (cross-agent — denied for bound tokens)'
            )
            .option('--from <iso>', 'inclusive start (ISO8601)', instantOption)
            .option('--to <iso>', 'exclusive end (ISO8601)', instantOption)
            .option('--limit <n>', 'top N (1-100, default 10)', limitOption(100))
    ).action(async (opts: TopAgentsOpts) => {
        const global = program.opts<RootOpts>()
        const { client } = await buildClient(global)
        const res = await client.usage.topAgents({
            from: opts.from,
            to: opts.to,
            limit: opts.limit
        })
        emit(opts, res, () =>
            print(formatTopAgents(res), 'no agent usage in this window')
        )
    })
}
