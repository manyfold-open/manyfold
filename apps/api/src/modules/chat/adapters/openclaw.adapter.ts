import {
    DAEMON_FEATURE_TURN_OPENCLAW_ACP,
    acpEventsFromFrame,
    decodeOpenclawTurnUsage
} from '@manyfold/shared'
import type {
    AgentFramework,
    ChatCapabilities,
    ChatMessage,
    ChatUsage,
    DaemonOpenclawAcpTurnPayload,
    OpenclawTurnUsage,
    OpenclawTurnUsageDecode
} from '@manyfold/shared'
import { Inject, Injectable, Optional } from '@nestjs/common'
import { type Database } from '@manyfold/db'
import { buildOpenAiUsage } from './openai-usage'
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
    daemonDetectedFramework,
    isDaemonOfflineTransportError,
    isDaemonResumeSuspendError,
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
import { classifyManagedChannelFailureSignal } from '@/modules/chat/managed-channel-failure-signal'
import {
    GatewayHttpChatAdapter,
    type OpenclawRuntime
} from './gateway-http-chat.adapter'
import { openclawCancelledEvent as cancelledEvent } from './openclaw-turn-shared'

// How stale the heartbeat's gateway probe is, for the refusal message: the
// daemon re-probes on its framework-detect interval, not per turn, so a
// gateway started since the last probe is refused with a retryable error.
const gatewayProbeAge = (checkedAt: string): string => {
    const ms = Date.now() - Date.parse(checkedAt)
    if (!Number.isFinite(ms) || ms < 0) return 'last probed at an unknown time'
    const minutes = Math.round(ms / 60_000)
    if (minutes < 1) return 'probed less than a minute ago'
    return `probed ${minutes}m ago`
}

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
const shellQuoteArg = (value: string): string =>
    `'${value.replace(/'/g, "'\\''")}'`

const openclawAcpCmd = (opts: {
    sessionKey: string
    execAsk: string | null
    model: string | null
    cwd: string | null
}): string[] => {
    // Enter the agent workspace from INSIDE the bridge, never via the exec
    // transport's `dir`: wrapSpriteCommand turns `dir` into `cd <dir> && …`, and
    // a fresh sprite's workspace is created lazily by openclaw (nothing mkdirs
    // it at bootstrap), so that cd runs before openclaw and the shell exits 1.
    // Seen on sprites [2026-09-08]: `cd: /home/sprite/.openclaw/workspace: No
    // such file or directory` → `openclaw acp exited with code 1` before the
    // bridge started. mkdir -p makes it exist; the cd is tolerant because
    // `--no-prefix-cwd` means openclaw resolves its workspace from config.
    const enter = opts.cwd
        ? `mkdir -p ${shellQuoteArg(opts.cwd)} 2>/dev/null; cd ${shellQuoteArg(opts.cwd)} 2>/dev/null; `
        : ''
    const bridge = `${enter}${OPENCLAW_ACP_BRIDGE_SCRIPT}`
    if (!opts.execAsk && !opts.model) return ['bash', '-lc', bridge]
    const patchParams: Record<string, unknown> = { key: opts.sessionKey }
    // The gateway registers each catalog model under the `primary` provider, so
    // a pick routes as `primary/<model>`. Probe-verified [2026-09-07] to change
    // a live session's model from the next prompt and stick to the key.
    if (opts.model) patchParams.model = `primary/${opts.model}`
    if (opts.execAsk) patchParams.execAsk = opts.execAsk
    const params = JSON.stringify(patchParams)
    const patch = `openclaw gateway call sessions.patch --params '${params}' >/dev/null 2>&1 || true`
    return ['bash', '-lc', `${patch}; ${bridge}`]
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
// The Manyfold-provisioned gateway (sprite/k8s, buildOpenclawConfigJson) hosts
// exactly one agent — the default, `main`; a BYOD daemon's gateway defaults to
// `main` too. The manyfold agent id is NOT a gateway agent name, so the session
// binds to `main` and ctx.sessionId keeps the key unique per chat. Verified
// in-sprite [2026-09-08]: `sessions.patch` on `agent:main:…` returns ok:true,
// on `agent:<agentId>:…` fails "Agent <id> no longer exists in configuration"
// (the manyfold id was never registered as a gateway agent).
const openclawGatewaySessionKey = (sessionId: string): string =>
    `agent:main:mf-${sessionId}`

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

@Injectable()
export class OpenclawAdapter extends GatewayHttpChatAdapter {
    readonly framework: AgentFramework = 'openclaw'

    constructor(
        @Inject(DRIZZLE) db: Database,
        crypto: CryptoService,
        pricing: UsagePricingService,
        chatRepo: ChatRepository,
        drivers: ExecDriverFactory,
        telemetry: TelemetryService,
        // Appended LAST and @Optional: positional test construction passes
        // six args, and an unresolvable constructor dep takes the whole app
        // down at boot (2026-07-25). Without it the adapter simply never
        // chooses the turn.start transport.
        @Optional() daemonRegistry?: DaemonRegistryService,
        // Same rule — appended after daemonRegistry so existing positional
        // construction keeps working. Absent, the turn falls back to the same
        // DEFAULT_CHAT_EXEC_TIMEOUTS cap the admin setting ships with.
        @Optional() adminSettings?: AdminSettingsService,
        // Same rule. Absent, turn.start dispatches unfenced as before (#619).
        @Optional()
        fencedDispatch?: DaemonFencedDispatchService,
        // Same rule — appended last. The permission coordinator is
        // framework-agnostic (keyed by messageId); absent, an ask-mode turn
        // still surfaces the request as a stream event but cannot take the
        // answer back, so it degrades to auto-approve.
        @Optional()
        private readonly permissionCoordinator?: HermesPermissionCoordinator
    ) {
        super(
            db,
            crypto,
            pricing,
            chatRepo,
            drivers,
            telemetry,
            daemonRegistry,
            adminSettings,
            fencedDispatch
        )
    }

    getCapabilities(): ChatCapabilities {
        return {
            streaming: true,
            toolCalls: true,
            thinking: false,
            attachments: true,
            multiTurn: true
        }
    }

    // Every openclaw chat turn speaks ACP (ADR-0027): the API drives the
    // `openclaw acp` bridge over an interactive exec on sprites and k8s, and a
    // BYOD daemon drives its own against the host's gateway. The base's
    // OpenAI-compatible transports are narranexus's alone now — an openclaw
    // turn never reaches them, which is why this override never calls super.
    protected async *dispatchTurn(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage,
        agentRow: {
            runtime: string
            internalId: string | null
            daemonId: string | null
        }
    ): AsyncIterable<EmittedChatEvent> {
        if (agentRow.runtime === 'daemon') {
            if (!agentRow.daemonId)
                throw new Error(
                    `daemon openclaw agent ${ctx.agentId} missing daemonId`
                )
            const refusal = await this.daemonAdmissionRefusal(agentRow.daemonId)
            if (refusal) {
                yield refusal
                return
            }
            yield* this.sendViaDaemonAcp(ctx, userMessage, agentRow.daemonId)
            return
        }
        // The ACP path persists its own (deterministic) gateway key, so it
        // never needs the base's legacy FS session-ref backfill.
        const runtime = await this.resolveRuntime(ctx.agentId)
        yield* this.sendViaOpenclawAcp(ctx, userMessage, runtime)
    }

    // Whether this daemon may be sent an openclaw ACP turn, and if not, the
    // error that says so. Two admission gates, both modelled on hermes's
    // `requireTurnHermes` (ADR-0024): a lookup that FAILS is retryable —
    // "couldn't check" must never surface as the non-retryable upgrade demand
    // that a definite `false` produces.
    private async daemonAdmissionRefusal(
        daemonId: string
    ): Promise<EmittedErrorEvent | null> {
        let capable: boolean
        try {
            capable = await daemonAdvertisesFeature(
                this.db,
                daemonId,
                DAEMON_FEATURE_TURN_OPENCLAW_ACP
            )
        } catch (err) {
            return {
                type: 'error',
                error: {
                    code: 'openclaw_daemon_acp_failed',
                    message: `turn.openclaw.acp capability lookup failed: ${(err as Error).message}`,
                    retryable: true
                }
            }
        }
        if (!capable)
            return {
                type: 'error',
                error: {
                    code: 'openclaw_daemon_upgrade_required',
                    message:
                        "this daemon's mf CLI predates the openclaw ACP turn; run `mf update` on the daemon host and restart the daemon",
                    retryable: false
                }
            }
        // The bridge connects to a gateway the daemon only DISCOVERS — it
        // never starts one (ADR-0027, zero host ownership). The heartbeat
        // reports what it found, so refuse here with the fix in the message
        // rather than letting the bridge fail with a connect error.
        let detected
        try {
            detected = await daemonDetectedFramework(
                this.db,
                daemonId,
                'openclaw'
            )
        } catch (err) {
            return {
                type: 'error',
                error: {
                    code: 'openclaw_daemon_acp_failed',
                    message: `openclaw gateway lookup failed: ${(err as Error).message}`,
                    retryable: true
                }
            }
        }
        const gateway = detected?.gateway
        if (!detected)
            return {
                type: 'error',
                error: {
                    code: 'openclaw_daemon_gateway_unavailable',
                    message:
                        'this daemon host has no openclaw installed (its last heartbeat detected no `openclaw` binary) — install openclaw, run `openclaw gateway start`, then restart the daemon',
                    retryable: false
                }
            }
        if (!gateway)
            return {
                type: 'error',
                error: {
                    code: 'openclaw_daemon_gateway_unavailable',
                    message:
                        'no openclaw gateway is configured on this daemon host — run `openclaw gateway install && openclaw gateway start` there, then retry',
                    retryable: false
                }
            }
        // `reachable: null` is a gateway the daemon does not probe (the config
        // names a remote one); the url-less bridge follows that config itself,
        // so it is not ours to refuse.
        if (gateway.reachable === false)
            return {
                type: 'error',
                error: {
                    code: 'openclaw_daemon_gateway_unavailable',
                    message: `the openclaw gateway on this daemon host did not answer on port ${gateway.port ?? 'unknown'} when the daemon last probed it (${gatewayProbeAge(gateway.checkedAt)}; it re-probes every few minutes) — run \`openclaw gateway start\` there, then retry`,
                    // The probe is up to one detect interval stale, so a
                    // gateway started since then is already fine: a retry is
                    // the cheapest way to find out, unlike the two structural
                    // refusals above.
                    retryable: true
                }
            }
        return null
    }

    // BYOD daemon over ACP (O6): dispatch a turn.start carrying the ACP payload
    // and decode the daemon's replayed ACP frames. The daemon is the ACP
    // client against the host's own gateway; the API only reads the stream,
    // live or replayed (exec.resume), so its restarts are invisible to the
    // turn — the same recovery contract hermes has.
    private async *sendViaDaemonAcp(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage,
        daemonId: string
    ): AsyncIterable<EmittedChatEvent> {
        if (ctx.abortSignal?.aborted) {
            yield cancelledEvent()
            return
        }
        const sessionKey = openclawGatewaySessionKey(ctx.sessionId)
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
        // Re-check immediately before dispatch. The caller checked too, but
        // every await since then — the capability and gateway admission
        // lookups, the budgets — is a window a cancel can land in, and a
        // signal never replays to the listener registered below. Without this
        // the turn.start still goes out and the daemon runs an ACP turn nobody
        // reads (#402, the leak the spawn path had its own guard for).
        if (ctx.abortSignal?.aborted) {
            yield cancelledEvent()
            return
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
        runtime: OpenclawRuntime
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
        const sessionKey = openclawGatewaySessionKey(ctx.sessionId)
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
            cmd: openclawAcpCmd({ sessionKey, execAsk, model: modelOverride, cwd }),
            env: {
                // The bridge authenticates to the loopback gateway with its own
                // token; the model call happens inside that gateway, which
                // already holds the provider key, so no alias env rides here.
                OPENCLAW_GATEWAY_TOKEN: runtime.gatewayToken,
                OPENCLAW_HIDE_BANNER: '1',
                OPENCLAW_SUPPRESS_NOTES: '1'
            },
            // NOT `dir: cwd`: wrapSpriteCommand would `cd <cwd> && …` before the
            // bridge, and the workspace may not exist yet (see openclawAcpCmd).
            // The bridge enters it itself, creating it first.
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

    // Recover a turn from the buffer of the daemon that carried it: the frames
    // are the ACP ones the daemon buffered, replayed through the same drain
    // that produced them, converging the message the turn suspended as. The
    // API-driven cells (sprites, k8s) own their ACP client, so a lost API
    // loses the turn — there is nothing to replay.
    async *resumeMessage(
        ctx: ApiChatResumeContext
    ): AsyncIterable<EmittedChatEvent> {
        if (
            ctx.runtimeKind !== 'daemon' ||
            !ctx.daemonId ||
            !ctx.daemonExecRef
        ) {
            yield {
                type: 'error',
                error: {
                    code: 'openclaw_resume_unsupported',
                    message:
                        'resume requires a daemon-carried openclaw ACP turn',
                    retryable: false
                }
            }
            return
        }
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
                timeoutMs: (await this.streamBudgets()).maxDurationMs + 10_000
            }
        })
    }
}

