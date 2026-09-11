import { DAEMON_FEATURE_TURN_OPENCLAW, agentBaseUrl } from '@manyfold/shared'
import type {
    AgentFramework,
    ChatAttachmentBlock,
    ChatCapabilities,
    ChatMessage,
    DaemonOpenclawTurnPayload,
    OpenclawCredentialsInput
} from '@manyfold/shared'
import { Logger } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { agents, agentCredentials, type Database } from '@manyfold/db'
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
    type EmittedChatEvent,
    type EmittedErrorEvent
} from '@/modules/chat/chat-adapter'
import { manyfoldProviderToNarraNexusChannelProvider } from '@/modules/narranexus/narranexus-paths'
import { classifyManagedChannelFailureSignal } from '@/modules/chat/managed-channel-failure-signal'
import { messageToPromptText } from './message-content'
import {
    openclawCancelledEvent as cancelledEvent,
    resolveOpenclawStreamBudgets,
    type OpenclawStreamBudgets
} from './openclaw-turn-shared'

const OPENCLAW_HISTORY_BUDGET = 30
const OPENCLAW_PREFLIGHT_TIMEOUT_MS = Math.max(
    500,
    Number(process.env.OPENCLAW_PREFLIGHT_TIMEOUT_MS ?? 5_000)
)
// Total budget for the preflight retry loop. Sprite-hosted gateways
// auto-suspend on idle; Fly's wake-from-suspend takes ~10–20s before
// the gateway socket binds, so a single 5s attempt is not enough.
// Each attempt still bounded by OPENCLAW_PREFLIGHT_TIMEOUT_MS so a
// permanently-broken gateway (TCP refused) still fast-fails on each try.
const OPENCLAW_PREFLIGHT_BUDGET_MS = Math.max(
    OPENCLAW_PREFLIGHT_TIMEOUT_MS,
    Number(process.env.OPENCLAW_PREFLIGHT_BUDGET_MS ?? 30_000)
)
const OPENCLAW_PREFLIGHT_RETRY_DELAY_MS = 500
const OPENCLAW_STREAM_PARSER_NAME = 'openclaw-openai-sse'
const OPENCLAW_STREAM_PARSER_VERSION = '1'

// Gates the runner-owned transport (turn.start) AND its resume for the
// gateway-http frameworks — today narranexus alone (contract row
// `narranexus × sprites × turn-rpc`, #555). Read per call so drills and tests
// can flip it without a process restart. The per-daemon capability check keeps
// it a no-op against CLIs that predate the RPC either way.
const openclawTurnRpcEnabled = (): boolean =>
    ['1', 'true', 'yes'].includes(
        (process.env.MF_OPENCLAW_TURN_RPC ?? '').toLowerCase()
    )

// Decode state shared between one turn's deltas — the live SSE loop and the
// replayed turn stream both thread it through decodeDelta.
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
}

// Which budget fired. Named separately from the error codes because the
// runner-carried path reports the same three kinds back over RPC.
type OpenclawTimeoutKind = 'headers' | 'stream_idle' | 'max_duration'

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
// reading an SSE stream back, optionally moved inside the runtime by a runner
// that holds the socket (turn-rpc). NarraNexus is its live framework;
// OpenclawAdapter descends from it for the transports openclaw has not yet
// retired (ADR-0027).
//
// Abstract because `framework` decides the wire model id, the readiness code
// and whether the channel fields ride the body.
export abstract class GatewayHttpChatAdapter implements ApiChatAdapter {
    abstract readonly framework: AgentFramework
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

    // Overridable per framework — narranexus cold wake includes app boot and
    // needs a longer preflight budget.
    protected preflightBudgetMs(): number {
        return OPENCLAW_PREFLIGHT_BUDGET_MS
    }

    protected streamBudgets(): Promise<OpenclawStreamBudgets> {
        return resolveOpenclawStreamBudgets(this.adminSettings)
    }

    // OpenClaw protocol note: Manyfold uses the OpenAI-compatible
    // `/v1/chat/completions` endpoint (instead of OpenClaw's native WebSocket
    // RPC) for SENDING because the native RPC requires device-pairing
    // approval that we can't obtain over the public ingress with token-only
    // auth. The RPC client in openclaw-rpc-client.ts is live regardless:
    // session recovery dials it first (sessions.history/sessions.list) and
    // falls back to file scans. To still give recovery a usable
    // `framework_session_ref`, we scan the agent's session directory over the
    // recovery fs — sprite, daemon or pod alike — after the upstream call
    // completes and backfill the newest jsonl's UUID into the DB.
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
        // A runner-carried sprite turn moves the SSE socket INSIDE the sprite
        // (turn.start), holding it in a process that outlives the API so the
        // turn is recoverable.
        const viaTurnRpc =
            !!ctx.runnerDaemonId &&
            !!this.daemonRegistry &&
            openclawTurnRpcEnabled() &&
            (await this.daemonSupportsTurnRpc(ctx.runnerDaemonId))
        let succeeded = false
        try {
            const source = viaTurnRpc
                ? this.sendViaTurnRpc(
                      ctx,
                      userMessage,
                      runtime,
                      ctx.runnerDaemonId!
                  )
                : this.sendOpenAiCompat(ctx, userMessage, runtime)
            for await (const ev of source) {
                if (ev.type === 'done') succeeded = true
                if (ev.type === 'error') succeeded = false
                yield ev
            }
        } finally {
            if (succeeded && !ctx.frameworkSessionRef) {
                await this.backfillSessionRefFromFs(ctx).catch((err) => {
                    this.logger.warn(
                        `openclaw ref backfill failed for ${ctx.sessionId}: ${(err as Error).message}`
                    )
                })
            }
        }
    }

    private async backfillSessionRefFromFs(
        ctx: ApiChatAdapterContext
    ): Promise<void> {
        const handle = await this.drivers.recoveryFsForAgent(ctx.agentId)
        const script = `find "$HOME"/.openclaw/agents/*/sessions -type f -name '*.jsonl' ! -name '*.bak-*' ! -name '*.trajectory.jsonl' -printf '%T@ %p\\n' 2>/dev/null | sort -rn | head -1 | awk '{print $2}'`
        const path = await handle.fs.locate(script)
        if (!path) return
        const m = path.match(/([0-9a-f-]{36})\.jsonl$/i)
        const uuid = m?.[1]
        if (!uuid) return
        await this.chatRepo.updateFrameworkSessionRef(
            ctx.sessionId,
            uuid,
            ctx.turnFence
        )
        this.logger.log(
            `backfilled openclaw framework_session_ref for ${ctx.sessionId} → ${uuid}`
        )
    }

    // NarraNexus's /v1/chat/completions accepts channel_provider +
    // channel_context and flips the turn from owner-chat into channel mode:
    // the agent then delivers its own reply through its local channel tools
    // (backend/routes/manyfold_sync.py). Plain openclaw gateways get the
    // unchanged 4-field body.
    //
    // Everything past the four base keys is optional on the wire: NarraNexus
    // reads what a given provider's reply command needs (context_token for
    // wechat_send, thread_id for threaded replies, chat_type/is_mention for
    // group etiquette and silent memory ingest) and ignores the rest.
    protected channelBodyFields(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage
    ): Record<string, unknown> {
        const src = ctx.channelSource
        if (!src || ctx.framework !== 'narranexus') return {}
        const channelProvider = manyfoldProviderToNarraNexusChannelProvider(
            src.provider,
            { mirrored: src.mirrored === true }
        )
        if (!channelProvider) return {}
        const attachments = userMessage.contentBlocks
            .filter((b): b is ChatAttachmentBlock => b.type === 'attachment')
            .map((b) => ({
                name: b.name,
                mime: b.contentType,
                size: b.size,
                path: b.path
            }))
        return {
            channel_provider: channelProvider,
            channel_context: {
                room_id: src.chatId,
                sender_id: src.senderId,
                sender_name: src.senderName ?? null,
                source_message_id: src.messageId ?? null,
                chat_type: src.chatType,
                ...(src.threadId ? { thread_id: src.threadId } : {}),
                ...(src.isMention !== undefined
                    ? { is_mention: src.isMention }
                    : {}),
                ...(src.replyToken ? { reply_token: src.replyToken } : {}),
                ...(attachments.length > 0 ? { attachments } : {})
            }
        }
    }

    private async *sendOpenAiCompat(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage,
        runtime: OpenclawRuntime
    ): AsyncIterable<EmittedChatEvent> {
        const baseUrl = agentBaseUrl(runtime.ingressHost)
        const truncated = truncateHistory(
            [...ctx.history, userMessage],
            OPENCLAW_HISTORY_BUDGET
        )
        const tStart = Date.now()
        let tHeadersReceived: number | null = null
        const budgets = await this.streamBudgets()
        const decode = freshDecodeState()
        const emitOutcome = (
            outcome: string,
            extra: Record<string, string | number | boolean> = {}
        ): void => {
            this.telemetry.event('openclaw_chat_completed', {
                'nca.agent_id': ctx.agentId,
                'nca.session_id': ctx.sessionId,
                'nca.framework': this.framework,
                'nca.outcome': outcome,
                'nca.duration_ms': Date.now() - tStart,
                'nca.headers_ms': tHeadersReceived
                    ? tHeadersReceived - tStart
                    : null,
                'nca.first_token_ms': decode.firstTokenAt
                    ? decode.firstTokenAt - tStart
                    : null,
                // Replaces nca.fetch_timeout_ms: there is no single "the"
                // budget any more, and reporting one would keep telling triage
                // that a 240s absolute cut was an inactivity stall (#513).
                'nca.headers_timeout_ms': budgets.headersTimeoutMs,
                'nca.stream_idle_timeout_ms': budgets.idleTimeoutMs,
                'nca.max_duration_ms': budgets.maxDurationMs,
                ...extra
            })
        }

        // P2.b preflight — fail fast if gateway isn't accepting connections
        // (no point waiting OPENCLAW_FETCH_TIMEOUT_MS for the streaming chat
        // to discover the pod isn't up). HEAD `/` always returns 200 from
        // the Control UI SPA once the HTTP server binds, so any response
        // means the gateway socket is alive. Retry until the budget is
        // exhausted so that sprite cold-wake (Fly auto-resume from suspend)
        // gets enough time to bind the gateway socket.
        const preflightBudgetMs = this.preflightBudgetMs()
        const preflightDeadline = tStart + preflightBudgetMs
        let preflightOk = false
        let lastPreflightErr: Error | null = null
        let lastAttemptTimedOut = false
        let preflightAttempts = 0
        while (!preflightOk) {
            preflightAttempts++
            const remaining = preflightDeadline - Date.now()
            if (remaining <= 0) break
            const attemptSignal = AbortSignal.timeout(
                Math.min(OPENCLAW_PREFLIGHT_TIMEOUT_MS, remaining)
            )
            try {
                await fetch(baseUrl, {
                    method: 'HEAD',
                    signal: attemptSignal
                })
                preflightOk = true
            } catch (err) {
                const e = err as Error
                lastPreflightErr = e
                lastAttemptTimedOut =
                    attemptSignal.aborted || e.name === 'TimeoutError'
                if (
                    Date.now() + OPENCLAW_PREFLIGHT_RETRY_DELAY_MS >=
                    preflightDeadline
                )
                    break
                await new Promise((r) =>
                    setTimeout(r, OPENCLAW_PREFLIGHT_RETRY_DELAY_MS)
                )
            }
        }
        if (!preflightOk) {
            const e = lastPreflightErr ?? new Error('preflight failed')
            emitOutcome(
                lastAttemptTimedOut ? 'not_ready' : 'preflight_failed',
                {
                    'nca.error_class': e.name,
                    'nca.preflight_attempts': preflightAttempts,
                    'nca.preflight_budget_ms': preflightBudgetMs
                }
            )
            yield {
                type: 'error',
                error: {
                    code: `${this.framework}_not_ready`,
                    message: lastAttemptTimedOut
                        ? `${this.framework} gateway did not accept preflight within ${preflightBudgetMs / 1000}s — pod may still be starting`
                        : `${this.framework} gateway preflight failed: ${e.message}`,
                    retryable: true
                }
            }
            return
        }

        // One controller, three independent budgets. `fired` records WHICH one
        // aborted so the error code describes what actually happened instead of
        // inferring "silence" from "headers had arrived".
        const controller = new AbortController()
        const fired: { kind: OpenclawTimeoutKind | null } = { kind: null }
        const lastActivity = { at: tStart }
        const fire = (kind: OpenclawTimeoutKind): void => {
            if (fired.kind === null) fired.kind = kind
            controller.abort()
        }
        const headersTimer = setTimeout(
            () => fire('headers'),
            budgets.headersTimeoutMs
        )
        const maxTimer = setTimeout(
            () => fire('max_duration'),
            budgets.maxDurationMs
        )
        let idleTimer: NodeJS.Timeout | null = null
        // Rearmed on every body chunk — this is what makes it an INACTIVITY
        // budget rather than a deadline.
        const touch = (): void => {
            lastActivity.at = Date.now()
            if (idleTimer) clearTimeout(idleTimer)
            idleTimer = setTimeout(
                () => fire('stream_idle'),
                budgets.idleTimeoutMs
            )
        }
        const onCancel = (): void => controller.abort()
        ctx.abortSignal?.addEventListener('abort', onCancel, { once: true })
        const timeoutError = (err: Error): EmittedErrorEvent =>
            buildOpenclawFetchError(
                err,
                fired.kind,
                budgets,
                Date.now() - lastActivity.at
            )
        const timeoutAttrs = (): Record<string, string | number> => ({
            'nca.timeout_kind': fired.kind ?? 'none',
            'nca.last_activity_age_ms': Date.now() - lastActivity.at
        })
        try {
            let res: Response
            try {
                res = await fetch(`${baseUrl}/v1/chat/completions`, {
                    method: 'POST',
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${runtime.gatewayToken}`,
                        accept: 'text/event-stream'
                    },
                    body: JSON.stringify({
                        model: runtime.modelId,
                        stream: true,
                        stream_options: { include_usage: true },
                        messages: truncated.map((m) => ({
                            role: m.role,
                            content: messageToPromptText(m)
                        })),
                        ...this.channelBodyFields(ctx, userMessage)
                    }),
                    signal: controller.signal
                })
                tHeadersReceived = Date.now()
                clearTimeout(headersTimer)
                touch()
            } catch (err) {
                if (ctx.abortSignal?.aborted) {
                    emitOutcome('cancelled')
                    yield cancelledEvent()
                    return
                }
                const ev = timeoutError(err as Error)
                emitOutcome(ev.error.code, {
                    'nca.error_message': ev.error.message,
                    ...timeoutAttrs()
                })
                yield ev
                return
            }
            if (!res.ok || !res.body) {
                const text = await res.text().catch(() => '')
                const parsed = safeJson<OpenAIError>(text)
                const upstream =
                    parsed?.error?.message ?? text.slice(0, 256) ?? ''
                const managedChannelFailure =
                    classifyManagedChannelFailureSignal({
                        status: res.status,
                        message: text
                    })
                emitOutcome('upstream', {
                    'nca.upstream_status': res.status,
                    'nca.upstream_status_text': res.statusText
                })
                yield {
                    type: 'error',
                    ...(managedChannelFailure ? { managedChannelFailure } : {}),
                    error: {
                        code: 'openclaw_upstream',
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
            let sourceSeq = 0
            try {
                while (!terminated) {
                    const { value, done } = await reader.read()
                    if (done) break
                    touch()
                    buffer += decoder.decode(value, { stream: true })
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
                        yield* this.decodeDelta(delta, sourceSeq, ctx, decode)
                        if (decode.inlineError) {
                            emitOutcome('upstream_inline', {
                                'nca.error_message': decode.inlineError
                            })
                            terminated = true
                            break
                        }
                        boundary = buffer.indexOf('\n\n')
                    }
                }
            } catch (err) {
                if (ctx.abortSignal?.aborted) {
                    emitOutcome('cancelled')
                    yield cancelledEvent()
                    return
                }
                const ev = timeoutError(err as Error)
                emitOutcome(ev.error.code, {
                    'nca.error_message': ev.error.message,
                    ...timeoutAttrs()
                })
                yield ev
                return
            }
            yield* this.usageFromDecode(decode, ctx, runtime, tStart)
            emitOutcome('ok', { 'nca.tokens_emitted': sourceSeq })
            yield { type: 'done', finalMessageId: ctx.messageId }
        } finally {
            clearTimeout(headersTimer)
            clearTimeout(maxTimer)
            if (idleTimer) clearTimeout(idleTimer)
            ctx.abortSignal?.removeEventListener('abort', onCancel)
        }
    }

    // One delta → chat events. Shared VERBATIM by the live SSE loop above and
    // the replayed turn.start stream (drainTurnStream), so a recovered turn
    // cannot decode differently from the turn it is recovering.
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
        if (!openclawTurnRpcEnabled() || !this.daemonRegistry) {
            yield {
                type: 'error',
                error: {
                    code: 'openclaw_resume_unsupported',
                    message: 'openclaw turn resume is not enabled',
                    retryable: true
                }
            }
            return
        }
        if (
            ctx.runtimeKind !== 'sprites' ||
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
        // The exact request sendOpenAiCompat would have made — only the
        // socket-holder changes. Same three budgets too, so a turn cannot be
        // truncated by one transport and survive on the other.
        const budgets = await this.streamBudgets()
        const payload: DaemonOpenclawTurnPayload = {
            framework: 'openclaw',
            url: `${agentBaseUrl(runtime.ingressHost)}/v1/chat/completions`,
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
                `turn.openclaw capability lookup failed for ${daemonId}: ${(err as Error).message} — using the gateway transport`
            )
            return false
        }
    }

    protected async resolveRuntime(agentId: string): Promise<OpenclawRuntime> {
        const agentRows = await this.db
            .select({
                ingressHost: agents.ingressHost,
                runtimeId: agents.runtimeId,
                framework: agents.framework,
                internalId: agents.internalId,
                name: agents.name
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
        const credsPlain = this.crypto.decrypt({
            ciphertext: credRow.payloadCiphertext,
            keyVersion: credRow.keyVersion
        })

        if (agent.framework === 'narranexus') {
            const creds = JSON.parse(credsPlain) as { gatewayToken?: string }
            if (!creds.gatewayToken)
                throw new Error(
                    `agent ${agentId} narranexus runtime missing gatewayToken — rebuild the runtime`
                )
            return {
                ingressHost: agent.ingressHost,
                gatewayToken: creds.gatewayToken,
                modelId: agent.internalId,
                displayModel: agent.name
            }
        }

        const creds = JSON.parse(credsPlain) as OpenclawCredentialsInput
        if (!creds.gatewayToken)
            throw new Error(
                `agent ${agentId} credentials missing gatewayToken — rebuild the agent`
            )
        if (!creds.primaryModelName)
            throw new Error(
                `agent ${agentId} credentials missing primaryModelName — rebuild the agent`
            )

        return {
            ingressHost: agent.ingressHost,
            gatewayToken: creds.gatewayToken,
            modelId: 'openclaw',
            displayModel: creds.primaryModelName
        }
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

// `kind` is the budget that actually fired. Nothing is inferred from whether
// headers arrived: that inference is exactly what made an active stream cut at
// the absolute deadline report itself as "went silent" (#513).
const buildOpenclawFetchError = (
    err: Error,
    kind: OpenclawTimeoutKind | null,
    budgets: OpenclawStreamBudgets,
    silentForMs: number
): EmittedErrorEvent => {
    if (kind === null)
        return {
            type: 'error',
            error: {
                code: 'openclaw_network',
                message: err.message,
                retryable: true
            }
        }
    if (kind === 'headers')
        return {
            type: 'error',
            error: {
                code: 'openclaw_no_response',
                message: `openclaw did not return response headers within ${budgets.headersTimeoutMs / 1000}s — gateway is busy installing plugins or upstream is unreachable`,
                retryable: true
            }
        }
    if (kind === 'stream_idle')
        return {
            type: 'error',
            error: {
                code: 'openclaw_stream_stall',
                message: `openclaw stream went silent for ${Math.round(silentForMs / 1000)}s (inactivity budget ${budgets.idleTimeoutMs / 1000}s) — upstream model or gateway is stuck`,
                retryable: true
            }
        }
    // Not retryable: the turn was still producing output and was stopped by a
    // configured ceiling, so an identical retry burns the same budget again.
    // Raising the admin chat exec max timeout is the actual remedy.
    return {
        type: 'error',
        error: {
            code: 'openclaw_turn_timeout',
            message: `openclaw turn was still streaming when it hit its ${budgets.maxDurationMs / 1000}s maximum duration — raise the chat exec max timeout if turns legitimately run this long`,
            retryable: false
        }
    }
}
