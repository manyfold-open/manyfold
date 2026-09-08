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
import { randomUUID } from 'node:crypto'
import { Inject, Injectable, Optional } from '@nestjs/common'
import { type Database } from '@manyfold/db'
import { buildOpenAiUsage } from './openai-usage'
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
    type ApiChatAdapterContext,
    type ApiChatResumeContext,
    type EmittedChatEvent
} from '@/modules/chat/chat-adapter'
import { messageToPromptText } from './message-content'
import {
    AcpTurn,
    type AcpEvent,
    type AcpRequestTimeouts
} from './hermes-acp-client'
import { OPENCLAW_ACP_DIALECT } from '@manyfold/shared'
import { parseOpenclawJsonOutput } from './openclaw-json-parser'
import { classifyManagedChannelFailureSignal } from '@/modules/chat/managed-channel-failure-signal'
import {
    GatewayHttpChatAdapter,
    type OpenclawRuntime
} from './gateway-http-chat.adapter'
import {
    OPENCLAW_FETCH_TIMEOUT_MS,
    openclawCancelledEvent as cancelledEvent
} from './openclaw-turn-shared'

const OPENCLAW_CLI_PARSER_NAME = 'openclaw-cli-json'
const OPENCLAW_CLI_PARSER_VERSION = '1'

// Gates the API-driven ACP transport (openclaw acp over interactive exec) on
// the sprites-no-runner and k8s cells. Read per call so a drill can flip it
// without a restart. ON by default (ADR-0027): openclaw chat runs over ACP. Set
// MF_OPENCLAW_ACP=0 (or false/no) to fall back to the gateway-http path — the
// no-deploy rollback kept for the transition until gateway-http is removed.
const openclawAcpEnabled = (): boolean =>
    !['0', 'false', 'no'].includes(
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

    // The openclaw transports that the gateway-http base does not carry: the
    // BYOD daemon ACP turn and the API-driven ACP bridge. Everything else —
    // the OpenAI-compatible POST and the runner-held turn-rpc variant, plus
    // the session-ref backfill they need — stays on the base, which is also
    // narranexus's only transport.
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
            // BYOD daemon over ACP (ADR-0027, O6): the daemon drives `openclaw
            // acp` against the host's OWN gateway. Guarded on the flag, on a
            // resolvable daemon, and on the daemon advertising the capability
            // — otherwise fall back to the legacy `openclaw agent --local
            // --json` spawn.
            if (
                openclawAcpEnabled() &&
                agentRow.daemonId &&
                this.daemonRegistry &&
                (await this.daemonSupportsOpenclawAcp(agentRow.daemonId))
            ) {
                yield* this.sendViaDaemonAcp(
                    ctx,
                    userMessage,
                    agentRow.daemonId
                )
                return
            }
            yield* this.sendViaDaemonSpawn(ctx, userMessage)
            return
        }

        // With MF_OPENCLAW_ACP on, the ACP path is the openclaw transport — it
        // is the only one that can carry a per-message model switch (via an
        // in-box sessions.patch on the stateful session) or an interactive
        // permission card, because the gateway-http/turn-rpc `model` field is
        // only an agent router (`openclaw`/`openclaw/<agentId>`; a provider
        // model there is rejected 400). So ACP takes precedence over the
        // runner turn-rpc transport when the flag is on.
        // Seen on staging [2026-09-08]: with MF_SPRITE_RUNNER_AGENTS='*' the
        // runner turn-rpc path shadowed ACP, so model switching silently did
        // nothing (and a body-model workaround 400'd) until this flip.
        if (!openclawAcpEnabled()) {
            yield* super.dispatchTurn(ctx, userMessage, agentRow)
            return
        }
        // The ACP path persists its own (deterministic) gateway key, so it
        // never runs the base's legacy FS backfill.
        const runtime = await this.resolveRuntime(ctx.agentId)
        yield* this.sendViaOpenclawAcp(ctx, userMessage, runtime)
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
        // A sprite turn's replay is the base's runner-carried SSE drain.
        yield* super.resumeMessage(ctx)
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

}

