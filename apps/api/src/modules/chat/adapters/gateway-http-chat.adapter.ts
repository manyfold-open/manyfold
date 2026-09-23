import { ChatRunnerError } from '../runner/chat-runner'
import { DAEMON_FEATURE_TURN_OPENCLAW } from '@manyfold/shared'
import type {
    AgentFramework,
    ChatCapabilities,
    ChatMessage,
    DaemonOpenclawTurnPayload
} from '@manyfold/shared'
import { Logger } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { agents, type Database } from '@manyfold/db'
import { buildOpenAiUsage, type OpenAIUsage } from './openai-usage'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { UsagePricingService } from '@/modules/usage/usage-pricing.service'
import { ChatRepository } from '@/modules/chat/chat.repository'
import { ExecDriverFactory } from '@/modules/chat/adapters/exec-driver-factory'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { DaemonFencedDispatchService } from './daemon-fenced-dispatch.service'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import {
    daemonAdvertisesFeature,
    isDaemonOfflineTransportError,
    isDaemonResumeSuspendError,
    type ApiChatAdapter,
    type ApiChatAdapterContext,
    type ApiChatResumeContext,
    type EmittedChatEvent
} from '@/modules/chat/chat-adapter'
import { classifyManagedChannelFailureSignal } from '@/modules/chat/managed-channel-failure-signal'
import { messageToPromptText } from './message-content'
import {
    openclawCancelledEvent as cancelledEvent,
    resolveOpenclawStreamBudgets,
    type OpenclawStreamBudgets
} from './openclaw-turn-shared'

const OPENCLAW_HISTORY_BUDGET = 30
const OPENCLAW_STREAM_PARSER_NAME = 'openclaw-openai-sse'
const OPENCLAW_STREAM_PARSER_VERSION = '1'

interface OpenclawDecodeState {
    firstTokenAt: number | null
    usage: OpenAIUsage | null
    model: string | null
    inlineError: string | null
}

const freshDecodeState = (): OpenclawDecodeState => ({
    firstTokenAt: null,
    usage: null,
    model: null,
    inlineError: null
})

export interface OpenclawRuntime {
    ingressHost: string
    gatewayToken: string
    modelId: string
    displayModel: string | null
    // The gateway's port inside the runtime, which the runner dials on
    // loopback.
    port: number
}

interface OpenAIToolCallDelta {
    index?: number
    id?: string
    type?: string
    function?: { name?: string; arguments?: string }
}

interface OpenAIToolResultDelta {
    tool_call_id?: string
    content?: string
}

interface OpenAIDelta {
    choices?: Array<{
        delta?: {
            content?: string | null
            reasoning_content?: string | null
            tool_calls?: OpenAIToolCallDelta[]
            tool_results?: OpenAIToolResultDelta[]
        }
        finish_reason?: string | null
    }>
    usage?: OpenAIUsage
    model?: string
}

interface OpenAIError {
    error?: { message?: string; code?: string; type?: string }
}

// The OpenAI-compatible gateway chat transport: a turn is a POST to the
// agent's `/v1/chat/completions` ingress, carrying a truncated history and
// reading an SSE stream back, moved inside the runtime by a runner that holds
// the socket (turn-rpc). A framework that chats this way extends it and
// resolves its gateway (resolveRuntime); OpenclawAdapter descends from it for
// the transports openclaw has not yet retired (ADR-0027).
//
// Abstract because `framework` decides the wire model id, the readiness code
// and whether the channel fields ride the body.
export abstract class GatewayHttpChatAdapter implements ApiChatAdapter {
    abstract readonly framework: AgentFramework
    readonly resumeReplaysFromStart = true
    protected readonly logger = new Logger(this.constructor.name)

    // Not decorated: this class is never a Nest provider. Every concrete
    // subclass redeclares a decorated constructor and forwards here.
    constructor(
        protected readonly db: Database,
        protected readonly crypto: CryptoService,
        protected readonly pricing: UsagePricingService,
        protected readonly chatRepo: ChatRepository,
        protected readonly drivers: ExecDriverFactory,
        protected readonly telemetry: TelemetryService,
        protected readonly daemonRegistry?: DaemonRegistryService,
        protected readonly adminSettings?: AdminSettingsService,
        protected readonly fencedDispatch?: DaemonFencedDispatchService
    ) {}

    abstract getCapabilities(): ChatCapabilities

    protected streamBudgets(): Promise<OpenclawStreamBudgets> {
        return resolveOpenclawStreamBudgets(this.adminSettings)
    }

    async *sendMessage(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage
    ): AsyncIterable<EmittedChatEvent> {
        const [agentRow] = await this.db
            .select({
                runtime: agents.runtime,
                internalId: agents.internalId,
                daemonId: agents.daemonId
            })
            .from(agents)
            .where(eq(agents.id, ctx.agentId))
            .limit(1)
        if (!agentRow) throw new Error(`agent ${ctx.agentId} not found`)
        yield* this.dispatchTurn(ctx, userMessage, agentRow)
    }

    // The transport choice, split out of sendMessage so a subclass can route a
    // runtime elsewhere without re-reading the agent row — the fixtures serve
    // db rows from an ordered queue, so a second select would shift it.
    protected async *dispatchTurn(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage,
        _agentRow: {
            runtime: string
            internalId: string | null
            daemonId: string | null
        }
    ): AsyncIterable<EmittedChatEvent> {
        const runtime = await this.resolveRuntime(ctx.agentId)
        if (!ctx.runnerDaemonId || !this.daemonRegistry)
            throw new ChatRunnerError(ctx.runtimeKind, 'runner missing')
        if (!await this.daemonSupportsTurnRpc(ctx.runnerDaemonId))
            throw new ChatRunnerError(ctx.runtimeKind, 'turn.openclaw missing', true)
        yield* this.sendViaTurnRpc(ctx, userMessage, runtime, ctx.runnerDaemonId)
    }

    // Extra body fields for a turn that arrived from a channel. A framework
    // whose gateway can deliver the reply through the channel itself names
    // the channel here; the plain four-field body is the default.
    protected channelBodyFields(
        _ctx: ApiChatAdapterContext,
        _userMessage: ChatMessage
    ): Record<string, unknown> {
        return {}
    }

    private *decodeDelta(
        delta: OpenAIDelta,
        seq: number,
        ctx: ApiChatAdapterContext,
        state: OpenclawDecodeState
    ): Generator<EmittedChatEvent> {
        // Inline-error chunks: openclaw forwards upstream errors as
        // `data: {"error":{...}}` mid-stream (not as an HTTP error). If we
        // don't surface this, the turn ends with a bare `done` and no message
        // body — user sees nothing.
        const inlineErr = (delta as OpenAIError).error
        if (inlineErr) {
            state.inlineError =
                inlineErr.message ?? 'upstream error (no message)'
            const managedChannelFailure = classifyManagedChannelFailureSignal({
                message: JSON.stringify({ error: inlineErr })
            })
            yield {
                type: 'error',
                ...(managedChannelFailure ? { managedChannelFailure } : {}),
                error: {
                    code: 'openclaw_upstream',
                    message: state.inlineError,
                    retryable: false
                }
            }
            return
        }
        // Stable row identity for replay: the gateway's own chunk id when it
        // sends one, else the ordinal counted from the stream head — which is
        // why a resume must replay from seq 0.
        yield {
            type: 'raw_source',
            source: {
                sourceRef: ctx.frameworkSessionRef,
                sourceSeq: seq,
                externalId:
                    stringValue((delta as Record<string, unknown>).id) ??
                    `openclaw-sse-${seq}`,
                parentExternalId: null,
                rawFormat: 'json',
                rawJson: delta,
                parserName: OPENCLAW_STREAM_PARSER_NAME,
                parserVersion: OPENCLAW_STREAM_PARSER_VERSION
            }
        }
        const choiceDelta = delta?.choices?.[0]?.delta
        const content = choiceDelta?.content
        if (typeof content === 'string' && content.length > 0) {
            if (state.firstTokenAt === null) state.firstTokenAt = Date.now()
            yield { type: 'token', text: content }
        }
        const reasoning = choiceDelta?.reasoning_content
        if (typeof reasoning === 'string' && reasoning.length > 0) {
            if (state.firstTokenAt === null) state.firstTokenAt = Date.now()
            yield { type: 'thinking', text: reasoning }
        }
        const toolCalls = choiceDelta?.tool_calls
        if (Array.isArray(toolCalls)) {
            for (const tc of toolCalls) {
                if (!tc?.id || !tc.function?.name) continue
                let args: unknown = {}
                try {
                    args = tc.function.arguments
                        ? JSON.parse(tc.function.arguments)
                        : {}
                } catch {
                    args = { _raw: tc.function.arguments ?? '' }
                }
                yield {
                    type: 'tool_call',
                    toolCallId: tc.id,
                    toolName: tc.function.name,
                    args
                }
            }
        }
        const toolResults = choiceDelta?.tool_results
        if (Array.isArray(toolResults)) {
            for (const tr of toolResults) {
                if (!tr?.tool_call_id) continue
                let result: unknown = tr.content ?? null
                if (typeof tr.content === 'string') {
                    try {
                        result = JSON.parse(tr.content)
                    } catch {
                        result = tr.content
                    }
                }
                yield {
                    type: 'tool_result',
                    toolCallId: tr.tool_call_id,
                    result
                }
            }
        }
        if (delta?.usage) state.usage = delta.usage
        if (delta?.model && !state.model) state.model = delta.model
    }

    private *usageFromDecode(
        decode: OpenclawDecodeState,
        ctx: ApiChatAdapterContext,
        runtime: OpenclawRuntime | null,
        tStart: number
    ): Generator<EmittedChatEvent> {
        if (!decode.usage) return
        const routeKey = runtime?.modelId ?? 'openclaw'
        const echoedRouteKey =
            decode.model === routeKey ||
            decode.model?.startsWith(`${routeKey}/`)
        const upstreamModel = echoedRouteKey ? null : decode.model
        yield {
            type: 'usage',
            usage: buildOpenAiUsage(
                decode.usage,
                upstreamModel ?? ctx.model ?? runtime?.displayModel ?? routeKey,
                tStart,
                decode.firstTokenAt,
                this.pricing,
                ctx
            )
        }
    }

    // Recover a runner-carried turn from the buffer of the daemon that carried
    // it: the replay is SSE deltas through the turn stream, converging the
    // message it suspended as rather than re-running anything.
    async *resumeMessage(
        ctx: ApiChatResumeContext
    ): AsyncIterable<EmittedChatEvent> {
        if (!this.daemonRegistry) {
            yield { type: 'error', error: new ChatRunnerError(ctx.runtimeKind, 'runner registry unavailable').chatError }
            return
        }
        if (
            !ctx.daemonId ||
            !ctx.daemonExecRef
        ) {
            yield {
                type: 'error',
                error: {
                    code: 'openclaw_resume_unsupported',
                    message: 'resume requires a runner-carried openclaw turn',
                    retryable: false
                }
            }
            return
        }
        // fromSeq is 0 BY DESIGN, whatever the cursor ladder computed: when a
        // delta has no gateway-issued id, its dedup key is the ordinal counted
        // from the STREAM HEAD, so starting mid-stream would renumber every
        // replayed event and the keys would all miss. The full replay is
        // idempotent for the same reason, and openclaw deliberately does not
        // stamp runnerSeq so the ladder can never hand a nonzero cursor to a
        // keying scheme that cannot shift.
        const budgets = await this.streamBudgets()
        yield* this.drainTurnStream(ctx, {
            daemonId: ctx.daemonId,
            execRef: ctx.daemonExecRef,
            errorCode: 'openclaw_resume_failed',
            runtime: null,
            rpc: {
                method: 'exec.resume',
                payload: { originalRefId: ctx.daemonExecRef, fromSeq: 0 },
                timeoutMs: budgets.maxDurationMs + 10_000
            }
        })
    }

    private async *sendViaTurnRpc(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage,
        runtime: OpenclawRuntime,
        daemonId: string
    ): AsyncIterable<EmittedChatEvent> {
        this.logger.log(
            `openclaw turn.start daemon=${daemonId} agent=${ctx.agentId} message=${ctx.messageId}`
        )
        const truncated = truncateHistory(
            [...ctx.history, userMessage],
            OPENCLAW_HISTORY_BUDGET
        )
        // The runner owns the gateway socket and journals its SSE frames.
        const budgets = await this.streamBudgets()
        const payload: DaemonOpenclawTurnPayload = {
            framework: 'openclaw',
            url: `http://127.0.0.1:${runtime.port}/v1/chat/completions`,
            token: runtime.gatewayToken,
            body: {
                model: runtime.modelId,
                stream: true,
                stream_options: { include_usage: true },
                messages: truncated.map((m) => ({
                    role: m.role,
                    content: messageToPromptText(m)
                })),
                ...this.channelBodyFields(ctx, userMessage)
            },
            headersTimeoutMs: budgets.headersTimeoutMs,
            idleTimeoutMs: budgets.idleTimeoutMs,
            maxDurationMs: budgets.maxDurationMs
        }
        yield* this.drainTurnStream(ctx, {
            daemonId,
            execRef: ctx.messageId,
            errorCode: 'openclaw_daemon_turn_failed',
            runtime,
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

    // One drain for a live turn.start stream and an exec.resume replay of it.
    // `done` needs positive completion evidence: the final's stopReason (the
    // daemon saw `[DONE]` or a protocol-terminal error frame). Anything less
    // suspends — a terminal is irreversible because it makes the turn
    // invisible to every later recovery attempt, while repeating a resume is
    // cheap (the replay is idempotent).
    private async *drainTurnStream(
        ctx: ApiChatAdapterContext,
        args: {
            daemonId: string
            execRef: string
            errorCode: string
            runtime: OpenclawRuntime | null
            rpc: {
                method: 'turn.start' | 'exec.resume'
                payload: Record<string, unknown>
                timeoutMs: number
                refIdOverride?: string
            }
        }
    ): AsyncIterable<EmittedChatEvent> {
        if (ctx.abortSignal?.aborted) {
            yield cancelledEvent()
            return
        }
        const registry = this.daemonRegistry
        if (!registry) {
            yield {
                type: 'error',
                error: {
                    code: args.errorCode,
                    message: 'daemon registry unavailable',
                    retryable: true
                }
            }
            return
        }
        const tStart = Date.now()
        const decode = freshDecodeState()
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
                : registry.streamRpc({
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
        let seq = 0
        const decodeDelta = this.decodeDelta.bind(this)
        // One frame per line, exactly as the daemon journals them.
        const consume = function* (): IterableIterator<EmittedChatEvent> {
            for (const chunk of chunks.splice(0, chunks.length)) {
                lineBuf += chunk
                let nl = lineBuf.indexOf('\n')
                while (nl !== -1) {
                    const line = lineBuf.slice(0, nl).trim()
                    lineBuf = lineBuf.slice(nl + 1)
                    nl = lineBuf.indexOf('\n')
                    if (!line) continue
                    const delta = safeJson<OpenAIDelta>(line)
                    if (!delta) continue
                    seq++
                    yield* decodeDelta(delta, seq, ctx, decode)
                    if (decode.inlineError) return
                }
            }
        }
        try {
            for (;;) {
                yield* consume()
                if (decode.inlineError) break
                if (settled && chunks.length === 0) break
                if (chunks.length === 0)
                    await new Promise<void>((resolve) => {
                        waker.resolve = resolve
                    })
            }
            if (!decode.inlineError) yield* consume()
        } finally {
            ctx.abortSignal?.removeEventListener('abort', onAbort)
        }

        if (decode.inlineError) {
            // The error event is already out; stop reading and settle the turn
            // the same way the live SSE path does.
            try {
                stream.cancel()
            } catch {}
            yield { type: 'done', finalMessageId: ctx.messageId }
            return
        }
        if (aborted.current) {
            yield {
                type: 'error',
                error: {
                    code: 'openclaw_daemon_aborted',
                    message: 'openclaw turn aborted',
                    retryable: false
                }
            }
            return
        }
        const rpcError = transportError.current
        if (rpcError) {
            // A lost socket is not a failed run: the daemon keeps holding the
            // gateway stream, and the reverse-WS resume finishes the turn. On
            // an exec.resume the hello has already proven the stream exists,
            // so a lookup-time offline error suspends too instead of
            // terminalizing a recoverable turn (#570).
            const suspendable =
                args.rpc.method === 'exec.resume'
                    ? isDaemonResumeSuspendError(rpcError)
                    : isDaemonOfflineTransportError(rpcError)
            if (suspendable) {
                this.logger.log(
                    `openclaw turn suspended (daemon offline) message=${ctx.messageId}: ${rpcError.message}`
                )
                yield {
                    type: 'suspended',
                    daemonId: args.daemonId,
                    daemonExecRef: args.execRef,
                    reason: rpcError.message
                }
                return
            }
            const gatewayStatus = /^openclaw gateway (\d{3}) /.exec(rpcError.message)?.[1]
            const managedChannelFailure = classifyManagedChannelFailureSignal({
                status: gatewayStatus ? Number(gatewayStatus) : null,
                message: rpcError.message
            })
            yield {
                type: 'error',
                ...(managedChannelFailure ? { managedChannelFailure } : {}),
                error: {
                    code: args.errorCode,
                    message: rpcError.message,
                    retryable: true
                }
            }
            return
        }
        const stopReason = stringValue(ackPayload?.['stopReason'])
        if (!stopReason) {
            this.logger.warn(
                `openclaw turn ended without completion evidence; suspending messageId=${ctx.messageId}`
            )
            yield {
                type: 'suspended',
                daemonId: args.daemonId,
                daemonExecRef: args.execRef,
                reason: 'stream ended without [DONE]'
            }
            return
        }
        yield* this.usageFromDecode(decode, ctx, args.runtime, tStart)
        yield { type: 'done', finalMessageId: ctx.messageId }
    }

    private async daemonSupportsTurnRpc(daemonId: string): Promise<boolean> {
        try {
            return await daemonAdvertisesFeature(
                this.db,
                daemonId,
                DAEMON_FEATURE_TURN_OPENCLAW
            )
        } catch (err) {
            this.logger.warn(
                `turn.openclaw capability lookup failed for ${daemonId}: ${(err as Error).message} — refusing the turn`
            )
            return false
        }
    }

    // The gateway a turn goes to. A framework that chats over this transport
    // overrides it.
    protected async resolveRuntime(_agentId: string): Promise<OpenclawRuntime> {
        throw new Error(
            `gateway HTTP turns are not supported for ${this.framework}`
        )
    }
}

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

const safeJson = <T>(text: string): T | null => {
    try {
        return JSON.parse(text) as T
    } catch {
        return null
    }
}

const stringValue = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null
