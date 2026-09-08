import {
    DAEMON_FEATURE_TURN_OPENCLAW,
    DAEMON_FEATURE_TURN_OPENCLAW_ACP,
    DEFAULT_CHAT_EXEC_TIMEOUTS,
    acpEventsFromFrame,
    agentBaseUrl,
    decodeOpenclawTurnUsage,
    resolveChatExecTimeoutMs
} from '@manyfold/shared'
import type {
    AgentFramework,
    ChatAttachmentBlock,
    ChatCapabilities,
    ChatMessage,
    ChatUsage,
    DaemonOpenclawTurnPayload,
    DaemonOpenclawAcpTurnPayload,
    OpenclawCredentialsInput,
    OpenclawTurnUsage,
    OpenclawTurnUsageDecode
} from '@manyfold/shared'
import { randomUUID } from 'node:crypto'
import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import { agents, agentCredentials, type Database } from '@manyfold/db'
import { buildOpenAiUsage, type OpenAIUsage } from './openai-usage'
import type { ExecStreamHandle } from './exec-driver'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { UsagePricingService } from '@/modules/usage/usage-pricing.service'
import { ChatRepository } from '@/modules/chat/chat.repository'
import {
    ExecDriverFactory,
    type ExecDriverHandle
} from '@/modules/chat/adapters/exec-driver-factory'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { DaemonFencedDispatchService } from './daemon-fenced-dispatch.service'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { HermesPermissionCoordinator } from '@/modules/chat/hermes-permission-coordinator'
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
import { messageToPromptText } from './message-content'
import {
    AcpTurn,
    type AcpEvent,
    type AcpRequestTimeouts
} from './hermes-acp-client'
import { OPENCLAW_ACP_DIALECT } from '@manyfold/shared'
import { parseOpenclawJsonOutput } from './openclaw-json-parser'
import { manyfoldProviderToNarraNexusChannelProvider } from '@/modules/narranexus/narranexus-paths'
import { classifyManagedChannelFailureSignal } from '@/modules/chat/managed-channel-failure-signal'

const OPENCLAW_HISTORY_BUDGET = 30
// Legacy single budget. It is NO LONGER a deadline over a live stream — it is
// the exec budget of the `openclaw agent --json` daemon-spawn path and the
// default for the two split streaming budgets below, so an operator who
// already tuned it keeps the same tolerance.
const OPENCLAW_FETCH_TIMEOUT_MS = Math.max(
    1_000,
    Number(process.env.OPENCLAW_FETCH_TIMEOUT_MS ?? 240_000)
)
// #513: one AbortSignal.timeout used to cover headers AND the entire SSE read
// loop, so a tool-heavy turn that was still emitting events every few seconds
// was killed at the absolute 240s mark and mislabelled `openclaw_stream_stall`
// ("went silent"). The connect phase and the silence detector are now separate
// budgets, and the idle one restarts on every body chunk.
const OPENCLAW_HEADERS_TIMEOUT_MS = Math.max(
    1_000,
    Number(process.env.OPENCLAW_HEADERS_TIMEOUT_MS ?? OPENCLAW_FETCH_TIMEOUT_MS)
)
const OPENCLAW_STREAM_IDLE_TIMEOUT_MS = Math.max(
    1_000,
    Number(
        process.env.OPENCLAW_STREAM_IDLE_TIMEOUT_MS ?? OPENCLAW_FETCH_TIMEOUT_MS
    )
)
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
const OPENCLAW_CLI_PARSER_NAME = 'openclaw-cli-json'
const OPENCLAW_CLI_PARSER_VERSION = '1'

// Gates the runner-owned transport (turn.start) AND its resume. Read per call
// so drills and tests can flip it without a process restart. Off until the
// staging drill proves recovery end to end; the per-daemon capability check
// keeps it a no-op against CLIs that predate the RPC either way.
const openclawTurnRpcEnabled = (): boolean =>
    ['1', 'true', 'yes'].includes(
        (process.env.MF_OPENCLAW_TURN_RPC ?? '').toLowerCase()
    )

// Gates the API-driven ACP transport (openclaw acp over interactive exec) on
// the sprites-no-runner and k8s cells. Read per call so a drill can flip it
// without a restart. Off by default: the gateway-http path stays the shipped
// behaviour until the ACP soak proves out (ADR-0027).
const openclawAcpEnabled = (): boolean =>
    ['1', 'true', 'yes'].includes(
        (process.env.MF_OPENCLAW_ACP ?? '').toLowerCase()
    )

// `openclaw acp` is a bridge to the resident gateway that runs INSIDE the
// sprite/pod, so it connects over loopback — never the public ingress (which
// device-pairs and proxy-attributes as of 2026.8.1). The gateway is resolved
// from the box's own ~/.openclaw/openclaw.json (gateway.port + auth.token, the
// file Manyfold writes at bootstrap) rather than passed as `--url`: measured on
// openclaw@2026.5.18 [2026-09-08], an explicit --url is treated as a REMOTE
// override that refuses env/config credentials ("gateway url override requires
// explicit credentials"), so against the token-auth gateway every sprite and
// pod runs, `--url ws://127.0.0.1:18789` + OPENCLAW_GATEWAY_TOKEN was rejected
// with token_missing while the url-less form connected (config or env token).
const OPENCLAW_ACP_ARGS = ['acp', '--no-prefix-cwd']

// The bridge is exec'd with its stdin fed through `cat`, and the shell that
// became the bridge is SIGTERMed the moment `cat` sees EOF. Measured on
// openclaw@2026.5.18 [2026-09-08]: `openclaw acp` ignores stdin EOF (still
// running 10 s later), so a bare bridge would burn the ACP client's whole close
// grace on every turn and, on k8s — where abort only closes the exec stream —
// outlive the turn inside the pod. SIGTERM exits it in ~100 ms; the launcher
// shim forwards the signal to the process it respawns, so no orphan is left.
const OPENCLAW_ACP_BRIDGE_SCRIPT = `exec openclaw ${OPENCLAW_ACP_ARGS.join(' ')} < <(cat; kill -TERM $$)`

// The exec command for an openclaw ACP turn. In `dontAsk` with no model pick
// there is nothing to set — the bridge runs directly. Otherwise the session's
// exec-approval level / model is pre-patched over the loopback gateway BEFORE
// the bridge starts, then `exec` hands off. Verified against openclaw@2026.5.18
// [2026-09-07]: sessions.patch UPSERTS the (deterministic) key, so the level
// applies from this turn; `openclaw gateway call` runs in-box over loopback with
// the gateway token, so it needs no device pairing (the off-box ingress would).
const openclawAcpCmd = (opts: {
    sessionKey: string
    execAsk: string | null
    model: string | null
}): string[] => {
    if (!opts.execAsk && !opts.model)
        return ['bash', '-lc', OPENCLAW_ACP_BRIDGE_SCRIPT]
    const patchParams: Record<string, unknown> = { key: opts.sessionKey }
    // The gateway registers each catalog model under the `primary` provider, so
    // a pick routes as `primary/<model>`. Probe-verified [2026-09-07] to change
    // a live session's model from the next prompt and stick to the key.
    if (opts.model) patchParams.model = `primary/${opts.model}`
    if (opts.execAsk) patchParams.execAsk = opts.execAsk
    const params = JSON.stringify(patchParams)
    const patch = `openclaw gateway call sessions.patch --params '${params}' >/dev/null 2>&1 || true`
    return ['bash', '-lc', `${patch}; ${OPENCLAW_ACP_BRIDGE_SCRIPT}`]
}

// A one-shot in-box gateway RPC (the CLI speaks to the loopback gateway with
// its token). `--json` makes stdout the bare result object.
const openclawGatewayCallCmd = (
    method: string,
    params: Record<string, unknown>
): string[] => [
    'openclaw',
    'gateway',
    'call',
    method,
    '--params',
    JSON.stringify(params),
    '--json',
    '--timeout',
    '10000'
]

// How many recent transcript messages the post-turn usage read-back asks for.
// The turn's own user message must be inside the window to anchor the sum; a
// full window with no anchor means a longer tool loop, so it is retried once at
// the wide limit rather than paying that payload on every turn.
const OPENCLAW_USAGE_WINDOW = 60
const OPENCLAW_USAGE_WINDOW_WIDE = 400
const OPENCLAW_USAGE_CALL_TIMEOUT_MS = 20_000
// Deny-on-timeout deadline the daemon runner applies to an unanswered ACP
// permission ask. Kept in step with hermes so a card behaves the same on either
// framework.
const OPENCLAW_PERMISSION_TIMEOUT_MS = Math.max(
    10_000,
    Number(process.env.OPENCLAW_PERMISSION_TIMEOUT_MS ?? 300_000)
)
// Distinct parser namespace + ordinal keys from the SSE/CLI decoders so the
// durable raw_source rows are self-describing and versioned independently.
const OPENCLAW_ACP_PARSER_NAME = 'openclaw-acp'
const OPENCLAW_ACP_PARSER_VERSION = '1'

// The gateway session key that pins cross-turn continuity. Measured against
// openclaw@2026.5.18 [2026-09-07]: history survives a bridge restart when a new
// session/new carries the SAME _meta.sessionKey — the ACP sessionId itself is
// disposable — so this deterministic key IS the session identity, and the API
// never calls session/resume.
const openclawGatewaySessionKey = (internalId: string, sessionId: string): string =>
    `agent:${internalId || 'main'}:mf-${sessionId}`

// One ACP event -> the durable raw_source row plus its semantic event, mirroring
// the SSE path's shape so the renderer treats an ACP turn like any other.
function* openclawAcpEventToChatEvents(
    ev: AcpEvent,
    ctx: ApiChatAdapterContext,
    sourceSeq: number
): IterableIterator<EmittedChatEvent> {
    yield {
        type: 'raw_source',
        source: {
            sourceRef: ctx.frameworkSessionRef,
            sourceSeq,
            externalId: `openclaw-acp-${sourceSeq}`,
            parentExternalId: null,
            rawFormat: 'json',
            rawJson: ev as unknown as Record<string, unknown>,
            parserName: OPENCLAW_ACP_PARSER_NAME,
            parserVersion: OPENCLAW_ACP_PARSER_VERSION
        }
    } as EmittedChatEvent
    switch (ev.type) {
        case 'text':
            if (ev.text) yield { type: 'token', text: ev.text }
            break
        case 'thinking':
            if (ev.text) yield { type: 'thinking', text: ev.text }
            break
        case 'tool_call':
            yield {
                type: 'tool_call',
                toolCallId: ev.toolCallId,
                toolName: ev.toolName,
                args: ev.input ?? {}
            }
            break
        case 'tool_result':
            yield {
                type: 'tool_result',
                toolCallId: ev.toolCallId,
                result: ev.result
            }
            break
        case 'permission_request':
            yield {
                type: 'permission_request',
                requestId: ev.requestId,
                toolCallId: ev.toolCallId,
                title: ev.title,
                detail: ev.detail,
                options: ev.options
            }
            break
        case 'permission_resolution':
            yield {
                type: 'permission_resolution',
                requestId: ev.requestId,
                outcome: ev.outcome,
                optionId: ev.optionId
            }
            break
        default:
            break
    }
}

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

interface OpenclawRuntime {
    ingressHost: string
    gatewayToken: string
    modelId: string
    displayModel: string | null
}

// Which budget fired. Named separately from the error codes because the
// runner-carried path reports the same three kinds back over RPC.
type OpenclawTimeoutKind = 'headers' | 'stream_idle' | 'max_duration'

interface OpenclawStreamBudgets {
    headersTimeoutMs: number
    idleTimeoutMs: number
    maxDurationMs: number
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

@Injectable()
export class OpenclawAdapter implements ApiChatAdapter {
    readonly framework: AgentFramework = 'openclaw'
    private readonly logger = new Logger(OpenclawAdapter.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly crypto: CryptoService,
        private readonly pricing: UsagePricingService,
        private readonly chatRepo: ChatRepository,
        private readonly drivers: ExecDriverFactory,
        private readonly telemetry: TelemetryService,
        // Appended LAST and @Optional: positional test construction passes
        // six args, and an unresolvable constructor dep takes the whole app
        // down at boot (2026-07-25). Without it the adapter simply never
        // chooses the turn.start transport.
        @Optional() private readonly daemonRegistry?: DaemonRegistryService,
        // Same rule — appended after daemonRegistry so existing positional
        // construction keeps working. Absent, the turn falls back to the same
        // DEFAULT_CHAT_EXEC_TIMEOUTS cap the admin setting ships with.
        @Optional() private readonly adminSettings?: AdminSettingsService,
        // Same rule. Absent, turn.start dispatches unfenced as before (#619).
        @Optional()
        private readonly fencedDispatch?: DaemonFencedDispatchService,
        // Same rule — appended last. The permission coordinator is
        // framework-agnostic (keyed by messageId); absent, an ask-mode turn
        // still surfaces the request as a stream event but cannot take the
        // answer back, so it degrades to auto-approve.
        @Optional()
        private readonly permissionCoordinator?: HermesPermissionCoordinator
    ) {}

    getCapabilities(): ChatCapabilities {
        return {
            streaming: true,
            toolCalls: true,
            thinking: false,
            attachments: true,
            multiTurn: true
        }
    }

    // Overridable per framework — narranexus cold wake includes app boot and
    // needs a longer preflight budget.
    protected preflightBudgetMs(): number {
        return OPENCLAW_PREFLIGHT_BUDGET_MS
    }

    // The wall-clock cap is the ADMIN chat exec budget (default 2h), not a
    // per-adapter constant: it is the same knob that stops a wedged CLI turn
    // from holding the turn lock and billing the sprite, and an openclaw turn
    // costs exactly the same. Only the two streaming budgets are openclaw's own.
    private async streamBudgets(): Promise<OpenclawStreamBudgets> {
        const execTimeouts = this.adminSettings
            ? await this.adminSettings.getCachedChatExecTimeoutMs()
            : resolveChatExecTimeoutMs(DEFAULT_CHAT_EXEC_TIMEOUTS)
        return {
            headersTimeoutMs: OPENCLAW_HEADERS_TIMEOUT_MS,
            idleTimeoutMs: OPENCLAW_STREAM_IDLE_TIMEOUT_MS,
            maxDurationMs: execTimeouts.timeoutMs
        }
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

        if (agentRow.runtime === 'daemon') {
            // BYOD daemon over ACP (ADR-0027, O6): the daemon drives `openclaw
            // acp` against the host's OWN gateway. Guarded on framework so
            // narranexus keeps gateway-http, on the flag, on a resolvable
            // daemon, and on the daemon advertising the capability — otherwise
            // fall back to the legacy `openclaw agent --local --json` spawn.
            if (
                this.framework === 'openclaw' &&
                openclawAcpEnabled() &&
                agentRow.daemonId &&
                this.daemonRegistry &&
                (await this.daemonSupportsOpenclawAcp(agentRow.daemonId))
            ) {
                yield* this.sendViaDaemonAcp(
                    ctx,
                    userMessage,
                    agentRow.internalId,
                    agentRow.daemonId
                )
                return
            }
            yield* this.sendViaDaemonSpawn(ctx, userMessage)
            return
        }

        const runtime = await this.resolveRuntime(ctx.agentId)
        // With MF_OPENCLAW_ACP on, the ACP path is the openclaw transport — it
        // is the only one that can carry a per-message model switch (via an
        // in-box sessions.patch on the stateful session) or an interactive
        // permission card, because the gateway-http/turn-rpc `model` field is
        // only an agent router (`openclaw`/`openclaw/<agentId>`; a provider
        // model there is rejected 400). So ACP takes precedence over the
        // runner turn-rpc transport when the flag is on. Guarded on framework
        // so narranexus (super.sendMessage) always keeps gateway-http.
        // Seen on staging [2026-09-08]: with MF_SPRITE_RUNNER_AGENTS='*' the
        // runner turn-rpc path shadowed ACP, so model switching silently did
        // nothing (and a body-model workaround 400'd) until this flip.
        const viaAcp = this.framework === 'openclaw' && openclawAcpEnabled()
        // A runner-carried sprite turn moves the SSE socket INSIDE the sprite
        // (turn.start), holding it in a process that outlives the API so the
        // turn is recoverable — the pre-ACP transport, used only when ACP is
        // off (ACP is client-driven and non-resumable by construction).
        const viaTurnRpc =
            !viaAcp &&
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
                : viaAcp
                  ? this.sendViaOpenclawAcp(ctx, userMessage, runtime, agentRow.internalId)
                  : this.sendOpenAiCompat(ctx, userMessage, runtime)
            for await (const ev of source) {
                if (ev.type === 'done') succeeded = true
                if (ev.type === 'error') succeeded = false
                yield ev
            }
        } finally {
            // The ACP path persists its own (deterministic) gateway key, so
            // skip the legacy FS scan for it.
            if (succeeded && !ctx.frameworkSessionRef && !viaAcp) {
                await this.backfillSessionRefFromFs(ctx).catch((err) => {
                    this.logger.warn(
                        `openclaw ref backfill failed for ${ctx.sessionId}: ${(err as Error).message}`
                    )
                })
            }
        }
    }

    // Whether this daemon can run an openclaw turn over ACP (turn.openclaw.acp).
    // A lookup failure is treated as "no" and falls back to the CLI spawn — the
    // same conservative posture daemonSupportsTurnRpc takes.
    private async daemonSupportsOpenclawAcp(daemonId: string): Promise<boolean> {
        try {
            return await daemonAdvertisesFeature(
                this.db,
                daemonId,
                DAEMON_FEATURE_TURN_OPENCLAW_ACP
            )
        } catch (err) {
            this.logger.warn(
                `turn.openclaw.acp capability lookup failed for ${daemonId}: ${(err as Error).message} — using the CLI spawn transport`
            )
            return false
        }
    }

    // BYOD daemon over ACP (O6): dispatch a turn.start carrying the ACP payload
    // and decode the daemon's replayed ACP frames. The daemon is the ACP
    // client against the host's own gateway; the API only reads the stream,
    // live or replayed (exec.resume), so its restarts are invisible to the
    // turn — the same recovery contract hermes has.
    private async *sendViaDaemonAcp(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage,
        internalId: string,
        daemonId: string
    ): AsyncIterable<EmittedChatEvent> {
        if (ctx.abortSignal?.aborted) {
            yield cancelledEvent()
            return
        }
        const sessionKey = openclawGatewaySessionKey(internalId, ctx.sessionId)
        const permissionMode = ctx.openclawPermissionMode ?? 'dontAsk'
        const patch: { execAsk?: string; model?: string } = {}
        // 'default' turns exec approval on; the enum is the probe-verified
        // posture. A per-message model pick routes as primary/<model>.
        if (permissionMode === 'default') patch.execAsk = 'on-miss'
        if (ctx.modelOverride) patch.model = `primary/${ctx.modelOverride}`
        const budgets = await this.streamBudgets()
        const payload: DaemonOpenclawAcpTurnPayload = {
            framework: 'openclaw',
            transport: 'acp',
            prompt: messageToPromptText(userMessage),
            sessionKey,
            ...(patch.execAsk || patch.model ? { patch } : {}),
            permissionMode,
            ...(permissionMode === 'default'
                ? { permissionTimeoutMs: OPENCLAW_PERMISSION_TIMEOUT_MS }
                : {}),
            idleTimeoutMs: budgets.idleTimeoutMs,
            maxDurationMs: budgets.maxDurationMs
        }
        yield* this.drainOpenclawAcpTurnStream(ctx, {
            daemonId,
            execRef: ctx.messageId,
            sessionKey,
            rpc: {
                method: 'turn.start',
                payload: payload as unknown as Record<string, unknown>,
                timeoutMs: budgets.maxDurationMs + 10_000,
                refIdOverride: ctx.messageId
            }
        })
    }

    // One drain for a live turn.start ACP stream and its exec.resume replay, so
    // a recovered daemon ACP turn decodes through exactly this code. Frames are
    // the daemon's stdout verbatim (one ACP JSON-RPC frame per line); the final
    // carries the stopReason (completion evidence) and the usage the runner
    // read back from the gateway transcript.
    private async *drainOpenclawAcpTurnStream(
        ctx: ApiChatAdapterContext,
        args: {
            daemonId: string
            execRef: string
            sessionKey: string
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
                    code: 'openclaw_daemon_acp_failed',
                    message: 'daemon registry unavailable',
                    retryable: true
                }
            }
            return
        }
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
        const consume = function* (
            this: OpenclawAdapter
        ): IterableIterator<EmittedChatEvent> {
            for (const chunk of chunks.splice(0, chunks.length)) {
                lineBuf += chunk
                let nl = lineBuf.indexOf('\n')
                while (nl !== -1) {
                    const line = lineBuf.slice(0, nl).trim()
                    lineBuf = lineBuf.slice(nl + 1)
                    nl = lineBuf.indexOf('\n')
                    if (!line) continue
                    let frame: Record<string, unknown> | null = null
                    try {
                        frame = JSON.parse(line) as Record<string, unknown>
                    } catch {
                        continue
                    }
                    for (const ev of acpEventsFromFrame(frame)) {
                        if (ev.type === 'usage_update' || ev.type === 'turn_end')
                            continue
                        if (ev.type === 'error') continue
                        if (ev.type === 'text' && firstTokenAt === null)
                            firstTokenAt = Date.now()
                        seq += 1
                        yield* openclawAcpEventToChatEvents(ev, ctx, seq)
                    }
                }
            }
        }.bind(this)

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
            yield cancelledEvent()
            return
        }
        const rpcError = transportError.current
        if (rpcError) {
            const suspendable =
                args.rpc.method === 'exec.resume'
                    ? isDaemonResumeSuspendError(rpcError)
                    : isDaemonOfflineTransportError(rpcError)
            if (suspendable) {
                this.logger.log(
                    `openclaw acp turn suspended (daemon offline) message=${ctx.messageId}: ${rpcError.message}`
                )
                yield {
                    type: 'suspended',
                    daemonId: args.daemonId,
                    daemonExecRef: args.execRef,
                    reason: rpcError.message
                }
                return
            }
            const managedChannelFailure = classifyManagedChannelFailureSignal({
                message: rpcError.message
            })
            yield {
                type: 'error',
                ...(managedChannelFailure ? { managedChannelFailure } : {}),
                error: {
                    code: 'openclaw_daemon_acp_failed',
                    message: rpcError.message,
                    retryable: true
                }
            }
            return
        }
        const stopReason =
            typeof ackPayload?.['stopReason'] === 'string'
                ? (ackPayload['stopReason'] as string)
                : null
        if (!stopReason) {
            this.logger.warn(
                `openclaw acp daemon turn ended without completion evidence; suspending messageId=${ctx.messageId}`
            )
            yield {
                type: 'suspended',
                daemonId: args.daemonId,
                daemonExecRef: args.execRef,
                reason: 'acp stream ended without stopReason'
            }
            return
        }
        // The runner read the usage back from the gateway transcript (the ACP
        // stream carries none) and put it on the final; a miss is not fatal.
        const turnUsage = ackPayload?.['usage'] as OpenclawTurnUsage | undefined
        if (turnUsage) {
            yield {
                type: 'usage',
                usage: buildOpenAiUsage(
                    {
                        inputTokens: turnUsage.inputTokens,
                        outputTokens: turnUsage.outputTokens,
                        cacheRead: turnUsage.cacheReadTokens,
                        cacheWrite: turnUsage.cacheCreationTokens
                    },
                    turnUsage.model ?? ctx.model ?? 'openclaw',
                    tStart,
                    firstTokenAt,
                    this.pricing,
                    ctx
                )
            }
        }
        if (args.sessionKey && ctx.frameworkSessionRef !== args.sessionKey)
            await this.chatRepo
                .updateFrameworkSessionRef(
                    ctx.sessionId,
                    args.sessionKey,
                    ctx.turnFence
                )
                .catch((err) =>
                    this.logger.warn(
                        `openclaw acp daemon session ref persist failed for ${ctx.sessionId}: ${(err as Error).message}`
                    )
                )
        yield { type: 'done', finalMessageId: ctx.messageId }
    }

    private async *sendViaDaemonSpawn(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage
    ): AsyncIterable<EmittedChatEvent> {
        // sendMessage awaited the agents row to get here, and forAgent below
        // resolves credentials and admission over the network. A signal never
        // replays to a listener registered afterwards, so a cancel that landed
        // in either await was invisible to the teardown registered past the
        // dispatch — and `exec.start` had already put a CLI on the daemon that
        // keeps burning compute and model quota for a turn nobody reads (#402,
        // the same leak as #665).
        if (ctx.abortSignal?.aborted) {
            yield cancelledEvent()
            return
        }
        const handle = await this.drivers.forAgent(ctx.agentId)
        const { driver, agent, runtime } = handle
        if (runtime !== 'daemon')
            throw new Error(
                `expected daemon runtime for openclaw daemon path, got ${runtime}`
            )
        if (ctx.abortSignal?.aborted) {
            yield cancelledEvent()
            return
        }
        const internalId = agent.internalId || 'main'
        const sessionRef = ctx.frameworkSessionRef ?? randomUUID()
        const prompt = messageToPromptText(userMessage)
        const cmd = [
            'openclaw',
            'agent',
            '--local',
            '--json',
            '--session-id',
            sessionRef,
            '--agent',
            internalId,
            '--message',
            prompt
        ]
        const exec = driver.stream({
            cmd,
            timeoutMs: OPENCLAW_FETCH_TIMEOUT_MS,
            ...(ctx.messageId ? { execHandle: ctx.messageId } : {})
        })
        const onAbort = (): void => exec.abort()
        ctx.abortSignal?.addEventListener('abort', onAbort, { once: true })
        // Everything past this point consumes an exec handle and nothing else.
        // resumeMessage feeds it the SAME shape back from exec.resume, so a
        // recovered turn is parsed by exactly this code.
        try {
            yield* this.drainDaemonSpawnStream(exec, ctx, {
                daemonId: agent.daemonId ?? null,
                // Without an execHandle there is no refId for a hello to report, so
                // a suspend would park until the unmatched-turn sweep: fail instead.
                execRef: ctx.messageId ?? null,
                usageFallbackModel: agent.model ?? null
            })
        } finally {
            ctx.abortSignal?.removeEventListener('abort', onAbort)
        }
    }

    // Consume one `openclaw agent --json` exec, whichever RPC produced it.
    // `exec.start` hands over a live child; `exec.resume` replays the same
    // child's buffered stdout and acks with the same exit code, so the two are
    // indistinguishable here — which is what makes a suspended turn finishable
    // instead of merely re-classified (#666).
    private async *drainDaemonSpawnStream(
        handle: ExecStreamHandle,
        ctx: ApiChatAdapterContext,
        opts: {
            daemonId: string | null
            execRef: string | null
            usageFallbackModel: string | null
            resumeAttach?: boolean
        }
    ): AsyncIterable<EmittedChatEvent> {
        const tStart = Date.now()
        let firstTokenAt: number | null = null
        let stdoutBuf = ''
        let stderrBuf = ''
        const stdoutReader = (async (): Promise<void> => {
            for await (const chunk of handle.stdout) stdoutBuf += chunk
        })()
        const stderrReader = (async (): Promise<void> => {
            for await (const chunk of handle.stderr) stderrBuf += chunk
        })()

        let result
        try {
            result = await handle.result
        } catch (err) {
            const failure = err as Error
            if (ctx.abortSignal?.aborted) {
                yield cancelledEvent()
                return
            }
            // #666: this was the last daemon-carrying path still terminalizing
            // a lost socket. The daemon is still running `openclaw agent
            // --json` and its next hello re-reports the stream, but an error
            // event writes a terminal — and a terminal makes the turn invisible
            // to every recovery attempt, so the work is discarded and the user
            // sees a failure a reconnect would have finished. Suspending keeps
            // the inflight lock and leaves the turn findable by (daemon_id,
            // daemon_exec_ref), which is the `execHandle` the exec was
            // dispatched under == ctx.messageId.
            //
            // A resume attach reverses the burden of proof (#570): the hello
            // that got us here already proved the stream exists, so a lookup
            // that finds no socket means the connection died between hello and
            // attach and the next hello reports the same buffer again. On the
            // initial send those same strings still mean nothing ran.
            const suspendable = opts.resumeAttach
                ? isDaemonResumeSuspendError(failure)
                : isDaemonOfflineTransportError(failure)
            if (opts.daemonId && opts.execRef && suspendable) {
                this.logger.log(
                    `openclaw daemon exec suspended (daemon offline) agent=${ctx.agentId} message=${ctx.messageId}: ${failure.message}`
                )
                yield {
                    type: 'suspended',
                    daemonId: opts.daemonId,
                    daemonExecRef: opts.execRef,
                    reason: failure.message
                }
                return
            }
            yield {
                type: 'error',
                error: {
                    code: 'openclaw_daemon_exec_failed',
                    message: failure.message,
                    retryable: true
                }
            }
            return
        }
        await stdoutReader.catch(() => {})
        await stderrReader.catch(() => {})

        if (result.exitCode !== 0) {
            const tail = (stderrBuf || stdoutBuf).slice(-1024)
            yield {
                type: 'error',
                error: {
                    code: 'openclaw_daemon_exit_nonzero',
                    message: `openclaw exited ${result.exitCode}: ${tail || '(no output)'}`,
                    retryable: false
                }
            }
            return
        }

        const parsed = parseOpenclawJsonOutput(stdoutBuf)
        if (parsed.errorMessage) {
            yield {
                type: 'error',
                error: {
                    code: 'openclaw_daemon_event_error',
                    message: parsed.errorMessage,
                    retryable: false
                }
            }
            return
        }

        yield {
            type: 'raw_source',
            source: {
                sourceRef: parsed.sessionId ?? ctx.frameworkSessionRef,
                sourceSeq: 1,
                externalId: `${opts.execRef ?? ctx.messageId}-stdout`,
                parentExternalId: null,
                rawFormat: 'jsonl',
                rawText: stdoutBuf,
                parserName: OPENCLAW_CLI_PARSER_NAME,
                parserVersion: OPENCLAW_CLI_PARSER_VERSION
            }
        }

        const answerText = parsed.texts.join('')
        if (answerText) {
            if (firstTokenAt === null) firstTokenAt = Date.now()
            yield { type: 'token', text: answerText }
        }
        for (const [index, t] of parsed.toolUses.entries()) {
            yield {
                type: 'tool_call',
                toolCallId:
                    t.callId ??
                    `${opts.execRef ?? ctx.messageId}-tool-${index + 1}`,
                toolName: t.tool || 'tool',
                args: t.input ?? {}
            }
        }
        if (parsed.usage) {
            const modelLabel =
                parsed.model ??
                ctx.model ??
                opts.usageFallbackModel ??
                'openclaw'
            const usage = buildOpenAiUsage(
                parsed.usage,
                modelLabel,
                tStart,
                firstTokenAt,
                this.pricing,
                ctx
            )
            yield { type: 'usage', usage }
        }
        if (parsed.sessionId && !ctx.frameworkSessionRef) {
            await this.chatRepo
                .updateFrameworkSessionRef(
                    ctx.sessionId,
                    parsed.sessionId,
                    ctx.turnFence
                )
                .catch((err) =>
                    this.logger.warn(
                        `openclaw daemon ref persist failed for ${ctx.sessionId}: ${(err as Error).message}`
                    )
                )
        }
        yield { type: 'done', finalMessageId: ctx.messageId }
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

    // API-driven ACP for the sprites-no-runner and k8s cells: the API drives
    // `openclaw acp` (a bridge to the resident gateway) over an interactive
    // exec, exactly like hermes's sendViaInteractiveAcp. Non-resumable by
    // construction — ACP is client-driven, so a lost API loses the turn — and
    // every failure is a retryable error, never `suspended`. Simpler than
    // hermes: openclaw's model is per-agent (no set_model) and its permission
    // lever is a gateway-side execAsk, so this path only runs the turn.
    private async *sendViaOpenclawAcp(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage,
        runtime: OpenclawRuntime,
        internalId: string
    ): AsyncIterable<EmittedChatEvent> {
        if (ctx.abortSignal?.aborted) {
            yield cancelledEvent()
            return
        }
        let handle
        try {
            handle = await this.drivers.forAgent(ctx.agentId)
        } catch (err) {
            yield {
                type: 'error',
                error: {
                    code: 'openclaw_acp_failed',
                    message: (err as Error).message,
                    retryable: true
                }
            }
            return
        }
        const streamInteractive = handle.driver.streamInteractive?.bind(
            handle.driver
        )
        if (!streamInteractive) {
            yield {
                type: 'error',
                error: {
                    code: 'openclaw_acp_failed',
                    message: `runtime ${handle.runtime} has no interactive exec transport`,
                    retryable: false
                }
            }
            return
        }
        const budgets = await this.streamBudgets()
        const acpBudgets: AcpRequestTimeouts = {
            idleTimeoutMs: budgets.idleTimeoutMs,
            maxDurationMs: budgets.maxDurationMs
        }
        const cwd = handle.agent.workspacePath ?? null
        const prompt = messageToPromptText(userMessage)
        const sessionKey = openclawGatewaySessionKey(internalId, ctx.sessionId)
        // `default` turns exec approval on for this session; `dontAsk` (the
        // default) leaves the gateway's shipped tools.exec.ask:'off', so nothing
        // is patched and nothing prompts — byte-for-byte today's behaviour.
        const permissionMode = ctx.openclawPermissionMode ?? 'dontAsk'
        const interactive = permissionMode === 'default'
        // 'on-miss' asks for out-of-allowlist commands (the "ask about risky
        // things" posture). The patch mechanism and the approval round-trip are
        // probe-verified; the exact enum is a tunable posture.
        const execAsk = interactive ? 'on-miss' : null
        // The per-message model pick, applied via the same in-box patch. Null
        // (the common case) leaves the session on its current/default model.
        const modelOverride = ctx.modelOverride

        if (ctx.abortSignal?.aborted) {
            yield cancelledEvent()
            return
        }

        const tStart = Date.now()
        const queue: AcpEvent[] = []
        const waker: { resolve: (() => void) | null } = { resolve: null }
        const wake = (): void => {
            const r = waker.resolve
            waker.resolve = null
            if (r) r()
        }
        const transport = streamInteractive({
            cmd: openclawAcpCmd({ sessionKey, execAsk, model: modelOverride }),
            env: {
                // The bridge authenticates to the loopback gateway with its own
                // token; the model call happens inside that gateway, which
                // already holds the provider key, so no alias env rides here.
                OPENCLAW_GATEWAY_TOKEN: runtime.gatewayToken,
                OPENCLAW_HIDE_BANNER: '1',
                OPENCLAW_SUPPRESS_NOTES: '1'
            },
            ...(cwd ? { dir: cwd } : {}),
            timeoutMs: acpBudgets.maxDurationMs,
            keepAliveMs: budgets.headersTimeoutMs
        })
        const turn = new AcpTurn({
            transport,
            onEvent: (ev) => {
                queue.push(ev)
                wake()
            },
            dialect: OPENCLAW_ACP_DIALECT,
            sessionKey,
            logger: this.logger,
            permissionPolicy: interactive ? 'interactive' : 'auto'
        })
        const unregisterPermissions =
            interactive && this.permissionCoordinator
                ? this.permissionCoordinator.register(ctx.messageId, {
                      respond: (requestId, optionId) =>
                          turn.respondPermission(requestId, optionId),
                      pendingIds: () => turn.pendingPermissionIds
                  })
                : null

        const state = { finished: false, aborted: false }
        const onAbort = (): void => {
            state.aborted = true
            turn.abort()
            wake()
        }
        ctx.abortSignal?.addEventListener('abort', onAbort, { once: true })

        const seq = { current: 0 }
        const fatal = { yielded: false }
        const firstToken: { at: number | null } = { at: null }
        const drainQueue = function* (
            this: OpenclawAdapter
        ): IterableIterator<EmittedChatEvent> {
            while (queue.length > 0) {
                const ev = queue.shift()!
                if (ev.type === 'error') {
                    if (fatal.yielded) continue
                    const managedChannelFailure =
                        classifyManagedChannelFailureSignal({
                            message: ev.detail ?? ev.message
                        })
                    yield {
                        type: 'error',
                        ...(managedChannelFailure ? { managedChannelFailure } : {}),
                        error: {
                            code: 'openclaw_acp_event',
                            message: ev.message,
                            retryable: managedChannelFailure !== null
                        }
                    }
                    fatal.yielded = true
                    state.aborted = true
                    turn.abort()
                    return
                }
                if (ev.type === 'usage_update' || ev.type === 'turn_end')
                    continue
                if (ev.type === 'text' && firstToken.at === null)
                    firstToken.at = Date.now()
                seq.current += 1
                yield* openclawAcpEventToChatEvents(ev, ctx, seq.current)
            }
        }.bind(this)

        const errorRef: { current: Error | null } = { current: null }
        const promptDone = (async (): Promise<void> => {
            try {
                await turn.initialize(30_000)
                // Continuity is the gateway session's, keyed by _meta.sessionKey
                // — the ACP sessionId is disposable — so every turn is a fresh
                // session/new on the same key. No session/resume.
                await turn.newSession({ cwd: cwd ?? '.', timeoutMs: 30_000 })
                await turn.prompt({ prompt, timeouts: acpBudgets })
            } finally {
                state.finished = true
                wake()
            }
        })()
        promptDone.catch((err) => {
            errorRef.current = err as Error
        })

        // The ACP stream carries no token usage, so a clean turn reads its
        // usage back from the gateway transcript. Started before close() so
        // the CLI round trip overlaps the bridge teardown instead of adding to
        // the tail the user waits through.
        let usageFetch: Promise<ChatUsage | null> | null = null
        try {
            while (!state.finished || queue.length > 0) {
                if (queue.length === 0)
                    await new Promise<void>((resolve) => {
                        waker.resolve = resolve
                    })
                for (const ev of drainQueue()) yield ev
                if (state.aborted) break
            }
            // Settle the prompt chain first: its rejection handler may still be
            // a microtask behind the last drained event.
            await promptDone.catch(() => undefined)
            if (!fatal.yielded && !state.aborted && !errorRef.current)
                usageFetch = this.fetchOpenclawAcpUsage({
                    handle,
                    runtime,
                    sessionKey,
                    promptText: prompt,
                    ctx,
                    tStart,
                    firstTokenAt: firstToken.at
                })
        } finally {
            await turn.close().catch(() => {})
            unregisterPermissions?.()
            ctx.abortSignal?.removeEventListener('abort', onAbort)
        }

        if (fatal.yielded) {
            yield { type: 'done', finalMessageId: ctx.messageId }
            return
        }
        if (state.aborted) {
            yield cancelledEvent()
            return
        }
        const runError = errorRef.current
        if (runError) {
            const managedChannelFailure = classifyManagedChannelFailureSignal({
                message: runError.message
            })
            yield {
                type: 'error',
                ...(managedChannelFailure ? { managedChannelFailure } : {}),
                error: {
                    code: 'openclaw_acp_failed',
                    message: runError.message,
                    retryable: true
                }
            }
            return
        }
        const usage = usageFetch ? await usageFetch : null
        if (usage) yield { type: 'usage', usage }
        // Persist the deterministic gateway key so the next turn skips the
        // legacy FS backfill and knows a session exists.
        if (ctx.frameworkSessionRef !== sessionKey)
            await this.chatRepo
                .updateFrameworkSessionRef(ctx.sessionId, sessionKey, ctx.turnFence)
                .catch((err) =>
                    this.logger.warn(
                        `openclaw acp session ref persist failed for ${ctx.sessionId}: ${(err as Error).message}`
                    )
                )
        yield { type: 'done', finalMessageId: ctx.messageId }
    }

    // Post-turn billing for the ACP path: one in-box `sessions.get` on the
    // turn's key, summed by the shared decoder. A miss is logged and counted,
    // never fatal — the user already has the answer, and failing the turn after
    // the fact would hide the billing gap behind a retry rather than measure it.
    private async fetchOpenclawAcpUsage(args: {
        handle: ExecDriverHandle
        runtime: OpenclawRuntime
        sessionKey: string
        promptText: string
        ctx: ApiChatAdapterContext
        tStart: number
        firstTokenAt: number | null
    }): Promise<ChatUsage | null> {
        const t0 = Date.now()
        const outcome = (
            status: string,
            extra: Record<string, string | number> = {}
        ): void => {
            this.telemetry.event('openclaw_acp_usage', {
                'nca.agent_id': args.ctx.agentId,
                'nca.session_id': args.ctx.sessionId,
                'nca.outcome': status,
                'nca.duration_ms': Date.now() - t0,
                ...extra
            })
        }
        try {
            let decoded = await this.readOpenclawTurnUsage(
                args,
                OPENCLAW_USAGE_WINDOW
            )
            if (decoded.status === 'no_user_message' && decoded.windowFull)
                decoded = await this.readOpenclawTurnUsage(
                    args,
                    OPENCLAW_USAGE_WINDOW_WIDE
                )
            if (decoded.status !== 'ok') {
                this.logger.warn(
                    `openclaw acp usage unavailable for ${args.ctx.sessionId}: ${decoded.status}`
                )
                outcome(decoded.status)
                return null
            }
            const { usage } = decoded
            outcome('ok', { 'nca.provider_calls': usage.calls })
            return buildOpenAiUsage(
                {
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    cacheRead: usage.cacheReadTokens,
                    cacheWrite: usage.cacheCreationTokens
                },
                usage.model ??
                    args.ctx.model ??
                    args.runtime.displayModel ??
                    args.runtime.modelId,
                args.tStart,
                args.firstTokenAt,
                this.pricing,
                args.ctx
            )
        } catch (err) {
            const message = (err as Error).message
            this.logger.warn(
                `openclaw acp usage read-back failed for ${args.ctx.sessionId}: ${message}`
            )
            outcome('error', { 'nca.error_message': message })
            return null
        }
    }

    private async readOpenclawTurnUsage(
        args: {
            handle: ExecDriverHandle
            runtime: OpenclawRuntime
            sessionKey: string
            promptText: string
        },
        limit: number
    ): Promise<OpenclawTurnUsageDecode> {
        const exec = args.handle.driver.stream({
            cmd: openclawGatewayCallCmd('sessions.get', {
                key: args.sessionKey,
                limit
            }),
            env: {
                OPENCLAW_GATEWAY_TOKEN: args.runtime.gatewayToken,
                OPENCLAW_HIDE_BANNER: '1',
                OPENCLAW_SUPPRESS_NOTES: '1'
            },
            timeoutMs: OPENCLAW_USAGE_CALL_TIMEOUT_MS
        })
        const collect = async (
            chunks: AsyncIterable<string>
        ): Promise<string> => {
            let out = ''
            for await (const chunk of chunks) out += chunk
            return out
        }
        const [stdout, stderr] = await Promise.all([
            collect(exec.stdout),
            collect(exec.stderr)
        ])
        const result = await exec.result
        if (result.exitCode !== 0)
            throw new Error(
                `openclaw gateway call sessions.get exited ${result.exitCode}: ${(stderr || stdout).trim().slice(0, 300)}`
            )
        const start = stdout.indexOf('{')
        const end = stdout.lastIndexOf('}')
        if (start === -1 || end <= start)
            throw new Error(
                'openclaw gateway call sessions.get returned no JSON object'
            )
        let parsed: unknown
        try {
            parsed = JSON.parse(stdout.slice(start, end + 1))
        } catch (err) {
            throw new Error(
                `openclaw gateway call sessions.get returned unparsable JSON: ${(err as Error).message}`
            )
        }
        return decodeOpenclawTurnUsage(parsed, args.promptText, { limit })
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

    // Recover a turn from the buffer of the daemon that carried it. Two buffer
    // shapes, one entry point: a runner-carried SPRITE turn replays as SSE
    // deltas through the turn stream, and a daemon-runtime turn replays as
    // `openclaw agent --json` CLI stdout through the exec drain that produced
    // it. Both converge the message they suspended as; neither re-runs anything.
    async *resumeMessage(
        ctx: ApiChatResumeContext
    ): AsyncIterable<EmittedChatEvent> {
        if (ctx.runtimeKind === 'daemon') {
            // With the flag on, a daemon openclaw turn is an ACP turn.start
            // whose frames the daemon buffered; replay them through the ACP
            // drain. Off, it is the legacy `openclaw agent --json` spawn.
            if (
                openclawAcpEnabled() &&
                ctx.daemonId &&
                ctx.daemonExecRef &&
                this.daemonRegistry
            ) {
                yield* this.drainOpenclawAcpTurnStream(ctx, {
                    daemonId: ctx.daemonId,
                    execRef: ctx.daemonExecRef,
                    sessionKey: ctx.frameworkSessionRef ?? '',
                    rpc: {
                        method: 'exec.resume',
                        payload: {
                            originalRefId: ctx.daemonExecRef,
                            fromSeq: 0
                        },
                        timeoutMs:
                            (await this.streamBudgets()).maxDurationMs + 10_000
                    }
                })
                return
            }
            yield* this.resumeViaDaemonSpawn(ctx)
            return
        }
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

    // The daemon-runtime half of resume (#666). Deliberately ahead of the
    // turn.start gate above: MF_OPENCLAW_TURN_RPC gates the runner-owned
    // transport, not `exec.resume`, and gating this too would leave the suspend
    // this path already emits with nothing to converge it — the turn would be
    // terminalized `openclaw_resume_unsupported` by the very hello that found
    // it. Resolving the driver by the daemon that REPORTED the stream, rather
    // than by the agent's runtime, is what every other framework's resume does.
    private async *resumeViaDaemonSpawn(
        ctx: ApiChatResumeContext
    ): AsyncIterable<EmittedChatEvent> {
        if (!ctx.daemonId || !ctx.daemonExecRef) {
            yield {
                type: 'error',
                error: {
                    code: 'openclaw_resume_unsupported',
                    message:
                        'resume requires a daemon transport with resume support',
                    retryable: false
                }
            }
            return
        }
        if (ctx.abortSignal?.aborted) {
            yield cancelledEvent()
            return
        }
        const driver = this.drivers.daemonDriverFor(ctx.daemonId)
        if (!driver.resumeStream) {
            yield {
                type: 'error',
                error: {
                    code: 'openclaw_resume_unsupported',
                    message:
                        'resume requires a daemon transport with resume support',
                    retryable: false
                }
            }
            return
        }
        const handle = driver.resumeStream({
            refId: ctx.daemonExecRef,
            // fromSeq is 0 BY DESIGN, whatever the cursor ladder computed:
            // `openclaw agent --json` is parsed as ONE buffer (a whole-buffer
            // JSON result, else the NDJSON lines), so a replay that starts
            // mid-stream parses to nothing and would converge an empty answer
            // over a turn that produced one. Safe because this path stamps no
            // runnerSeq on any source row, so the ladder can only ever compute
            // 0 for it. The drain keys every derived row from the stable whole
            // stdout source, so repeated full replays hit durable dedup keys.
            fromSeq: 0,
            // The same budget the dispatch used: a replay is bounded by how
            // long the original exec was allowed to run.
            timeoutMs: OPENCLAW_FETCH_TIMEOUT_MS
        })
        const onAbort = (): void => handle.abort()
        ctx.abortSignal?.addEventListener('abort', onAbort, { once: true })
        try {
            yield* this.drainDaemonSpawnStream(handle, ctx, {
                daemonId: ctx.daemonId,
                execRef: ctx.daemonExecRef,
                // No forAgent lookup on this path — it would decrypt credentials
                // and reserve admission for a turn that is not being re-run — so
                // the agent's default model is not available here. ctx.model is
                // what the turn was dispatched with, and the replayed step_finish
                // carries its own model anyway.
                usageFallbackModel: ctx.model?.trim() || null,
                resumeAttach: true
            })
        } finally {
            ctx.abortSignal?.removeEventListener('abort', onAbort)
        }
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
            // Deliberately still the legacy value: a runner that predates the
            // split reads ONLY this and must keep its old 240s absolute cap
            // rather than silently inherit the multi-hour maxDurationMs. A
            // runner that understands the split ignores it.
            timeoutMs: OPENCLAW_FETCH_TIMEOUT_MS,
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

    private async resolveRuntime(agentId: string): Promise<OpenclawRuntime> {
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

const cancelledEvent = (): EmittedErrorEvent => ({
    type: 'error',
    error: {
        code: 'openclaw_aborted',
        message: 'openclaw turn aborted',
        retryable: false
    }
})

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
