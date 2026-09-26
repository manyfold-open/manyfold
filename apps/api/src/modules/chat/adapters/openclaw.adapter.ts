import { ChatRunnerError } from '../runner/chat-runner'
import {
    DAEMON_FEATURE_TURN_OPENCLAW_ACP,
    acpEventsFromFrame
} from '@manyfold/shared'
import type {
    AgentFramework,
    ChatCapabilities,
    ChatMessage,
    DaemonOpenclawAcpTurnPayload,
    OpenclawTurnUsage
} from '@manyfold/shared'
import { Inject, Injectable, Optional } from '@nestjs/common'
import { type Database } from '@manyfold/db'
import { buildOpenAiUsage } from './openai-usage'
import { DRIZZLE } from '@/db/tokens'
import { CryptoService } from '@/modules/secrets/crypto.service'
import { UsagePricingService } from '@/modules/usage/usage-pricing.service'
import { ChatRepository } from '@/modules/chat/chat.repository'
import {
    ExecDriverFactory
} from '@/modules/chat/adapters/exec-driver-factory'
import { DaemonRegistryService } from '@/modules/daemon/daemon-registry.service'
import { DaemonFencedDispatchService } from './daemon-fenced-dispatch.service'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
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
    type AcpEvent
} from '@manyfold/shared'
import { classifyManagedChannelFailureSignal } from '@/modules/chat/managed-channel-failure-signal'
import {
    GatewayHttpChatAdapter
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

// The Manyfold-provisioned gateway names its one provider `primary`
// (buildOpenclawConfigJson). A pick from the model list is a bare id under
// it; the agent's stored model can already be the ref OpenClaw listed.
// Seen on a kind cloud computer [2026-09-25]: openclaw 2026.9.6 lists every
// agent's effective model as primary/<model>, and prefixing it again made the
// provider 404 the turn.
const openclawModelRef = (model: string): string =>
    model.startsWith('primary/') ? model : `primary/${model}`

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
        fencedDispatch?: DaemonFencedDispatchService
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

    // Every OpenClaw turn is owned by the runtime's daemon ACP client; the
    // base's gateway HTTP transport is for frameworks that chat over it.
    protected async *dispatchTurn(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage,
        agentRow: {
            runtime: string
            internalId: string | null
            daemonId: string | null
        }
    ): AsyncIterable<EmittedChatEvent> {
        const daemonId = agentRow.runtime === 'daemon' ? agentRow.daemonId : ctx.runnerDaemonId
        if (!daemonId) throw new ChatRunnerError(ctx.runtimeKind, 'runner missing')
        const refusal = await this.daemonAdmissionRefusal(daemonId, {
            // Only a BYOD daemon's gateway is discovered. A sprite's or cloud
            // computer's is the platform's own service (a sprite service, or
            // one the pod host's daemon keeps up, ADR-0035): a detection from
            // before it was installed must not refuse the turn, nor a probe
            // taken while it was still binding, and the daemon waits for it
            // before dialling. Seen on prod sprites [2026-09-26]: a runner's
            // first probe ran 3-6s before the gateway it thawed alongside
            // answered, and the turn was refused as unreachable.
            platformGateway: agentRow.runtime !== 'daemon'
        })
        if (refusal) {
            yield refusal
            return
        }
        yield* this.sendViaDaemonAcp(ctx, userMessage, daemonId)
    }

    // Whether this daemon may be sent an openclaw ACP turn, and if not, the
    // error that says so. Two admission gates, both modelled on hermes's
    // `requireTurnHermes` (ADR-0024): a lookup that FAILS is retryable —
    // "couldn't check" must never surface as the non-retryable upgrade demand
    // that a definite `false` produces.
    private async daemonAdmissionRefusal(
        daemonId: string,
        options: { platformGateway: boolean }
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
        if (options.platformGateway) return null
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
        if (ctx.modelOverride) patch.model = openclawModelRef(ctx.modelOverride)
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

    async *resumeMessage(
        ctx: ApiChatResumeContext
    ): AsyncIterable<EmittedChatEvent> {
        if (
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
