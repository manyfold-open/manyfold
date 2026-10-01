import type { Command } from 'commander'
import kleur from 'kleur'
import {
    A2aClient,
    A2aTextAccumulator,
    fetchAgentCard,
    type A2aStreamEvent,
    type AgentCard,
    type Task
} from '@manyfold/a2a'
import type { A2aTaskTraceItem } from '@manyfold/shared'
import {
    artifactText,
    buildA2aMessage,
    createDeadline,
    isHttpUrl,
    looksLikeRpcEndpoint,
    partsToText,
    resolveBearer,
    resolveInterfaceUrl,
    resolveTimeoutSeconds,
    type BuildMessageOpts
} from '@/commands/a2a/helpers'
import {
    fetchSelfPeers,
    fetchSelfTasks,
    resolvePeerForCall,
    type GlobalAuthOpts
} from '@/commands/a2a/self'
import { registerA2aManagement } from '@/commands/a2a/management'
import { fail } from '@/output'
import { formatTable, type TableCell } from '@/table'

interface CommonOpts {
    bearer?: string
    json?: boolean
    allowHttpLocalhost?: boolean
    timeout?: string
}

interface SendOpts extends CommonOpts, BuildMessageOpts {
    stream?: boolean
    async?: boolean
}

interface TaskGetOpts extends CommonOpts {
    wait?: boolean
}

interface TasksListOpts {
    state?: string
    peer?: string
    json?: boolean
}

const POLL_INTERVAL_MS = 3000

// States in which a task is still producing; anything else ends a wait, a
// required-input prompt included.
const RUNNING_STATES = new Set(['submitted', 'working', 'unknown'])
const FAILED_STATES = new Set(['failed', 'canceled', 'rejected'])

const guardOf = (opts: CommonOpts) => ({
    allowPrivate: opts.allowHttpLocalhost === true
})

const clientFor = (resolved: ResolvedTarget, opts: CommonOpts): A2aClient =>
    new A2aClient({
        endpointUrl: resolved.endpointUrl,
        bearer: resolved.bearer,
        ...guardOf(opts)
    })

// Why a task ended without its work done, or null when it did not.
const failureReason = (task: Task): string | null => {
    if (!FAILED_STATES.has(task.status.state)) return null
    const said = task.status.message
        ? partsToText(task.status.message.parts)
        : ''
    return said || `task ${task.status.state}`
}

// A command that waited for a task fails when the task did.
const exitForState = (state: string | null): void => {
    if (state && FAILED_STATES.has(state)) process.exitCode = 1
}

const resolveEndpoint = async (
    url: string,
    bearer: string | undefined,
    guard: { allowPrivate: boolean },
    signal?: AbortSignal
): Promise<{ endpointUrl: string; card?: AgentCard }> => {
    if (looksLikeRpcEndpoint(url)) return { endpointUrl: url }
    const card = await fetchAgentCard(url, {
        bearer,
        supportedMajor: 0,
        signal,
        ...guard
    })
    return { endpointUrl: resolveInterfaceUrl(card, url), card }
}

interface ResolvedTarget {
    endpointUrl: string
    bearer?: string
    label: string
    // Peer tickets expire (~15min); set for peer targets so a long `--wait` can
    // re-mint before expiry. Undefined for raw url targets (static --bearer).
    expiresAt?: string
}

// A `<target>` is either a raw A2A url (http/https → use `--bearer`/$MF_A2A_BEARER)
// or a granted-peer name/id (→ resolved live via agent-self, bearer minted per
// call). Shared by `send` and the `tasks` subcommands so one mental model covers
// the whole group. Returns `{ error }` so callers print and exit without throwing.
const resolveTarget = async (
    program: Command,
    target: string,
    opts: CommonOpts,
    signal?: AbortSignal
): Promise<ResolvedTarget | { error: unknown }> => {
    if (isHttpUrl(target)) {
        const bearer = resolveBearer(opts.bearer)
        try {
            const { endpointUrl } = await resolveEndpoint(
                target,
                bearer,
                guardOf(opts),
                signal
            )
            return { endpointUrl, bearer, label: target }
        } catch (err) {
            return { error: err }
        }
    }
    const resolved = await resolvePeerForCall(
        program.opts<GlobalAuthOpts>(),
        target,
        signal
    )
    if ('error' in resolved) return resolved
    return {
        endpointUrl: resolved.rpcUrl,
        bearer: resolved.token,
        label: resolved.name,
        expiresAt: resolved.expiresAt
    }
}

const delay = (ms: number, signal: AbortSignal): Promise<void> =>
    new Promise((resolve, reject) => {
        if (signal.aborted) return reject(new Error('aborted'))
        const onAbort = (): void => {
            clearTimeout(timer)
            reject(new Error('aborted'))
        }
        // Remove the listener when the timer wins, so a long poll loop doesn't
        // accumulate abort listeners on the same deadline signal.
        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort)
            resolve()
        }, ms)
        signal.addEventListener('abort', onAbort, { once: true })
    })

const formatAge = (iso: string): string => {
    const ms = Date.now() - new Date(iso).getTime()
    if (!Number.isFinite(ms) || ms < 0) return ''
    const s = Math.floor(ms / 1000)
    if (s < 60) return `${s}s ago`
    const m = Math.floor(s / 60)
    if (m < 60) return `${m}m ago`
    const h = Math.floor(m / 60)
    if (h < 24) return `${h}h ago`
    return `${Math.floor(h / 24)}d ago`
}

const stateStyle = (state: string): ((text: string) => string) => {
    if (state === 'completed') return kleur.green
    if (state === 'failed' || state === 'rejected') return kleur.red
    if (state === 'canceled') return kleur.dim
    return kleur.yellow
}

const taskTable = (tasks: A2aTaskTraceItem[]): string[] =>
    formatTable(
        ['ID', 'PEER', 'STATE', 'CREATED'],
        tasks.map((task): TableCell[] => [
            task.id,
            task.targetAgentName ?? task.targetAgentId,
            [task.state, stateStyle(task.state)],
            [formatAge(task.createdAt), kleur.dim]
        ])
    )

interface StreamSummary {
    taskId: string | null
    state: string | null
    // A final status-update, a terminal task snapshot, or a direct message
    // answer. A stream that ends without one ended before its task did: a
    // Manyfold peer does that at its blocking cap and keeps the task running.
    final: boolean
    text: string
    reason: string | null
}

// Prints progress as it arrives and returns what the stream amounted to; the
// text itself is the caller's to print, since a stream that ended early is
// not the answer yet.
const renderStream = async (
    stream: AsyncIterable<A2aStreamEvent>,
    json: boolean
): Promise<StreamSummary> => {
    const output = new A2aTextAccumulator()
    const summary: StreamSummary = {
        taskId: null,
        state: null,
        final: false,
        text: '',
        reason: null
    }
    for await (const event of stream) {
        if (event.kind === 'message') summary.final = true
        else if (event.kind === 'artifact-update') summary.taskId = event.taskId
        else {
            summary.taskId = event.kind === 'task' ? event.id : event.taskId
            summary.state = event.status.state
            if (
                event.kind === 'task'
                    ? !RUNNING_STATES.has(event.status.state)
                    : event.final
            )
                summary.final = true
            if (FAILED_STATES.has(event.status.state))
                summary.reason =
                    (event.status.message
                        ? partsToText(event.status.message.parts)
                        : '') || `task ${event.status.state}`
        }
        if (json) {
            console.log(JSON.stringify(event))
            continue
        }
        output.apply(event)
        if (event.kind === 'status-update')
            console.error(
                kleur.dim(`[${event.status.state}]${event.final ? ' (final)' : ''}`)
            )
        else if (event.kind === 'task')
            console.error(kleur.dim(`task ${event.id} — ${event.status.state}`))
    }
    summary.text = output.text()
    return summary
}

// stdout may be a pipe: provisional text cannot be retracted there, so only a
// stream's final text is printed, once.
const printStreamed = (summary: StreamSummary, json: boolean): void => {
    if (json) return
    if (summary.text) console.log(summary.text)
    if (summary.reason) console.error(kleur.red(summary.reason))
}

const renderTask = (task: Task, json?: boolean): void => {
    if (json) {
        console.log(JSON.stringify(task, null, 2))
        return
    }
    const text = artifactText(task)
    if (text) console.log(text)
    const reason = failureReason(task)
    if (reason) console.error(kleur.red(reason))
    console.error(kleur.dim(`task ${task.id} — ${task.status.state}`))
}

const addCommonOptions = (cmd: Command): Command =>
    cmd
        .option(
            '--bearer <token>',
            'bearer token for a raw url target ("-" reads stdin; falls back to $MF_A2A_BEARER)'
        )
        .option('--json', 'emit raw A2A JSON instead of a human summary', false)
        .option(
            '--allow-http-localhost',
            'allow http:// and localhost/private targets (local dev only)',
            false
        )

const addMessageOptions = (cmd: Command): Command =>
    cmd
        .option('--context-id <id>', 'reuse an A2A context (conversation)')
        .option('--task-id <id>', 'continue an existing task')
        .option('--skill <id>', 'select a remote skill by id')
        .option(
            '--input-file <path>',
            'attach a file as an A2A file part (a Manyfold peer reads it in its workspace)'
        )

const addSendOptions = (cmd: Command): Command =>
    addMessageOptions(addCommonOptions(cmd))
        .option('--stream', 'stream status + artifact chunks (SSE)', false)
        .option(
            '--async',
            'submit and return a task id immediately (poll with `mf a2a tasks get`)',
            false
        )
        .option(
            '--timeout <seconds>',
            'client deadline in seconds (0 disables; default 900)'
        )

// One verb for both a granted peer and a raw URL. Default blocks for the
// final artifact; --stream follows SSE. --async returns the task id so a turn
// survives caller sprite sleep (fetch it later with `mf a2a tasks get`).
const runSend = async (
    program: Command,
    target: string,
    prompt: string,
    opts: SendOpts
): Promise<void> => {
    if (opts.stream && opts.async) {
        fail(opts, '--stream and --async cannot be combined')
        return
    }
    const seconds = resolveTimeoutSeconds(opts.timeout)
    const deadline = createDeadline(seconds)
    // The task being followed once the peer handed it over; a deadline that
    // passes after that leaves a running task, not a call with no response.
    let followingId: string | null = null
    let lastSeen: Task | null = null
    const announceFollow = (taskId: string): void => {
        if (!opts.json)
            console.error(
                kleur.dim(
                    `task ${taskId} is still running on the peer; following it`
                )
            )
    }
    try {
        const resolved = await resolveTarget(
            program,
            target,
            opts,
            deadline.signal
        )
        if (deadline.timedOut()) throw new Error('A2A deadline exceeded')
        if ('error' in resolved) {
            fail(opts, resolved.error)
            return
        }
        const client = clientFor(resolved, opts)
        const message = buildA2aMessage(prompt, opts)
        const follow = async (taskId: string): Promise<Task | null> => {
            followingId = taskId
            announceFollow(taskId)
            const task = await followTask(
                program,
                target,
                opts,
                resolved,
                taskId,
                deadline.signal,
                (last) => {
                    lastSeen = last
                }
            )
            if ('error' in task) {
                fail(opts, task.error)
                return null
            }
            return task
        }
        if (opts.stream) {
            const streamed = await renderStream(
                client.sendStreamingMessage(
                    {
                        message,
                        configuration: { acceptedOutputModes: ['text/plain'] }
                    },
                    deadline.signal
                ),
                opts.json === true
            )
            if (deadline.timedOut())
                throw new Error('A2A stream deadline exceeded')
            if (!streamed.final && streamed.taskId) {
                const task = await follow(streamed.taskId)
                if (!task) return
                // The polled task carries the whole answer; what streamed
                // before the peer let go of the stream is only a prefix.
                if (opts.json) console.log(JSON.stringify(task))
                else {
                    const text = artifactText(task)
                    if (text) console.log(text)
                    const reason = failureReason(task)
                    if (reason) console.error(kleur.red(reason))
                }
                exitForState(task.status.state)
                return
            }
            printStreamed(streamed, opts.json === true)
            exitForState(streamed.state)
            return
        }
        let result = await client.sendMessage(
            {
                message,
                configuration: {
                    blocking: opts.async !== true,
                    acceptedOutputModes: ['text/plain']
                }
            },
            deadline.signal
        )
        if (
            !opts.async &&
            result.kind === 'task' &&
            RUNNING_STATES.has(result.status.state)
        ) {
            lastSeen = result
            const task = await follow(result.id)
            if (!task) return
            result = task
        }
        if (opts.json) {
            console.log(JSON.stringify(result, null, 2))
            if (result.kind === 'task' && !opts.async)
                exitForState(result.status.state)
            return
        }
        if (result.kind !== 'task') {
            console.log(partsToText(result.parts))
            return
        }
        if (opts.async) {
            console.log(result.id)
            console.error(
                kleur.dim(
                    `task ${result.id} · context ${result.contextId} — ${result.status.state} (${resolved.label})`
                )
            )
            console.error(
                kleur.dim(
                    `track: mf a2a tasks get ${target} ${result.id} --wait`
                )
            )
            return
        }
        const text = artifactText(result)
        if (text) console.log(text)
        const reason = failureReason(result)
        if (reason) console.error(kleur.red(reason))
        console.error(
            kleur.dim(
                `task ${result.id} · context ${result.contextId} — ${result.status.state}`
            )
        )
        exitForState(result.status.state)
    } catch (err) {
        if (deadline.timedOut()) {
            // Assigned from callbacks, so control flow cannot see it here.
            const runningId = followingId as string | null
            if (runningId) {
                const seen = lastSeen as Task | null
                if (opts.json && seen) console.log(JSON.stringify(seen, null, 2))
                fail(
                    opts,
                    `timed out after ${seconds}s; task ${runningId} is still running on the peer`,
                    {
                        hint: `track: mf a2a tasks get ${target} ${runningId} --wait`
                    }
                )
                return
            }
            fail(opts, `timed out after ${seconds}s with no response`)
            return
        }
        throw err
    } finally {
        deadline.dispose()
    }
}

// A peer ticket is near expiry when under this much remains; re-mint before it.
const TICKET_REFRESH_MS = 60_000

const isExpiring = (resolved: ResolvedTarget): boolean => {
    if (!resolved.expiresAt) return false
    const at = Date.parse(resolved.expiresAt)
    return Number.isFinite(at) && at - Date.now() < TICKET_REFRESH_MS
}

// Polls a task until it stops running (`tasks get --wait`, and `send` once the
// peer hands a task over at its blocking cap). The signal is the caller's
// deadline; `onPoll` sees every snapshot on the way.
const followTask = async (
    program: Command,
    target: string,
    opts: CommonOpts,
    resolved: ResolvedTarget,
    taskId: string,
    signal: AbortSignal,
    onPoll?: (task: Task) => void
): Promise<Task | { error: unknown }> => {
    let current = resolved
    let client = clientFor(current, opts)
    for (;;) {
        // Re-mint a peer ticket about to expire so a long wait doesn't 401.
        if (isExpiring(current)) {
            const next = await resolveTarget(program, target, opts)
            if ('error' in next) return next
            current = next
            client = clientFor(current, opts)
        }
        const task = await client.getTask({ id: taskId }, signal)
        onPoll?.(task)
        if (!RUNNING_STATES.has(task.status.state)) return task
        await delay(POLL_INTERVAL_MS, signal)
    }
}

const runTaskGet = async (
    program: Command,
    target: string,
    taskId: string,
    opts: TaskGetOpts
): Promise<void> => {
    const resolved = await resolveTarget(program, target, opts)
    if ('error' in resolved) {
        fail(opts, resolved.error)
        return
    }
    if (!opts.wait) {
        const task = await clientFor(resolved, opts).getTask(
            { id: taskId },
            new AbortController().signal
        )
        renderTask(task, opts.json)
        return
    }
    const seconds = resolveTimeoutSeconds(opts.timeout)
    const deadline = createDeadline(seconds)
    try {
        const task = await followTask(
            program,
            target,
            opts,
            resolved,
            taskId,
            deadline.signal
        )
        if ('error' in task) {
            fail(opts, task.error)
            return
        }
        renderTask(task, opts.json)
        exitForState(task.status.state)
    } catch (err) {
        if (deadline.timedOut()) {
            fail(
                opts,
                `timed out after ${seconds}s; task ${taskId} still running`
            )
            return
        }
        throw err
    } finally {
        deadline.dispose()
    }
}

const runTaskCancel = async (
    program: Command,
    target: string,
    taskId: string,
    opts: CommonOpts
): Promise<void> => {
    const resolved = await resolveTarget(program, target, opts)
    if ('error' in resolved) {
        fail(opts, resolved.error)
        return
    }
    const client = new A2aClient({
        endpointUrl: resolved.endpointUrl,
        bearer: resolved.bearer,
        ...guardOf(opts)
    })
    const task = await client.cancelTask(
        { id: taskId },
        new AbortController().signal
    )
    if (opts.json) {
        console.log(JSON.stringify(task, null, 2))
        return
    }
    console.error(kleur.dim(`task ${task.id} — ${task.status.state}`))
}

const runTaskSubscribe = async (
    program: Command,
    target: string,
    taskId: string,
    opts: CommonOpts
): Promise<void> => {
    const resolved = await resolveTarget(program, target, opts)
    if ('error' in resolved) {
        fail(opts, resolved.error)
        return
    }
    const client = new A2aClient({
        endpointUrl: resolved.endpointUrl,
        bearer: resolved.bearer,
        ...guardOf(opts)
    })
    const controller = new AbortController()
    process.once('SIGINT', () => controller.abort())
    const streamed = await renderStream(
        client.resubscribe({ id: taskId }, controller.signal),
        opts.json === true
    )
    printStreamed(streamed, opts.json === true)
    exitForState(streamed.state)
}

const renderStatus = async (
    program: Command,
    opts: { json?: boolean }
): Promise<void> => {
    const global = program.opts<GlobalAuthOpts>()
    try {
        const [peers, inflight] = await Promise.all([
            fetchSelfPeers(global),
            fetchSelfTasks(global, { state: 'working' })
        ])
        if (opts.json) {
            console.log(
                JSON.stringify(
                    { peers, inflight: inflight.tasks },
                    null,
                    2
                )
            )
            return
        }
        if (peers.length === 0)
            console.error(kleur.dim('no peer agents granted'))
        else {
            console.log(kleur.bold(`Callable peers (${peers.length})`))
            for (const line of formatTable(
                ['NAME', 'AGENT ID'],
                peers.map((peer): TableCell[] => [
                    peer.name,
                    [peer.agentId, kleur.dim]
                ])
            ))
                console.log(`  ${line}`)
        }
        const calls = inflight.tasks
        if (calls.length === 0)
            console.error(kleur.dim('no calls in progress'))
        else {
            console.log(kleur.bold(`\nIn-flight calls (${calls.length})`))
            for (const line of taskTable(calls)) console.log(`  ${line}`)
            console.error(
                kleur.dim(
                    '\nmf a2a tasks list — all calls · mf a2a tasks get <peer> <id> — result'
                )
            )
        }
    } catch (err) {
        fail(opts, err)
    }
}

const renderTasksList = async (
    program: Command,
    opts: TasksListOpts
): Promise<void> => {
    const global = program.opts<GlobalAuthOpts>()
    try {
        const page = await fetchSelfTasks(global, {
            state: opts.state,
            peer: opts.peer
        })
        if (opts.json) {
            console.log(JSON.stringify(page, null, 2))
            return
        }
        if (page.tasks.length === 0) {
            console.error(kleur.dim('no outbound A2A calls'))
            return
        }
        for (const line of taskTable(page.tasks)) console.log(line)
        if (page.nextCursor)
            console.error(kleur.dim('(more — narrow with --state)'))
    } catch (err) {
        fail(opts, err)
    }
}

export const registerA2a = (program: Command): void => {
    const a2a = program
        .command('a2a')
        .description(
            'Talk to A2A servers and manage this agent exposure and callers'
        )

    registerA2aManagement(a2a, program)

    addCommonOptions(
        a2a.command('card <url>').description('Fetch and print an Agent Card')
    ).action(async (url: string, opts: CommonOpts) => {
        const bearer = resolveBearer(opts.bearer)
        const card = await fetchAgentCard(url, {
            bearer,
            supportedMajor: 0,
            ...guardOf(opts)
        })
        if (opts.json) {
            console.log(JSON.stringify(card, null, 2))
            return
        }
        console.log(`${card.name}${card.version ? ` v${card.version}` : ''}`)
        console.log(
            kleur.dim(
                `protocol ${card.protocolVersion} · ${card.preferredTransport} · ${card.url}`
            )
        )
        if (card.description) console.log(card.description)
        for (const iface of card.additionalInterfaces ?? [])
            console.log(kleur.dim(`  iface ${iface.transport} ${iface.url}`))
        for (const skill of card.skills ?? [])
            console.log(`  skill ${skill.id}${skill.name ? ` — ${skill.name}` : ''}`)
    })

    // Self overview: peers this agent may call + its in-flight outbound calls.
    // Resolved live from the platform via the agent's own login token.
    a2a.command('status')
        .description('Show callable peers and in-flight outbound calls')
        .option('--json', 'emit JSON', false)
        .action((opts: { json?: boolean }) => renderStatus(program, opts))

    addSendOptions(
        a2a
            .command('send <target> <prompt>')
            .description(
                'Send a message to a granted peer (name/id from `mf a2a status`) or a raw A2A url'
            )
    ).action((target: string, prompt: string, opts: SendOpts) =>
        runSend(program, target, prompt, opts)
    )

    const tasks = a2a.command('tasks').description('Track A2A tasks')

    tasks
        .command('list')
        .description("List this agent's outbound A2A calls")
        .option('--state <state>', 'filter by state (e.g. working)')
        .option('--peer <agentId>', 'filter by peer (target agent id)')
        .option('--json', 'emit JSON', false)
        .action((opts: TasksListOpts) => renderTasksList(program, opts))

    addCommonOptions(
        tasks
            .command('get <target> <taskId>')
            .description('Fetch a task by id (target = peer name/id or url)')
            .option('--wait', 'poll until the task reaches a terminal state', false)
            .option(
                '--timeout <seconds>',
                'deadline for --wait (0 disables; default 900)'
            )
    ).action((target: string, taskId: string, opts: TaskGetOpts) =>
        runTaskGet(program, target, taskId, opts)
    )

    addCommonOptions(
        tasks
            .command('cancel <target> <taskId>')
            .description('Cancel a task by id')
    ).action((target: string, taskId: string, opts: CommonOpts) =>
        runTaskCancel(program, target, taskId, opts)
    )

    addCommonOptions(
        tasks
            .command('subscribe <target> <taskId>')
            .description('Resubscribe to a task SSE stream (reconnect)')
    ).action((target: string, taskId: string, opts: CommonOpts) =>
        runTaskSubscribe(program, target, taskId, opts)
    )
}
