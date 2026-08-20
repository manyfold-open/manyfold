import type { Command } from 'commander'
import kleur from 'kleur'
import {
    A2aClient,
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

const TERMINAL_STATES = new Set([
    'completed',
    'failed',
    'canceled',
    'rejected'
])

const guardOf = (opts: CommonOpts) => ({
    allowPrivate: opts.allowHttpLocalhost === true
})

const resolveEndpoint = async (
    url: string,
    bearer: string | undefined,
    guard: { allowPrivate: boolean }
): Promise<{ endpointUrl: string; card?: AgentCard }> => {
    if (looksLikeRpcEndpoint(url)) return { endpointUrl: url }
    const card = await fetchAgentCard(url, {
        bearer,
        supportedMajor: 0,
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
    opts: CommonOpts
): Promise<ResolvedTarget | { error: string }> => {
    if (isHttpUrl(target)) {
        const bearer = resolveBearer(opts.bearer)
        try {
            const { endpointUrl } = await resolveEndpoint(
                target,
                bearer,
                guardOf(opts)
            )
            return { endpointUrl, bearer, label: target }
        } catch (err) {
            return { error: (err as Error).message }
        }
    }
    const resolved = await resolvePeerForCall(
        program.opts<GlobalAuthOpts>(),
        target
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

const colorState = (state: string): string => {
    if (state === 'completed') return kleur.green(state)
    if (state === 'failed' || state === 'rejected') return kleur.red(state)
    if (state === 'canceled') return kleur.dim(state)
    return kleur.yellow(state)
}

const taskLine = (task: A2aTaskTraceItem): string =>
    `${task.id}  → ${task.targetAgentName ?? task.targetAgentId}  ` +
    `${colorState(task.state)}  ${kleur.dim(formatAge(task.createdAt))}`

const renderStream = async (
    stream: AsyncIterable<A2aStreamEvent>,
    json: boolean
): Promise<void> => {
    for await (const event of stream) {
        if (json) {
            console.log(JSON.stringify(event))
            continue
        }
        if (event.kind === 'status-update')
            console.error(
                kleur.dim(`[${event.status.state}]${event.final ? ' (final)' : ''}`)
            )
        else if (event.kind === 'artifact-update')
            process.stdout.write(partsToText(event.artifact.parts))
        else if (event.kind === 'task')
            console.error(kleur.dim(`task ${event.id} — ${event.status.state}`))
        else if (event.kind === 'message')
            process.stdout.write(partsToText(event.parts))
    }
    if (!json) process.stderr.write('\n')
}

const renderTask = (task: Task, json?: boolean): void => {
    if (json) {
        console.log(JSON.stringify(task, null, 2))
        return
    }
    const text = artifactText(task)
    if (text) console.log(text)
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
        .option('--input-file <path>', 'attach a file as an A2A file part')

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

// send (and its hidden `call`/`stream` aliases): one verb for both a granted
// peer and a raw url. Default blocks for the final artifact; --stream follows
// SSE; --async submits and returns the task id so a long peer turn survives a
// caller sprite sleep (fetch the result later with `mf a2a tasks get`).
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
    const message = buildA2aMessage(prompt, opts)

    if (opts.stream) {
        const controller = new AbortController()
        process.once('SIGINT', () => controller.abort())
        await renderStream(
            client.sendStreamingMessage(
                {
                    message,
                    configuration: { acceptedOutputModes: ['text/plain'] }
                },
                controller.signal
            ),
            opts.json === true
        )
        return
    }

    const seconds = resolveTimeoutSeconds(opts.timeout)
    const deadline = createDeadline(seconds)
    try {
        const result = await client.sendMessage(
            {
                message,
                configuration: {
                    blocking: opts.async !== true,
                    acceptedOutputModes: ['text/plain']
                }
            },
            deadline.signal
        )
        if (opts.json) {
            console.log(JSON.stringify(result, null, 2))
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
        console.error(
            kleur.dim(
                `task ${result.id} · context ${result.contextId} — ${result.status.state}`
            )
        )
    } catch (err) {
        if (deadline.timedOut()) {
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

const runTaskGet = async (
    program: Command,
    target: string,
    taskId: string,
    opts: TaskGetOpts
): Promise<void> => {
    let resolved = await resolveTarget(program, target, opts)
    if ('error' in resolved) {
        fail(opts, resolved.error)
        return
    }
    const clientFor = (r: ResolvedTarget): A2aClient =>
        new A2aClient({
            endpointUrl: r.endpointUrl,
            bearer: r.bearer,
            ...guardOf(opts)
        })
    if (!opts.wait) {
        const task = await clientFor(resolved).getTask(
            { id: taskId },
            new AbortController().signal
        )
        renderTask(task, opts.json)
        return
    }
    let client = clientFor(resolved)
    const seconds = resolveTimeoutSeconds(opts.timeout)
    const deadline = createDeadline(seconds)
    try {
        for (;;) {
            // Re-mint a peer ticket about to expire so a long wait doesn't 401.
            if (isExpiring(resolved)) {
                const next = await resolveTarget(program, target, opts)
                if ('error' in next) {
                    fail(opts, next.error)
                    return
                }
                resolved = next
                client = clientFor(resolved)
            }
            const task = await client.getTask({ id: taskId }, deadline.signal)
            if (TERMINAL_STATES.has(task.status.state)) {
                renderTask(task, opts.json)
                return
            }
            await delay(POLL_INTERVAL_MS, deadline.signal)
        }
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
    await renderStream(
        client.resubscribe({ id: taskId }, controller.signal),
        opts.json === true
    )
}

const renderPeers = async (
    program: Command,
    opts: { json?: boolean }
): Promise<void> => {
    const global = program.opts<GlobalAuthOpts>()
    try {
        const peers = await fetchSelfPeers(global)
        if (opts.json) {
            console.log(JSON.stringify(peers, null, 2))
            return
        }
        if (peers.length === 0) {
            console.error(kleur.dim('no peer agents granted'))
            return
        }
        for (const peer of peers)
            console.log(
                `${peer.name}  ${kleur.dim(peer.agentId)}\n  ${kleur.dim(peer.rpcUrl)}`
            )
    } catch (err) {
        fail(opts, err)
    }
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
            for (const peer of peers)
                console.log(`  ${peer.name}  ${kleur.dim(peer.agentId)}`)
        }
        const calls = inflight.tasks
        if (calls.length === 0)
            console.error(kleur.dim('no calls in progress'))
        else {
            console.log(kleur.bold(`\nIn-flight calls (${calls.length})`))
            for (const task of calls) console.log(`  ${taskLine(task)}`)
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
        for (const task of page.tasks) console.log(taskLine(task))
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

    // Deprecated hidden aliases: existing provisioned agents still have these
    // baked into their AGENTS.md/skill. `call`/`stream` map to `send`; `peers`
    // keeps its original list output. New guidance points to `send`/`status`.
    addSendOptions(
        a2a.command('call <peer> <prompt>', { hidden: true })
    ).action((peer: string, prompt: string, opts: SendOpts) =>
        runSend(program, peer, prompt, opts)
    )

    addMessageOptions(
        addCommonOptions(
            a2a
                .command('stream <url> <prompt>', { hidden: true })
                .option('--timeout <seconds>', '')
        )
    ).action((url: string, prompt: string, opts: SendOpts) =>
        runSend(program, url, prompt, { ...opts, stream: true })
    )

    a2a.command('peers', { hidden: true })
        .option('--json', 'emit JSON', false)
        .action((opts: { json?: boolean }) => renderPeers(program, opts))
}
