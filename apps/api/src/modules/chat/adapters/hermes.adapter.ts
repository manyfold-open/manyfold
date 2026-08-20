import {
    DAEMON_FEATURE_TURN_HERMES,
    DEFAULT_CHAT_EXEC_TIMEOUTS,
    HERMES_HISTORY_BUDGET,
    agentBaseUrl,
    envTextFromExtras,
    envTextToRecord,
    resolveChatExecTimeoutMs
} from '@manyfold/shared'
import type {
    AgentFramework,
    ChatCapabilities,
    ChatMessage,
    DaemonTurnStartPayload,
    HermesCredentialsInput
} from '@manyfold/shared'
import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { agents, agentCredentials, type Database } from '@manyfold/db'
import { buildOpenAiUsage, type OpenAIUsage } from './openai-usage'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { UsagePricingService } from '@/modules/usage/usage-pricing.service'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { DaemonFencedDispatchService } from './daemon-fenced-dispatch.service'
import { ChatRepository } from '@/modules/chat/chat.repository'
import {
    daemonAdvertisesFeature,
    isDaemonOfflineTransportError,
    isDaemonResumeSuspendError
} from '@/modules/chat/chat-adapter'
import type {
    ApiChatAdapter,
    ApiChatAdapterContext,
    ApiChatResumeContext,
    EmittedChatEvent,
    EmittedErrorEvent
} from '@/modules/chat/chat-adapter'
import { messageToPromptText } from './message-content'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { classifyManagedChannelFailureSignal } from '@/modules/chat/managed-channel-failure-signal'
import {
    acpEventsFromNotification,
    HermesAcpClient,
    type AcpEvent,
    type AcpRequestTimeouts,
    type JsonRpcNotification
} from './hermes-acp-client'

// #556: this was a hard-coded 240s over the whole turn, and the streamed
// session/update notifications never reset it — so it capped total duration
// instead of detecting a hang, and any turn longer than 4 minutes was
// truncated. It survives only as the inactivity default (same number, new
// meaning: strictly more permissive) and as the legacy budget sent to runners
// that predate the split.
const HERMES_LEGACY_TURN_TIMEOUT_MS = 240_000
const HERMES_TURN_IDLE_TIMEOUT_MS = Math.max(
    1_000,
    Number(
        process.env.HERMES_TURN_IDLE_TIMEOUT_MS ?? HERMES_LEGACY_TURN_TIMEOUT_MS
    )
)

interface HermesRuntime {
    ingressHost: string
    apiServerKey: string
    modelName: string
}

interface OpenAIToolCallDelta {
    index?: number
    id?: string | null
    type?: string | null
    function?: {
        name?: string | null
        arguments?: string | null
    } | null
}

interface OpenAIDelta {
    choices?: Array<{
        delta?: {
            content?: string | null
            reasoning_content?: string | null
            reasoning?: string | null
            tool_calls?: OpenAIToolCallDelta[]
        }
        finish_reason?: string | null
    }>
    usage?: OpenAIUsage
    model?: string
}

interface PendingToolCall {
    id: string | null
    name: string | null
    args: string
    emitted: boolean
}

interface OpenAIError {
    error?: { message?: string; code?: string }
}

const flagEnabled = (name: string): boolean =>
    ['1', 'true', 'yes'].includes((process.env[name] ?? '').toLowerCase())
// Gates attempting an ACP resume at all. Read per call — a module-load
// snapshot is untestable and undrillable without a process restart, which is
// how the runner allowlist bug survived every unit test.
const acpResumeEnabled = (): boolean => flagEnabled('MF_HERMES_ACP_RESUME')
// Gates the runner-owned transport (turn.start). Off until the staging drill
// proves recovery end to end; the per-daemon capability check keeps it a no-op
// against CLIs that predate the RPC either way.
const turnRpcEnabled = (): boolean => flagEnabled('MF_HERMES_TURN_RPC')

const HERMES_ACP_PARSER_NAME = 'hermes-acp'
const HERMES_ACP_PARSER_VERSION = '1'
const HERMES_STREAM_PARSER_NAME = 'hermes-openai-sse'
const HERMES_STREAM_PARSER_VERSION = '1'

// Content mapping for one ACP event, shared by the live drain and the resume
// replay so a recovered turn cannot decode differently from the turn it is
// recovering. Control-flow events (error/turn_end/usage) stay with the live
// path, which is the only place they mean anything.
const acpEventToChatEvents = (
    ev: AcpEvent,
    sourceSeq: number
): EmittedChatEvent[] => {
    // A stable identity for the row, which is what makes replay idempotent.
    // Ordinal is safe here even though delta text is not: the instability that
    // forced claude to block-level output came from the BROADCASTER merging
    // rows, while exec.resume replays byte-identical stdout — so the Nth ACP
    // event is the same event in both runs.
    const source: EmittedChatEvent = {
        type: 'raw_source',
        source: {
            sourceRef: null,
            sourceSeq,
            externalId: `hermes-acp-${sourceSeq}`,
            parentExternalId: null,
            rawFormat: 'json',
            rawJson: ev as unknown as Record<string, unknown>,
            parserName: HERMES_ACP_PARSER_NAME,
            parserVersion: HERMES_ACP_PARSER_VERSION
        }
    } as EmittedChatEvent
    switch (ev.type) {
        case 'text':
            return [source, { type: 'token', text: ev.text }]
        case 'thinking':
            return [source, { type: 'thinking', text: ev.text }]
        case 'tool_call':
            return [
                source,
                {
                    type: 'tool_call',
                    toolCallId: ev.toolCallId,
                    toolName: ev.toolName,
                    args: ev.input ?? {}
                }
            ]
        default:
            return []
    }
}

@Injectable()
export class HermesAdapter implements ApiChatAdapter {
    readonly framework: AgentFramework = 'hermes'
    private readonly logger = new Logger(HermesAdapter.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService,
        private readonly pricing: UsagePricingService,
        private readonly daemonRegistry: DaemonRegistryService,
        private readonly chatRepo: ChatRepository,
        // Appended LAST and @Optional so the existing positional test
        // construction keeps working. Absent, the turn falls back to the same
        // DEFAULT_CHAT_EXEC_TIMEOUTS cap the admin setting ships with.
        @Optional() private readonly adminSettings?: AdminSettingsService,
        // Same rule. Absent, turn.start dispatches unfenced as before (#619).
        @Optional()
        private readonly fencedDispatch?: DaemonFencedDispatchService
    ) {}

    // The wall-clock cap is the ADMIN chat exec budget (default 2h) — the same
    // knob that already bounds claude-code / codex / gemini turns, which is why
    // those routinely run past 240s while hermes could not. Only the inactivity
    // budget is hermes's own.
    private async turnBudgets(): Promise<AcpRequestTimeouts> {
        const execTimeouts = this.adminSettings
            ? await this.adminSettings.getCachedChatExecTimeoutMs()
            : resolveChatExecTimeoutMs(DEFAULT_CHAT_EXEC_TIMEOUTS)
        return {
            idleTimeoutMs: HERMES_TURN_IDLE_TIMEOUT_MS,
            maxDurationMs: execTimeouts.timeoutMs
        }
    }

    getCapabilities(): ChatCapabilities {
        return {
            streaming: true,
            toolCalls: true,
            thinking: true,
            attachments: true,
            multiTurn: true
        }
    }

    async *sendMessage(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage
    ): AsyncIterable<EmittedChatEvent> {
        const [agentRow] = await this.db
            .select({
                runtime: agents.runtime,
                daemonId: agents.daemonId,
                workspacePath: agents.workspacePath,
                extras: agents.extras
            })
            .from(agents)
            .where(eq(agents.id, ctx.agentId))
            .limit(1)
        if (!agentRow) throw new Error(`agent ${ctx.agentId} not found`)

        if (agentRow.runtime === 'daemon') {
            if (!agentRow.daemonId)
                throw new Error(
                    `daemon hermes agent ${ctx.agentId} missing daemonId`
                )
            yield* this.sendViaDaemonAcp(ctx, userMessage, {
                daemonId: agentRow.daemonId,
                cwd: agentRow.workspacePath ?? null,
                // A BYOD daemon spawns `hermes acp` fresh each turn, so the
                // agent's env text rides the payload (#781). A sprite hermes
                // keeps its env on the resident service instead.
                env: envTextToRecord(envTextFromExtras(agentRow.extras))
            })
            return
        }

        // A sprite hermes turn normally POSTs to the sprite's resident
        // gateway, and closing that socket CANCELS the run — so an api restart
        // destroys the answer outright, which is the whole reason the runner
        // exists. Routing a runner-carried turn through the daemon transport is
        // what makes it survivable.
        // Measured on staging 2026-07-28: `hermes acp` runs inside the sprite
        // alongside the still-running resident gateway services without
        // disturbing them. Reachable only via the runner allowlist (empty
        // everywhere by default).
        if (ctx.runnerDaemonId) {
            this.logger.log(
                `hermes sprite turn via runner agent=${ctx.agentId} daemonId=${ctx.runnerDaemonId}`
            )
            yield* this.sendViaDaemonAcp(ctx, userMessage, {
                daemonId: ctx.runnerDaemonId,
                cwd: agentRow.workspacePath ?? null
            })
            return
        }

        const runtime = await this.resolveRuntime(ctx.agentId)
        const url = agentBaseUrl(runtime.ingressHost, '/v1/chat/completions')
        const truncated = truncateHistory(
            [...ctx.history, userMessage],
            HERMES_HISTORY_BUDGET
        )

        let res: Response
        try {
            res = await fetch(url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${runtime.apiServerKey}`,
                    accept: 'text/event-stream'
                },
                body: JSON.stringify({
                    model: runtime.modelName,
                    stream: true,
                    stream_options: { include_usage: true },
                    messages: truncated.map((m) => ({
                        role: m.role,
                        content: flattenText(m)
                    }))
                }),
                // #665: this request carried NO signal, so a cancel converged
                // locally while the sprite's gateway kept generating the whole
                // answer into a socket nobody read — the same compute/billing
                // leak the dify path had (#646). ctx.abortSignal is passed
                // straight through rather than bridged into a private
                // controller the way openclaw does: openclaw needs one to merge
                // three timeout budgets with the cancel, this path has none of
                // its own, and a bridge listener would also miss a signal that
                // is ALREADY aborted (addEventListener never fires for one)
                // and leave the pre-dispatch cancel case open.
                signal: ctx.abortSignal ?? null
            })
        } catch (err) {
            if (ctx.abortSignal?.aborted) {
                yield abortedEvent()
                return
            }
            yield {
                type: 'error',
                error: {
                    code: 'hermes_network',
                    message: (err as Error).message,
                    retryable: true
                }
            }
            return
        }

        if (!res.ok || !res.body) {
            const text = await res.text().catch(() => '')
            const parsed = safeJson<OpenAIError>(text)
            const upstream = parsed?.error?.message ?? text.slice(0, 256) ?? ''
            const managedChannelFailure = classifyManagedChannelFailureSignal({
                status: res.status,
                message: text
            })
            yield {
                type: 'error',
                ...(managedChannelFailure ? { managedChannelFailure } : {}),
                error: {
                    code: 'hermes_upstream',
                    message: `${res.status} ${res.statusText}: ${upstream}`,
                    retryable: res.status >= 500
                }
            }
            return
        }

        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        let terminated = false
        const tStart = Date.now()
        let tFirstToken: number | null = null
        let capturedUsage: OpenAIUsage | null = null
        let capturedModel: string | null = null
        const toolCalls = new Map<number, PendingToolCall>()
        let sourceSeq = 0
        // A cancel destroys the body under the reader, so the pending read
        // REJECTS instead of resolving `done` — the openclaw gateway path
        // catches the same rejection around its whole loop. Only the cancel is
        // absorbed here; any other body failure keeps its existing path out of
        // this generator, where runAdapter terminalizes it.
        const readChunk = async (): Promise<Uint8Array | null> => {
            try {
                const { value, done } = await reader.read()
                return done ? null : (value ?? null)
            } catch (err) {
                if (!ctx.abortSignal?.aborted) throw err
                return null
            }
        }

        while (!terminated) {
            // Checked before every read, not only on the rejection: a cancel
            // that lands while this generator is parked on a `yield` leaves the
            // reader holding bytes that already arrived, so the next read
            // resolves normally and the loop would keep decoding an answer
            // nobody is waiting for.
            if (ctx.abortSignal?.aborted) break
            const chunk = await readChunk()
            if (chunk === null) break
            buffer += decoder.decode(chunk, { stream: true })
            let boundary = buffer.indexOf('\n\n')
            while (boundary !== -1) {
                const frame = buffer.slice(0, boundary)
                buffer = buffer.slice(boundary + 2)
                const payload = parseSseFrame(frame)
                if (payload === null) {
                    boundary = buffer.indexOf('\n\n')
                    continue
                }
                if (payload === '[DONE]') {
                    terminated = true
                    break
                }
                const delta = safeJson<OpenAIDelta>(payload)
                if (!delta) {
                    boundary = buffer.indexOf('\n\n')
                    continue
                }
                sourceSeq++
                yield {
                    type: 'raw_source',
                    source: {
                        sourceRef: ctx.frameworkSessionRef,
                        sourceSeq,
                        externalId:
                            stringValue(
                                (delta as Record<string, unknown>).id
                            ) ?? `hermes-sse-${sourceSeq}`,
                        parentExternalId: null,
                        rawFormat: 'json',
                        rawJson: delta,
                        parserName: HERMES_STREAM_PARSER_NAME,
                        parserVersion: HERMES_STREAM_PARSER_VERSION
                    }
                }
                const choice = delta?.choices?.[0]
                const content = choice?.delta?.content
                if (typeof content === 'string' && content.length > 0) {
                    if (tFirstToken === null) tFirstToken = Date.now()
                    yield { type: 'token', text: content }
                }
                const reasoning =
                    choice?.delta?.reasoning_content ?? choice?.delta?.reasoning
                if (typeof reasoning === 'string' && reasoning.length > 0)
                    yield { type: 'thinking', text: reasoning }
                const tcDeltas = choice?.delta?.tool_calls
                if (Array.isArray(tcDeltas)) {
                    for (const tc of tcDeltas) {
                        const idx = typeof tc.index === 'number' ? tc.index : 0
                        const slot = toolCalls.get(idx) ?? {
                            id: null,
                            name: null,
                            args: '',
                            emitted: false
                        }
                        if (typeof tc.id === 'string' && tc.id.length > 0)
                            slot.id = tc.id
                        if (typeof tc.function?.name === 'string')
                            slot.name = tc.function.name
                        if (typeof tc.function?.arguments === 'string')
                            slot.args += tc.function.arguments
                        toolCalls.set(idx, slot)
                    }
                }
                if (delta?.usage) capturedUsage = delta.usage
                if (delta?.model && !capturedModel) capturedModel = delta.model
                boundary = buffer.indexOf('\n\n')
            }
        }

        // A cancelled turn must not fall through to the usage/`done` tail: that
        // would bill a partial answer and report it as a completion. Same
        // terminal the openclaw gateway path emits; chat.service maps it to
        // cancelled_by_user.
        if (ctx.abortSignal?.aborted) {
            yield abortedEvent()
            return
        }

        if (toolCalls.size > 0) {
            const indices = Array.from(toolCalls.keys()).sort((a, b) => a - b)
            for (const idx of indices) {
                const slot = toolCalls.get(idx)
                if (!slot || slot.emitted) continue
                if (!slot.id || !slot.name) continue
                slot.emitted = true
                yield {
                    type: 'tool_call',
                    toolCallId: slot.id,
                    toolName: slot.name,
                    args: parseToolArgs(slot.args)
                }
            }
        }

        if (capturedUsage) {
            const usage = buildOpenAiUsage(
                capturedUsage,
                capturedModel ?? ctx.model ?? runtime.modelName,
                tStart,
                tFirstToken,
                this.pricing,
                ctx
            )
            yield { type: 'usage', usage }
        }

        yield { type: 'done', finalMessageId: ctx.messageId }
    }

    // Recover a hermes turn from the buffer of the daemon that carried it. For
    // a turn the runner OWNED (turn.start) the child is still generating inside
    // the sprite, so this replays what it wrote and then follows the live tail
    // to a real completion. For a legacy pipe-carried turn the child died with
    // the API, so the completion gate finds no evidence and suspends —
    // retryable, never a truncated `done`.
    async *resumeMessage(
        ctx: ApiChatResumeContext
    ): AsyncIterable<EmittedChatEvent> {
        // Rollout gate.
        // Seen on staging 2026-07-28: 468 of a ~5000-char answer labelled
        // `done`. That truncation is now structurally blocked by
        // drainTurnStream's completion gate, but the flag stays off until the
        // runner-owned path is drilled.
        if (!acpResumeEnabled()) {
            yield {
                type: 'error',
                error: {
                    code: 'hermes_resume_unsupported',
                    message: 'hermes ACP resume is not enabled',
                    retryable: true
                }
            }
            return
        }
        if (!ctx.daemonId || !ctx.daemonExecRef) {
            yield {
                type: 'error',
                error: {
                    code: 'hermes_resume_unsupported',
                    message: 'resume requires a daemon-carried hermes turn',
                    retryable: false
                }
            }
            return
        }
        // fromSeq is 0 BY DESIGN, whatever the cursor ladder computed: the
        // dedup keys are ordinals COUNTED FROM THE STREAM HEAD (hermes-acp-<n>),
        // so starting mid-stream would renumber every replayed event and the
        // keys would all miss — duplicating the answer instead of absorbing it.
        // The full replay is idempotent for the same reason, and hermes
        // deliberately does not stamp runnerSeq so the ladder can never hand a
        // nonzero cursor to a keying scheme that cannot shift.
        yield* this.drainTurnStream(ctx, {
            daemonId: ctx.daemonId,
            execRef: ctx.daemonExecRef,
            errorCode: 'hermes_resume_failed',
            rpc: {
                method: 'exec.resume',
                payload: { originalRefId: ctx.daemonExecRef, fromSeq: 0 },
                timeoutMs: (await this.turnBudgets()).maxDurationMs + 10_000
            }
        })
    }

    private async *sendViaDaemonAcp(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage,
        args: {
            daemonId: string
            cwd: string | null
            env?: Record<string, string>
        }
    ): AsyncIterable<EmittedChatEvent> {
        // Prefer the runner-owned turn: the daemon spawns and DRIVES `hermes
        // acp` itself, so the turn no longer dies with this process. The pipe
        // path stays for daemons whose CLI predates turn.start.
        if (
            turnRpcEnabled() &&
            (await this.daemonSupportsTurnRpc(args.daemonId))
        ) {
            yield* this.sendViaTurnRpc(ctx, userMessage, args)
            return
        }
        yield* this.sendViaAcpPipe(ctx, userMessage, args)
    }

    private async *sendViaTurnRpc(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage,
        args: {
            daemonId: string
            cwd: string | null
            env?: Record<string, string>
        }
    ): AsyncIterable<EmittedChatEvent> {
        this.logger.log(
            `hermes turn.start daemon=${args.daemonId} agent=${ctx.agentId} message=${ctx.messageId}`
        )
        const budgets = await this.turnBudgets()
        const payload: DaemonTurnStartPayload = {
            framework: 'hermes',
            prompt: messageToPromptText(userMessage),
            dir: args.cwd || process.env.HOME || '.',
            sessionId: ctx.frameworkSessionRef ?? null,
            // Platform key last; the HERMES_ prefix is reserved, so the agent
            // extras can never shadow it anyway.
            env: { ...(args.env ?? {}), HERMES_YOLO_MODE: '1' },
            // Deliberately still the legacy value: a runner that predates the
            // split reads ONLY this and must keep its old 240s absolute cap
            // rather than silently inherit the multi-hour maxDurationMs. A
            // runner that understands the split ignores it.
            timeoutMs: HERMES_LEGACY_TURN_TIMEOUT_MS,
            idleTimeoutMs: budgets.idleTimeoutMs,
            maxDurationMs: budgets.maxDurationMs
        }
        yield* this.drainTurnStream(ctx, {
            daemonId: args.daemonId,
            execRef: ctx.messageId,
            errorCode: 'hermes_daemon_acp_failed',
            rpc: {
                method: 'turn.start',
                payload: payload as unknown as Record<string, unknown>,
                // The RPC's own deadline is a THIRD absolute clock; keep it
                // above the turn's cap or it becomes the effective one.
                timeoutMs: budgets.maxDurationMs + 10_000,
                // refId == messageId is what lets the reverse-WS resume path
                // find this stream again by (daemon_id, daemon_exec_ref).
                refIdOverride: ctx.messageId
            }
        })
    }

    // One drain for a live turn.start stream and an exec.resume replay of it,
    // so a recovered turn is decoded by exactly the code that decoded it live.
    // `done` needs positive completion evidence: the final's stopReason (the
    // daemon saw session/prompt resolve) or an in-stream turn_end. Anything
    // less suspends — a terminal is irreversible because it makes the turn
    // invisible to every later recovery attempt, while repeating a resume is
    // cheap (ordinal keys make the replay idempotent).
    private async *drainTurnStream(
        ctx: ApiChatAdapterContext,
        args: {
            daemonId: string
            execRef: string
            errorCode: string
            rpc: {
                method: 'turn.start' | 'exec.resume'
                payload: Record<string, unknown>
                timeoutMs: number
                refIdOverride?: string
            }
        }
    ): AsyncIterable<EmittedChatEvent> {
        const tStart = Date.now()
        let firstTokenAt: number | null = null
        const chunks: string[] = []
        const waker: { resolve: (() => void) | null } = { resolve: null }
        const wake = (): void => {
            const r = waker.resolve
            waker.resolve = null
            if (r) r()
        }
        let ackPayload: Record<string, unknown> | undefined
        const transportError: { current: Error | null } = { current: null }
        let settled = false
        const onEvent = (kind: string, data: string): void => {
            if (kind !== 'stdout') return
            chunks.push(data)
            wake()
        }
        // A fresh turn.start goes through the generation fence (#619): a
        // dispatch lost to `connection replaced` before any frame arrived is
        // probed on the current generation and re-dispatched or resumed in
        // seconds. exec.resume keeps the plain transport — its attach errors
        // carry their own suspend semantics (#570).
        const stream =
            args.rpc.method === 'turn.start' &&
            args.rpc.refIdOverride &&
            this.fencedDispatch
                ? this.fencedDispatch.streamTurnRpc({
                      daemonId: args.daemonId,
                      method: 'turn.start',
                      payload: args.rpc.payload,
                      timeoutMs: args.rpc.timeoutMs,
                      refId: args.rpc.refIdOverride,
                      onEvent
                  })
                : this.daemonRegistry.streamRpc({
                      daemonId: args.daemonId,
                      method: args.rpc.method,
                      payload: args.rpc.payload,
                      timeoutMs: args.rpc.timeoutMs,
                      onEvent,
                      ...(args.rpc.refIdOverride
                          ? { refIdOverride: args.rpc.refIdOverride }
                          : {})
                  })
        void stream.result.then(
            (payload) => {
                ackPayload = payload
                settled = true
                wake()
            },
            (err: Error) => {
                transportError.current = err
                settled = true
                wake()
            }
        )
        const aborted = { current: false }
        const onAbort = (): void => {
            aborted.current = true
            try {
                stream.cancel()
            } catch {}
            wake()
        }
        ctx.abortSignal?.addEventListener('abort', onAbort, { once: true })

        let lineBuf = ''
        let acpSeq = 0
        let sawTurnEnd = false
        // The stream carries the child's stdout verbatim: JSON-RPC, one frame
        // per line. Responses and agent requests decode to no events; only
        // session/update notifications become content.
        const consume = function* (): IterableIterator<EmittedChatEvent> {
            for (const chunk of chunks.splice(0, chunks.length)) {
                lineBuf += chunk
                let nl = lineBuf.indexOf('\n')
                while (nl !== -1) {
                    const line = lineBuf.slice(0, nl).trim()
                    lineBuf = lineBuf.slice(nl + 1)
                    nl = lineBuf.indexOf('\n')
                    if (!line) continue
                    let note: JsonRpcNotification | null = null
                    try {
                        note = JSON.parse(line) as JsonRpcNotification
                    } catch {
                        continue
                    }
                    for (const ev of acpEventsFromNotification(note)) {
                        if (ev.type === 'turn_end') sawTurnEnd = true
                        if (
                            ev.type !== 'text' &&
                            ev.type !== 'thinking' &&
                            ev.type !== 'tool_call'
                        )
                            continue
                        if (ev.type === 'text' && firstTokenAt === null)
                            firstTokenAt = Date.now()
                        acpSeq += 1
                        yield* acpEventToChatEvents(ev, acpSeq)
                    }
                }
            }
        }
        try {
            for (;;) {
                yield* consume()
                if (settled && chunks.length === 0) break
                if (chunks.length === 0)
                    await new Promise<void>((resolve) => {
                        waker.resolve = resolve
                    })
            }
            yield* consume()
        } finally {
            ctx.abortSignal?.removeEventListener('abort', onAbort)
        }

        if (aborted.current) {
            yield {
                type: 'error',
                error: {
                    code: 'hermes_daemon_aborted',
                    message: 'hermes session aborted',
                    retryable: false
                }
            }
            return
        }
        const rpcError = transportError.current
        if (rpcError) {
            // Same rule as every daemon-carried framework: a lost socket is
            // not a failed run. Suspend so the turn stays findable. On an
            // exec.resume the hello has already proven the stream exists, so
            // a lookup-time offline error suspends too instead of
            // terminalizing a recoverable turn (#570).
            const suspendable =
                args.rpc.method === 'exec.resume'
                    ? isDaemonResumeSuspendError(rpcError)
                    : isDaemonOfflineTransportError(rpcError)
            if (suspendable) {
                this.logger.log(
                    `hermes turn suspended (daemon offline) message=${ctx.messageId}: ${rpcError.message}`
                )
                yield {
                    type: 'suspended',
                    daemonId: args.daemonId,
                    daemonExecRef: args.execRef,
                    reason: rpcError.message
                }
                return
            }
            yield {
                type: 'error',
                error: {
                    code: args.errorCode,
                    message: rpcError.message,
                    retryable: true
                }
            }
            return
        }
        const sid = stringValue(ackPayload?.['sessionId'])
        if (sid && sid !== ctx.frameworkSessionRef) {
            await this.chatRepo
                .updateFrameworkSessionRef(ctx.sessionId, sid, ctx.turnFence)
                .catch((err) =>
                    this.logger.warn(
                        `hermes session ref persist failed for ${ctx.sessionId}: ${(err as Error).message}`
                    )
                )
        }
        const stopReason = stringValue(ackPayload?.['stopReason'])
        if (!stopReason && !sawTurnEnd) {
            this.logger.warn(
                `hermes turn ended without completion evidence; suspending messageId=${ctx.messageId}`
            )
            yield {
                type: 'suspended',
                daemonId: args.daemonId,
                daemonExecRef: args.execRef,
                reason: 'acp stream ended without turn_end'
            }
            return
        }
        const rawResult = ackPayload?.['result']
        const usage = extractAcpUsage(
            rawResult && typeof rawResult === 'object'
                ? (rawResult as Record<string, unknown>)
                : undefined
        )
        if (usage) {
            yield {
                type: 'usage',
                usage: buildOpenAiUsage(
                    usage,
                    ctx.model ?? 'hermes',
                    tStart,
                    firstTokenAt,
                    this.pricing,
                    ctx
                )
            }
        }
        yield { type: 'done', finalMessageId: ctx.messageId }
    }

    private async daemonSupportsTurnRpc(daemonId: string): Promise<boolean> {
        try {
            return await daemonAdvertisesFeature(
                this.db,
                daemonId,
                DAEMON_FEATURE_TURN_HERMES
            )
        } catch (err) {
            this.logger.warn(
                `turn.hermes capability lookup failed for ${daemonId}: ${(err as Error).message} — using the pipe transport`
            )
            return false
        }
    }

    // Legacy transport: THIS process is the ACP client, speaking over a
    // forwarded exec pipe. It cannot survive an API restart by construction
    // (ACP is client-driven), which is exactly why turn.start exists. Kept for
    // daemons whose CLI predates the RPC.
    private async *sendViaAcpPipe(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage,
        args: {
            daemonId: string
            cwd: string | null
            env?: Record<string, string>
        }
    ): AsyncIterable<EmittedChatEvent> {
        const tStart = Date.now()
        let firstTokenAt: number | null = null
        const prompt = messageToPromptText(userMessage)
        const cwd = args.cwd || process.env.HOME || '.'
        const queue: AcpEvent[] = []
        const waker: { resolve: (() => void) | null } = { resolve: null }
        const wake = (): void => {
            const r = waker.resolve
            waker.resolve = null
            if (r) r()
        }
        const enqueue = (ev: AcpEvent): void => {
            queue.push(ev)
            wake()
        }
        const client = new HermesAcpClient({
            registry: this.daemonRegistry,
            daemonId: args.daemonId,
            onEvent: enqueue,
            logger: this.logger
        })
        const budgets = await this.turnBudgets()
        const state: { finished: boolean; aborted: boolean } = {
            finished: false,
            aborted: false
        }
        const onAbort = (): void => {
            state.aborted = true
            client.abort()
            wake()
        }
        ctx.abortSignal?.addEventListener('abort', onAbort, { once: true })

        const fatal: { yielded: boolean } = { yielded: false }
        // Ordinal over ACP events, persisted as the row identity so an
        // interrupted turn can be replayed without duplicating what it already
        // stored. Before this the ACP path emitted no source rows at all, so its
        // stream events had a null key, insertStreamEvent plain-inserted them,
        // and a replay would have appended the whole answer a second time.
        const acpSeq = { current: 0 }
        const drainQueue = function* (): IterableIterator<EmittedChatEvent> {
            while (queue.length > 0) {
                const ev = queue.shift()!
                switch (ev.type) {
                    case 'text':
                    case 'thinking':
                    case 'tool_call': {
                        if (ev.type === 'text' && firstTokenAt === null)
                            firstTokenAt = Date.now()
                        acpSeq.current += 1
                        yield* acpEventToChatEvents(ev, acpSeq.current)
                        break
                    }
                    case 'usage_update':
                        // pass through — final usage event handled at end
                        break
                    case 'turn_end':
                        break
                    case 'error':
                        if (fatal.yielded) {
                            // duplicate guard — should never happen because
                            // hermes-acp-client already gates on exitError,
                            // but defend against any future event re-entry.
                            break
                        }
                        yield {
                            type: 'error',
                            error: {
                                code: 'hermes_daemon_acp_event',
                                message: ev.message,
                                retryable: false
                            }
                        }
                        fatal.yielded = true
                        state.aborted = true
                        client.abort()
                        return
                    default:
                        break
                }
            }
        }

        const errorRef: { current: Error | null } = { current: null }
        const resultRef: {
            current: Record<string, unknown> | undefined
        } = { current: undefined }
        const promptDone = (async (): Promise<void> => {
            try {
                await client.start({
                    // Bounds the ACP child's whole lifetime, so it has to be
                    // the turn's ceiling and not the inactivity budget.
                    timeoutMs: budgets.maxDurationMs,
                    cwd,
                    env: args.env,
                    refIdOverride: ctx.messageId
                })
                await client.initialize(30_000)
                if (ctx.frameworkSessionRef) {
                    try {
                        await client.resumeSession({
                            cwd,
                            sessionId: ctx.frameworkSessionRef,
                            timeoutMs: 30_000
                        })
                    } catch (err) {
                        this.logger.warn(
                            `hermes session/resume failed (${(err as Error).message}); creating new session`
                        )
                        await client.newSession({
                            cwd,
                            timeoutMs: 30_000
                        })
                    }
                } else {
                    await client.newSession({
                        cwd,
                        timeoutMs: 30_000
                    })
                }
                resultRef.current = await client.prompt({
                    prompt,
                    timeouts: budgets
                })
            } finally {
                state.finished = true
                wake()
            }
        })()
        promptDone.catch((err) => {
            errorRef.current = err as Error
        })

        try {
            while (!state.finished || queue.length > 0) {
                if (queue.length === 0) {
                    await new Promise<void>((resolve) => {
                        waker.resolve = resolve
                    })
                }
                for (const ev of drainQueue()) yield ev
                if (state.aborted) break
            }
        } finally {
            ctx.abortSignal?.removeEventListener('abort', onAbort)
            await client.close().catch(() => {})
        }

        if (fatal.yielded) {
            yield { type: 'done', finalMessageId: ctx.messageId }
            return
        }

        if (state.aborted) {
            yield {
                type: 'error',
                error: {
                    code: 'hermes_daemon_aborted',
                    message: 'hermes session aborted',
                    retryable: false
                }
            }
            return
        }

        const runError = errorRef.current
        if (runError) {
            // Losing the socket is not the run failing. The daemon re-registering
            // fails pending RPCs with `connection replaced`, so the reconnect that
            // could hand this turn back was itself being reported as the failure —
            // the same bug the claude/codex/gemini adapters had, in the one path
            // that has its own error handling. Seen on staging 2026-07-28:
            // restart mid-turn → 1.4s later `hermes_daemon_acp_failed: connection
            // replaced`, turn dead.
            //
            // Suspending leaves no terminal, so the turn stays findable. With
            // MF_HERMES_ACP_RESUME off (its default) resumeMessage() declines
            // with `hermes_resume_unsupported`, so recovery lands on the
            // adoption ladder rather than an ACP replay — but a retryable
            // outcome beats a turn killed by its own recovery signal.
            if (isDaemonOfflineTransportError(runError)) {
                this.logger.log(
                    `hermes acp suspended (daemon offline) agent=${ctx.agentId} message=${ctx.messageId}`
                )
                yield {
                    type: 'suspended',
                    daemonId: args.daemonId,
                    daemonExecRef: ctx.messageId,
                    reason: runError.message
                }
                return
            }
            yield {
                type: 'error',
                error: {
                    code: 'hermes_daemon_acp_failed',
                    message: runError.message,
                    retryable: true
                }
            }
            return
        }

        const sid = client.currentSessionId
        if (sid && !ctx.frameworkSessionRef) {
            await this.chatRepo
                .updateFrameworkSessionRef(ctx.sessionId, sid, ctx.turnFence)
                .catch((err) =>
                    this.logger.warn(
                        `hermes daemon ref persist failed for ${ctx.sessionId}: ${(err as Error).message}`
                    )
                )
        }

        const usage = extractAcpUsage(resultRef.current)
        if (usage) {
            const built = buildOpenAiUsage(
                usage,
                ctx.model ?? 'hermes',
                tStart,
                firstTokenAt,
                this.pricing,
                ctx
            )
            yield { type: 'usage', usage: built }
        }
        yield { type: 'done', finalMessageId: ctx.messageId }
    }

    private async resolveRuntime(agentId: string): Promise<HermesRuntime> {
        const agentRows = await this.db
            .select({
                ingressHost: agents.ingressHost,
                runtimeId: agents.runtimeId
            })
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        const agent = agentRows[0]
        if (!agent?.ingressHost)
            throw new Error(`agent ${agentId} has no ingress host`)
        if (!agent.runtimeId)
            throw new Error(`agent ${agentId} has no linked runtime`)

        const credRows = await this.db
            .select()
            .from(agentCredentials)
            .where(eq(agentCredentials.runtimeId, agent.runtimeId))
            .limit(1)
        const credRow = credRows[0]
        if (!credRow)
            throw new Error(`no stored credentials for agent ${agentId}`)
        const creds = JSON.parse(
            this.crypto.decrypt({
                ciphertext: credRow.payloadCiphertext,
                keyVersion: credRow.keyVersion
            })
        ) as HermesCredentialsInput
        if (!creds.apiServerKey)
            throw new Error(
                `agent ${agentId} credentials missing apiServerKey — rebuild the agent`
            )

        return {
            ingressHost: agent.ingressHost,
            apiServerKey: creds.apiServerKey,
            modelName: creds.primaryModelName ?? 'hermes-agent'
        }
    }
}

const flattenText = (message: ChatMessage): string =>
    messageToPromptText(message)

// The gateway path's cancel terminal. Distinct from hermes_daemon_aborted so a
// leaked gateway socket and a cancelled daemon turn stay separable in triage;
// both normalize to cancelled_by_user in chat.service.
const abortedEvent = (): EmittedErrorEvent => ({
    type: 'error',
    error: {
        code: 'hermes_aborted',
        message: 'hermes turn aborted',
        retryable: false
    }
})

const truncateHistory = (
    history: ChatMessage[],
    budget: number
): ChatMessage[] => {
    const systemPrefix: ChatMessage[] = []
    const rest: ChatMessage[] = []
    for (const msg of history) {
        if (msg.role === 'system' && rest.length === 0) systemPrefix.push(msg)
        else rest.push(msg)
    }
    const recent = rest.slice(-budget)
    return [...systemPrefix, ...recent]
}

const parseSseFrame = (frame: string): string | null => {
    const dataLines: string[] = []
    for (const line of frame.split('\n'))
        if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
    const payload = dataLines.join('\n').trim()
    return payload.length === 0 ? null : payload
}

const safeJson = <T>(text: string): T | null => {
    try {
        return JSON.parse(text) as T
    } catch {
        return null
    }
}

const stringValue = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null

const parseToolArgs = (raw: string): unknown => {
    if (raw.length === 0) return null
    try {
        return JSON.parse(raw)
    } catch {
        return raw
    }
}

const extractAcpUsage = (
    result: Record<string, unknown> | undefined
): OpenAIUsage | null => {
    if (!result) return null
    const raw = result['usage']
    if (!raw || typeof raw !== 'object') return null
    const obj = raw as Record<string, unknown>
    const num = (...keys: string[]): number | undefined => {
        for (const k of keys) {
            const v = obj[k]
            if (typeof v === 'number') return v
        }
        return undefined
    }
    const prompt = num('inputTokens', 'prompt_tokens')
    const completion = num('outputTokens', 'completion_tokens')
    const cacheRead = num('cacheReadTokens', 'cache_read_input_tokens')
    const cacheCreate = num('cacheWriteTokens', 'cache_creation_input_tokens')
    if (
        prompt === undefined &&
        completion === undefined &&
        cacheRead === undefined &&
        cacheCreate === undefined
    )
        return null
    const usage: OpenAIUsage = {
        prompt_tokens: prompt ?? 0,
        completion_tokens: completion ?? 0,
        total_tokens: (prompt ?? 0) + (completion ?? 0)
    }
    if (cacheRead !== undefined) usage.cache_read_input_tokens = cacheRead
    if (cacheCreate !== undefined)
        usage.cache_creation_input_tokens = cacheCreate
    return usage
}
