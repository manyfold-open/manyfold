import { redactCredentialText } from '@/common/telemetry/redact-credentials'
import { ChatRunnerError } from '../runner/chat-runner'
import {
    DAEMON_FEATURE_TURN_HERMES,
    DAEMON_FEATURE_TURN_HERMES_OPTIONS,
    DAEMON_FEATURE_TURN_HERMES_PERMISSIONS,
    DEFAULT_CHAT_EXEC_TIMEOUTS,
    envTextFromExtras,
    envTextToRecord,
    resolveChatExecTimeoutMs
} from '@manyfold/shared'
import type {
    AgentFramework,
    ChatCapabilities,
    ChatMessage,
    DaemonTurnStartPayload,
    HermesCredentialsInput,
    HermesPermissionMode
} from '@manyfold/shared'
import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { eq } from 'drizzle-orm'
import {
    agents,
    agentCredentials,
    jsonbMerge,
    type Database
} from '@manyfold/db'
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
import { hermesProviderAliasEnv } from '@/modules/agents/bootstrap/hermes-shared'
import {
    acpEventsFromFrame,
    type AcpEvent,
    type AcpRequestTimeouts,
    type AcpSessionState
} from '@manyfold/shared'

// #556: this was a hard-coded 240s over the whole turn, and the streamed
// session/update notifications never reset it — so it capped total duration
// instead of detecting a hang, and any turn longer than 4 minutes was
// truncated. It survives only as the inactivity default (same number, new
// meaning: strictly more permissive).
const DEFAULT_HERMES_IDLE_TIMEOUT_MS = 240_000
const HERMES_TURN_IDLE_TIMEOUT_MS = Math.max(
    1_000,
    Number(
        process.env.HERMES_TURN_IDLE_TIMEOUT_MS ?? DEFAULT_HERMES_IDLE_TIMEOUT_MS
    )
)

const HERMES_ACP_PARSER_NAME = 'hermes-acp'
const HERMES_ACP_PARSER_VERSION = '1'

// Deny-on-timeout deadline for an unanswered interactive ask. Long by design
// — a human is deciding — while maxDurationMs stays the only wall clock; the
// pending ask itself keeps the idle budget alive.
const HERMES_PERMISSION_TIMEOUT_MS = Math.max(
    10_000,
    Number(process.env.HERMES_PERMISSION_TIMEOUT_MS ?? 300_000)
)

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
    //
    // tool_result lives in its own `-x-` ordinal namespace with its own
    // counter: the legacy kinds' numbering (and therefore their
    // sourceEventKeys) must not shift when a decoder deploy starts emitting
    // new kinds mid-turn, or a cross-deploy resume re-keys rows it already
    // wrote and the dedup index stops matching them.
    const source: EmittedChatEvent = {
        type: 'raw_source',
        source: {
            sourceRef: null,
            sourceSeq,
            externalId:
                ev.type === 'tool_result' ||
                ev.type === 'permission_request' ||
                ev.type === 'permission_resolution'
                    ? `hermes-acp-x-${sourceSeq}`
                    : `hermes-acp-${sourceSeq}`,
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
        case 'tool_result':
            return [
                source,
                {
                    type: 'tool_result',
                    toolCallId: ev.toolCallId,
                    // {error: …} is the shape the web's status derivation
                    // already recognizes as a failure.
                    result:
                        ev.status === 'failed'
                            ? { error: ev.result ?? 'tool failed' }
                            : (ev.result ?? '')
                }
            ]
        case 'permission_request':
            return [
                source,
                {
                    type: 'permission_request',
                    requestId: ev.requestId,
                    toolCallId: ev.toolCallId,
                    title: ev.title,
                    detail: ev.detail,
                    options: ev.options
                }
            ]
        case 'permission_resolution':
            return [
                source,
                {
                    type: 'permission_resolution',
                    requestId: ev.requestId,
                    outcome: ev.outcome,
                    optionId: ev.optionId
                }
            ]
        default:
            return []
    }
}

// Hermes streams {size, used} context-window pressure as usage_update — not
// billing tokens, so it must never reach the usage pipeline.
const contextUsageFromUpdate = (
    usage: Record<string, unknown>
): { size: number; used: number } | null => {
    const size = usage['size']
    const used = usage['used']
    if (typeof size !== 'number' || typeof used !== 'number') return null
    if (!Number.isFinite(size) || !Number.isFinite(used) || size <= 0)
        return null
    return { size, used: Math.max(0, used) }
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

    private async chatExecTimeouts(): Promise<{
        timeoutMs: number
        keepAliveMs: number
        livenessTimeoutMs: number
    }> {
        return this.adminSettings
            ? await this.adminSettings.getCachedChatExecTimeoutMs()
            : resolveChatExecTimeoutMs(DEFAULT_CHAT_EXEC_TIMEOUTS)
    }

    // The wall-clock cap is the ADMIN chat exec budget (default 2h) — the same
    // knob that already bounds claude-code / codex / gemini turns, which is why
    // those routinely run past 240s while hermes could not. Only the inactivity
    // budget is hermes's own.
    private async turnBudgets(): Promise<AcpRequestTimeouts> {
        const execTimeouts = await this.chatExecTimeouts()
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
                mountPath: agents.mountPath,
                extras: agents.extras,
                model: agents.model
            })
            .from(agents)
            .where(eq(agents.id, ctx.agentId))
            .limit(1)
        if (!agentRow) throw new Error(`agent ${ctx.agentId} not found`)

        // What set_model should enforce this turn. The web auto-defaults the
        // override to the agent's model, so "override present" alone is not
        // user intent — only an override that DIFFERS from the agent default
        // is a switch the user actually asked for, and only that hard-gates
        // on the daemon capability below.
        const modelTarget = ctx.modelOverride ?? null
        const explicitModelSwitch =
            modelTarget !== null && modelTarget !== (agentRow.model ?? null)
        // Only the ask modes ride the payload: explicit dontAsk IS the daemon
        // default, and attaching it would gate every legacy flow on the new
        // capability for nothing.
        const askMode: HermesPermissionMode | null =
            ctx.hermesPermissionMode && ctx.hermesPermissionMode !== 'dontAsk'
                ? ctx.hermesPermissionMode
                : null

        const daemonId = agentRow.runtime === 'daemon' ? agentRow.daemonId : ctx.runnerDaemonId
        if (!daemonId) throw new ChatRunnerError(ctx.runtimeKind, 'runner missing')
        try {
            if (!await this.requireTurnHermes(daemonId)) {
                yield { type: 'error', error: new ChatRunnerError(ctx.runtimeKind, 'turn.hermes missing', true).chatError }
                return
            }
        } catch (err) {
            const detail = redactCredentialText(err instanceof Error ? err.message : String(err)).slice(0, 1024)
            yield { type: 'error', error: new ChatRunnerError(ctx.runtimeKind, `capability lookup failed: ${detail}`).chatError }
            return
        }
        const override = await this.daemonModelOverride({ daemonId, modelTarget, explicit: explicitModelSwitch })
        if (override.refusal) {
            yield override.refusal
            return
        }
        const permission = await this.daemonPermissionMode({ daemonId, askMode })
        if (permission.refusal) {
            yield permission.refusal
            return
        }
        let aliasEnv: Record<string, string> = {}
        try {
            if (agentRow.runtime !== 'daemon') aliasEnv = await this.providerAliasEnv(ctx.agentId)
        } catch (err) {
            const detail = redactCredentialText(err instanceof Error ? err.message : String(err)).slice(0, 1024)
            yield { type: 'error', error: {
                code: 'hermes_daemon_acp_failed',
                message: `hermes provider credentials unavailable: ${detail}`,
                retryable: true
            } }
            return
        }
        yield* this.sendViaTurnRpc(ctx, userMessage, {
            daemonId,
            cwd: agentRow.workspacePath ?? agentRow.mountPath ?? null,
            env: { ...envTextToRecord(envTextFromExtras(agentRow.extras)), ...aliasEnv },
            modelOverride: override.value,
            modelOverrideRequired: explicitModelSwitch,
            permissionMode: permission.value
        })
    }

    // Recover a hermes turn from the buffer of the daemon that carried it. For
    // a turn the runner OWNED (turn.start) the child is still generating inside
    // the sprite, so this replays what it wrote and then follows the live tail
    // to a real completion. A replay without completion evidence suspends —
    // retryable, never a truncated `done`. Interactive-transport turns record
    // no daemon refs and decline below.
    async *resumeMessage(
        ctx: ApiChatResumeContext
    ): AsyncIterable<EmittedChatEvent> {
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

    private async *sendViaTurnRpc(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage,
        args: {
            daemonId: string
            cwd: string | null
            env?: Record<string, string>
            modelOverride?: string | null
            modelOverrideRequired?: boolean
            permissionMode?: 'default' | 'acceptEdits' | null
        }
    ): AsyncIterable<EmittedChatEvent> {
        this.logger.log(
            `hermes turn.start daemon=${args.daemonId} agent=${ctx.agentId} message=${ctx.messageId}`
        )
        const budgets = await this.turnBudgets()
        const interactive = args.permissionMode != null
        const payload: DaemonTurnStartPayload = {
            framework: 'hermes',
            prompt: messageToPromptText(userMessage),
            ...(args.cwd ? { dir: args.cwd } : {}),
            sessionId: ctx.frameworkSessionRef ?? null,
            ...(args.modelOverride
                ? {
                      modelOverride: args.modelOverride,
                      modelOverrideRequired: args.modelOverrideRequired ?? false
                  }
                : {}),
            ...(interactive
                ? {
                      permissionMode: args.permissionMode ?? undefined,
                      permissionTimeoutMs: HERMES_PERMISSION_TIMEOUT_MS
                  }
                : {}),
            // Platform key last; the HERMES_ prefix is reserved, so the agent
            // extras can never shadow it anyway. Ask modes drop YOLO so the
            // asks reach the user instead of hermes's import-time bypass.
            env: {
                ...(args.env ?? {}),
                ...(interactive ? {} : { HERMES_YOLO_MODE: '1' })
            },
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
        // addEventListener never fires for an already-aborted signal, so a
        // cancel that landed during the caller's pre-dispatch awaits must be
        // caught here or the turn dispatches anyway and runs to completion.
        if (ctx.abortSignal?.aborted) {
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
        let acpXSeq = 0
        let sawTurnEnd = false
        let lastContextUsage: { size: number; used: number } | null = null
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
                    let frame: Record<string, unknown> | null = null
                    try {
                        frame = JSON.parse(line) as Record<string, unknown>
                    } catch {
                        continue
                    }
                    for (const ev of acpEventsFromFrame(frame)) {
                        if (ev.type === 'turn_end') sawTurnEnd = true
                        if (ev.type === 'usage_update') {
                            const cu = contextUsageFromUpdate(ev.usage)
                            if (cu) lastContextUsage = cu
                            continue
                        }
                        if (
                            ev.type === 'tool_result' ||
                            ev.type === 'permission_request' ||
                            ev.type === 'permission_resolution'
                        ) {
                            acpXSeq += 1
                            yield* acpEventToChatEvents(ev, acpXSeq)
                            continue
                        }
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
            // The runner transport is where a managed-pool refusal arrives
            // once a runner carries the turn, so the breaker (#660) must be
            // fed here exactly like on the interactive path — the daemon
            // forwards the failure text verbatim.
            const managedChannelFailure = classifyManagedChannelFailureSignal({
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
        this.persistHermesAcpState(
            ctx.agentId,
            sessionStateFromFinal(ackPayload)
        )
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
        if (lastContextUsage)
            yield { type: 'context_usage', context: lastContextUsage }
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

    // Unlike a runner turn (verified at resolution time), a daemon-runtime
    // turn checks its own daemon here. RETHROWS a lookup failure: "couldn't
    // check" must surface as a retryable error, never as the non-retryable
    // upgrade demand `false` produces.
    private async requireTurnHermes(daemonId: string): Promise<boolean> {
        return daemonAdvertisesFeature(
            this.db,
            daemonId,
            DAEMON_FEATURE_TURN_HERMES
        )
    }

    // Whether the turn payload may carry a model to enforce. An explicit
    // switch on a daemon without turn.hermes.options is REFUSED — silently
    // dropping the user's model choice would run the wrong model under a UI
    // that claims otherwise. The auto-defaulted override (target == the
    // agent's model) merely reconciles, so an old or unverifiable daemon
    // skips it and keeps its status quo.
    private async daemonModelOverride(args: {
        daemonId: string
        modelTarget: string | null
        explicit: boolean
    }): Promise<{ value: string | null; refusal?: EmittedErrorEvent }> {
        if (!args.modelTarget) return { value: null }
        let supported: boolean
        try {
            supported = await daemonAdvertisesFeature(
                this.db,
                args.daemonId,
                DAEMON_FEATURE_TURN_HERMES_OPTIONS
            )
        } catch (err) {
            if (!args.explicit) return { value: null }
            return {
                value: null,
                refusal: {
                    type: 'error',
                    error: {
                        code: 'hermes_daemon_acp_failed',
                        message: `turn.hermes.options capability lookup failed: ${(err as Error).message}`,
                        retryable: true
                    }
                }
            }
        }
        if (supported) return { value: args.modelTarget }
        if (!args.explicit) return { value: null }
        return {
            value: null,
            refusal: {
                type: 'error',
                error: {
                    code: 'hermes_daemon_options_upgrade_required',
                    message:
                        "this daemon's mf CLI predates hermes model switching; run `mf update` on the daemon host and restart the daemon, or switch back to the agent's default model",
                    retryable: false
                }
            }
        }
    }

    // Whether an ask mode may ride the payload. Mirrors daemonModelOverride's
    // honesty rule: silently running YOLO under a UI that claims "ask" is
    // worse than refusing, so an old daemon is refused with the fix in hand.
    private async daemonPermissionMode(args: {
        daemonId: string
        askMode: HermesPermissionMode | null
    }): Promise<{
        value: 'default' | 'acceptEdits' | null
        refusal?: EmittedErrorEvent
    }> {
        if (!args.askMode || args.askMode === 'dontAsk') return { value: null }
        let supported: boolean
        try {
            supported = await daemonAdvertisesFeature(
                this.db,
                args.daemonId,
                DAEMON_FEATURE_TURN_HERMES_PERMISSIONS
            )
        } catch (err) {
            return {
                value: null,
                refusal: {
                    type: 'error',
                    error: {
                        code: 'hermes_daemon_acp_failed',
                        message: `turn.hermes.permissions capability lookup failed: ${(err as Error).message}`,
                        retryable: true
                    }
                }
            }
        }
        if (supported) return { value: args.askMode }
        return {
            value: null,
            refusal: {
                type: 'error',
                error: {
                    code: 'hermes_daemon_permissions_upgrade_required',
                    message:
                        'this daemon\'s mf CLI predates hermes interactive permissions; run `mf update` on the daemon host and restart the daemon, or switch the permission mode back to "Don\'t ask"',
                    retryable: false
                }
            }
        }
    }

    // Best-effort capture of the session state hermes reported, for
    // diagnostics — the picker's source of truth stays the provider-models
    // cache, so absence (old daemons, old hermes builds) degrades to nothing.
    private persistHermesAcpState(
        agentId: string,
        state: AcpSessionState | null | undefined
    ): void {
        if (!state) return
        // try/catch on top of the .catch: best-effort must also survive a
        // SYNCHRONOUS throw from the query builder, not just a rejected write.
        try {
            void this.db
                .update(agents)
                .set({
                    extras: jsonbMerge(agents.extras, {
                        hermesAcp: {
                            currentModelId: state.currentModelId,
                            modelIds: state.modelIds,
                            currentModeId: state.currentModeId,
                            modeIds: state.modeIds,
                            capturedAt: new Date().toISOString()
                        }
                    })
                })
                .where(eq(agents.id, agentId))
                .catch((err: unknown) =>
                    this.logger.warn(
                        `hermes acp state persist failed for ${agentId}: ${(err as Error).message}`
                    )
                )
        } catch (err) {
            this.logger.warn(
                `hermes acp state persist failed for ${agentId}: ${(err as Error).message}`
            )
        }
    }

    // Decrypt the runtime credentials and alias the primary provider's key to
    // the env var hermes reads at runtime (OPENROUTER_API_KEY, …). {} only
    // for legitimate absence (no runtime, no stored credentials, or a
    // `custom` provider whose key lives in ~/.hermes/config.yaml); an infra
    // failure (DB, decrypt, corrupt blob) THROWS so the caller can fail the
    // turn retryably instead of dispatching it keyless.
    private async providerAliasEnv(
        agentId: string
    ): Promise<Record<string, string>> {
        const [agent] = await this.db
            .select({ runtimeId: agents.runtimeId })
            .from(agents)
            .where(eq(agents.id, agentId))
            .limit(1)
        if (!agent?.runtimeId) return {}
        const [credRow] = await this.db
            .select()
            .from(agentCredentials)
            .where(eq(agentCredentials.runtimeId, agent.runtimeId))
            .limit(1)
        if (!credRow) return {}
        const creds = JSON.parse(
            this.crypto.decrypt({
                ciphertext: credRow.payloadCiphertext,
                keyVersion: credRow.keyVersion
            })
        ) as HermesCredentialsInput
        return hermesProviderAliasEnv(
            (creds.primaryModelProvider as string | undefined) ?? 'openai',
            creds.primaryModelApiKey ?? ''
        )
    }

    // THIS process is the ACP client, over the runtime's interactive exec
    // channel (sprite WSS / pod exec). It cannot survive an API restart by
    // construction (ACP is client-driven), so failures here are retryable
    // errors and never `suspended` — nothing could resume a suspended turn,
    // which would make it invisible to every later recovery attempt.
}

const stringValue = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null

// The compact models/modes shape a turn.hermes.options daemon reports on its
// final (see DaemonTurnFinalPayload) — absent on older daemons.
const sessionStateFromFinal = (
    ackPayload: Record<string, unknown> | undefined
): AcpSessionState | null => {
    if (!ackPayload) return null
    const models = ackPayload['models'] as
        | { currentModelId?: unknown; modelIds?: unknown }
        | undefined
    const modes = ackPayload['modes'] as
        | { currentModeId?: unknown; modeIds?: unknown }
        | undefined
    if (!models && !modes) return null
    const ids = (value: unknown): string[] =>
        Array.isArray(value)
            ? value.filter((v): v is string => typeof v === 'string')
            : []
    return {
        currentModelId: stringValue(models?.currentModelId),
        modelIds: ids(models?.modelIds),
        currentModeId: stringValue(modes?.currentModeId),
        modeIds: ids(modes?.modeIds)
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
    // Seen on hermes-agent 0.20.6 [2026-08-29]: the acp 0.9.0 wire aliases
    // are cachedReadTokens/cachedWriteTokens (with the d). The d-less pair
    // never matched, so cache token counts were silently dropped from
    // billing; kept for builds that predate the rename.
    const cacheRead = num(
        'cachedReadTokens',
        'cacheReadTokens',
        'cache_read_input_tokens'
    )
    const cacheCreate = num(
        'cachedWriteTokens',
        'cacheWriteTokens',
        'cache_creation_input_tokens'
    )
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
