import kleur from 'kleur'
import type {
    AutomationDeliveryStatus,
    AutomationDetail,
    AutomationRunSummary,
    ChatMessage
} from '@manyfold/shared'
import { ApiError, type NcaClient } from '@manyfold/sdk'
import { fail, printJson } from '@/output'
import { chatLink } from '@/commands/agent/create'
import {
    findMessage,
    followTurn,
    footer,
    humanView,
    quietView,
    TurnStreamLost,
    type TurnReply,
    type TurnView
} from '@/commands/agent/chat-turn'

// A run's reply, as `mf automations run --wait` and `mf automations result`
// show it: followed on its session's stream while the run goes on, read off
// its message once the run has ended.

export interface RunResult {
    run: AutomationRunSummary
    // null: the run failed before its prompt reached the agent, or its chat
    // session is gone.
    reply: TurnReply | null
}

export interface RunResultDeps {
    pollMs?: number
    retryDelayMs?: (attempt: number) => number
}

type RunOf = Pick<AutomationDetail, 'id' | 'agentId'>

// A run hands its prompt to the agent as it starts, and the API marks it
// ended on the next read after its turn ends.
const HANDOFF_POLLS = 120
const SETTLE_POLLS = 10

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

const reread = async (
    client: NcaClient,
    automation: RunOf,
    runId: string
): Promise<AutomationRunSummary> => {
    const detail = await client.automations.get(automation.id)
    const run = detail.runs.find((candidate) => candidate.id === runId)
    if (!run)
        throw new Error(`run ${runId} is gone from ${automation.id}'s history`)
    return run
}

// A finished turn's blocks through the view, as its stream showed them.
const replay = (message: ChatMessage, view: TurnView): TurnReply => {
    let text = ''
    let thinking = ''
    for (const block of message.contentBlocks) {
        if (block.type === 'text') {
            text += block.text
            view.text(block.text)
        } else if (block.type === 'thinking') {
            thinking += block.text
            view.thinking(block.text)
        } else if (block.type === 'tool_call') view.toolCall(block)
    }
    return {
        text,
        thinking,
        usage: message.usage ?? null,
        error: message.error ?? null
    }
}

export const runResult = async (
    client: NcaClient,
    automation: RunOf,
    start: AutomationRunSummary,
    view: TurnView,
    deps: RunResultDeps = {}
): Promise<RunResult> => {
    const pollMs = deps.pollMs ?? 1_000
    let run = start
    for (
        let poll = 0;
        run.status === 'running' &&
        !run.assistantMessageId &&
        poll < HANDOFF_POLLS;
        poll++
    ) {
        await sleep(pollMs)
        run = await reread(client, automation, run.id)
    }
    if (!run.chatSessionId || !run.assistantMessageId)
        return { run, reply: null }
    const turn = {
        agentId: automation.agentId,
        sessionId: run.chatSessionId,
        assistantMessageId: run.assistantMessageId
    }
    if (run.status !== 'running') {
        const message = await findMessage(client, turn).catch(
            (err: unknown) => {
                if (err instanceof ApiError && err.status === 404) return null
                throw err
            }
        )
        return { run, reply: message ? replay(message, view) : null }
    }
    const reply = await followTurn(client, turn, view, deps)
    for (let poll = 0; poll < SETTLE_POLLS; poll++) {
        run = await reread(client, automation, run.id)
        if (run.status !== 'running') break
        await sleep(pollMs)
    }
    return { run, reply }
}

const DELIVERY: Record<AutomationDeliveryStatus, string> = {
    sent: 'sent to its channel',
    queued: 'queued for its channel',
    failed: 'could not be sent to its channel',
    suppressed: 'not sent: the agent had nothing to report'
}

const runLine = (
    run: AutomationRunSummary,
    reply: TurnReply | null,
    resultCommand: string
): string => {
    const delivery = run.deliveryStatus
        ? kleur.dim(` · ${DELIVERY[run.deliveryStatus]}`)
        : ''
    if (run.status === 'succeeded')
        return `${kleur.green(`run ${run.id} succeeded`)}${delivery}`
    if (run.status === 'failed')
        return `${kleur.red(`run ${run.id} failed: ${run.errorMessage ?? reply?.error?.message ?? 'unknown error'}`)}${reply?.error ? kleur.dim(` (${reply.error.code})`) : ''}${delivery}`
    return `${kleur.yellow(`run ${run.id} is still running`)}${kleur.dim(` · its result: ${resultCommand}`)}`
}

export interface ShowRunOptions {
    json?: boolean
    showThinking?: boolean
}

// Shows a run's reply and how the run ended; a Ctrl-C while it runs stops
// following it, not the run. Exits 1 for a failed run.
export const showRun = async (
    client: NcaClient,
    automation: RunOf,
    run: AutomationRunSummary,
    opts: ShowRunOptions,
    deps: RunResultDeps = {}
): Promise<void> => {
    const resultCommand = `mf automations result ${automation.id} --run ${run.id}`
    const human = humanView({
        stream: !opts.json && process.stdout.isTTY === true,
        showThinking: opts.showThinking,
        chatLink: () =>
            run.chatSessionId
                ? chatLink(client, automation.agentId, run.chatSessionId)
                : Promise.resolve(null)
    })
    const stopFollowing = (): void => {
        console.error(
            kleur.dim(
                `\nstopped following run ${run.id}; it goes on. Its result: ${resultCommand}`
            )
        )
        process.exit(130)
    }
    if (run.status === 'running' && !opts.json)
        console.error(
            kleur.dim(
                `run ${run.id} is running · following its reply (Ctrl-C stops following; the run goes on)`
            )
        )
    process.on('SIGINT', stopFollowing)
    let result: RunResult
    try {
        result = await runResult(
            client,
            automation,
            run,
            opts.json ? quietView : human,
            deps
        )
    } catch (err) {
        if (err instanceof TurnStreamLost) {
            fail(opts, err, {
                hint: `The run goes on. Its result: ${resultCommand}`
            })
            return
        }
        throw err
    } finally {
        process.removeListener('SIGINT', stopFollowing)
    }
    const { reply } = result
    const ended = result.run
    process.exitCode = ended.status === 'failed' ? 1 : 0
    if (opts.json) {
        printJson({
            run: ended,
            text: reply?.text ?? null,
            ...(opts.showThinking ? { thinking: reply?.thinking ?? null } : {}),
            usage: reply?.usage ?? null,
            error: reply?.error ?? null
        })
        return
    }
    if (reply) human.finish(reply)
    else if (ended.resultPreview) {
        console.log(ended.resultPreview)
        console.error(
            kleur.dim(
                "(the reply's first line, as the run recorded it: its chat session is gone)"
            )
        )
    }
    if (reply && ended.chatSessionId)
        for (const line of footer(
            {
                sessionId: ended.chatSessionId,
                usage: reply.usage,
                elapsedMs:
                    (ended.finishedAt
                        ? Date.parse(ended.finishedAt)
                        : Date.now()) - Date.parse(ended.startedAt)
            },
            `mf agent send ${automation.agentId} --session ${ended.chatSessionId} "…"`
        ))
            console.error(kleur.dim(line))
    console.error(runLine(ended, reply, resultCommand))
}
