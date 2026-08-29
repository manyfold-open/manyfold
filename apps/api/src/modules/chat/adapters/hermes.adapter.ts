import {
    DAEMON_FEATURE_TURN_HERMES,
    DAEMON_FEATURE_TURN_HERMES_OPTIONS,
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
    HermesCredentialsInput
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
import { ExecDriverFactory, type ExecDriverHandle } from './exec-driver-factory'
import {
    acpEventsFromNotification,
    acpModelMatches,
    HermesAcpTurn,
    HERMES_ACP_CMD,
    type AcpEvent,
    type AcpRequestTimeouts,
    type AcpSessionState,
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

const HERMES_ACP_PARSER_NAME = 'hermes-acp'
const HERMES_ACP_PARSER_VERSION = '1'

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
                ev.type === 'tool_result'
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
        private readonly fencedDispatch?: DaemonFencedDispatchService,
        // Same rule. Carries the interactive exec transports (sprite WSS /
        // pod exec) for the runtimes where no daemon can own the ACP client.
        @Optional()
        private readonly execDrivers?: ExecDriverFactory
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

        if (agentRow.runtime === 'daemon') {
            if (!agentRow.daemonId)
                throw new Error(
                    `daemon hermes agent ${ctx.agentId} missing daemonId`
                )
            let turnRpc: boolean
            try {
                turnRpc = await this.requireTurnHermes(agentRow.daemonId)
            } catch (err) {
                yield {
                    type: 'error',
                    error: {
                        code: 'hermes_daemon_acp_failed',
                        message: `turn.hermes capability lookup failed: ${(err as Error).message}`,
                        retryable: true
                    }
                }
                return
            }
            if (!turnRpc) {
                // The in-API pipe client is gone (#427's retirement gate):
                // every hermes turn is owned by an ACP client that survives
                // this process, or is refused with the fix in hand.
                yield {
                    type: 'error',
                    error: {
                        code: 'hermes_daemon_upgrade_required',
                        message:
                            "this daemon's mf CLI predates the hermes turn RPC; run `mf update` on the daemon host and restart the daemon",
                        retryable: false
                    }
                }
                return
            }
            const override = await this.daemonModelOverride({
                daemonId: agentRow.daemonId,
                modelTarget,
                explicit: explicitModelSwitch
            })
            if (override.refusal) {
                yield override.refusal
                return
            }
            yield* this.sendViaTurnRpc(ctx, userMessage, {
                daemonId: agentRow.daemonId,
                cwd: agentRow.workspacePath ?? null,
                // A BYOD daemon spawns `hermes acp` fresh each turn, so the
                // agent's env text rides the payload (#781).
                env: envTextToRecord(envTextFromExtras(agentRow.extras)),
                modelOverride: override.value,
                modelOverrideRequired: explicitModelSwitch
            })
            return
        }

        // A sprite hermes turn prefers its runner: the runner daemon owns the
        // ACP client inside the sprite, so the turn survives an api restart.
        // Measured on staging 2026-07-28: `hermes acp` runs inside the sprite
        // alongside the still-running resident gateway services without
        // disturbing them. Runner resolution already verified turn.hermes —
        // rechecking here would turn a transient lookup failure into a silent
        // downgrade AFTER chat.service stamped the daemon refs.
        if (ctx.runnerDaemonId) {
            let aliasEnv: Record<string, string>
            try {
                aliasEnv = await this.providerAliasEnv(ctx.agentId)
            } catch (err) {
                // Same policy as the interactive path's decrypt failure: an
                // infra error must not silently dispatch a keyless turn that
                // fails with a provider auth error pointing nowhere near the
                // cause.
                yield {
                    type: 'error',
                    error: {
                        code: 'hermes_daemon_acp_failed',
                        message: `provider credentials unavailable: ${(err as Error).message}`,
                        retryable: true
                    }
                }
                return
            }
            this.logger.log(
                `hermes sprite turn via runner agent=${ctx.agentId} daemonId=${ctx.runnerDaemonId}`
            )
            const override = await this.daemonModelOverride({
                daemonId: ctx.runnerDaemonId,
                modelTarget,
                explicit: explicitModelSwitch
            })
            if (override.refusal) {
                yield override.refusal
                return
            }
            yield* this.sendViaTurnRpc(ctx, userMessage, {
                daemonId: ctx.runnerDaemonId,
                cwd: agentRow.workspacePath ?? null,
                // The runner daemon was started detached from a plain exec
                // session, so the resident gateway's service env — agent
                // extras and provider alias keys included — never reaches the
                // child it spawns. Both must ride the payload, or a
                // non-custom provider has no API key and the Environment
                // settings silently stop applying. Alias last: the platform
                // key must win a name collision.
                env: {
                    ...envTextToRecord(envTextFromExtras(agentRow.extras)),
                    ...aliasEnv
                },
                modelOverride: override.value,
                modelOverrideRequired: explicitModelSwitch
            })
            return
        }

        // Sprites without a runner and k8s: API-owned ACP over the runtime's
        // interactive exec channel. Same protocol as every other hermes turn;
        // not resumable, exactly like the gateway POST this replaced.
        yield* this.sendViaInteractiveAcp(ctx, userMessage, {
            modelTarget: modelTarget ?? agentRow.model ?? null,
            explicitModelSwitch
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
            ...(args.modelOverride
                ? {
                      modelOverride: args.modelOverride,
                      modelOverrideRequired: args.modelOverrideRequired ?? false
                  }
                : {}),
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
                    let note: JsonRpcNotification | null = null
                    try {
                        note = JSON.parse(line) as JsonRpcNotification
                    } catch {
                        continue
                    }
                    for (const ev of acpEventsFromNotification(note)) {
                        if (ev.type === 'turn_end') sawTurnEnd = true
                        if (ev.type === 'usage_update') {
                            const cu = contextUsageFromUpdate(ev.usage)
                            if (cu) lastContextUsage = cu
                            continue
                        }
                        if (ev.type === 'tool_result') {
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
    private async *sendViaInteractiveAcp(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage,
        opts: { modelTarget: string | null; explicitModelSwitch: boolean }
    ): AsyncIterable<EmittedChatEvent> {
        // addEventListener never fires for an already-aborted signal, so a
        // cancel that landed before this point must short-circuit here or the
        // child is spawned and runs — and bills — the whole answer (#665's
        // class, which the retired gateway path prevented by handing the
        // signal to fetch).
        if (ctx.abortSignal?.aborted) {
            yield abortedEvent()
            return
        }
        if (!this.execDrivers) {
            yield {
                type: 'error',
                error: {
                    code: 'hermes_acp_failed',
                    message:
                        'interactive exec transport unavailable (no ExecDriverFactory)',
                    retryable: false
                }
            }
            return
        }
        let handle: ExecDriverHandle
        try {
            handle = await this.execDrivers.forAgent(ctx.agentId)
        } catch (err) {
            yield {
                type: 'error',
                error: {
                    code: 'hermes_acp_failed',
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
                    code: 'hermes_acp_failed',
                    message: `runtime ${handle.runtime} has no interactive exec transport`,
                    retryable: false
                }
            }
            return
        }
        const creds = (handle.creds ?? {}) as HermesCredentialsInput
        const execTimeouts = await this.chatExecTimeouts()
        const budgets: AcpRequestTimeouts = {
            idleTimeoutMs: HERMES_TURN_IDLE_TIMEOUT_MS,
            maxDurationMs: execTimeouts.timeoutMs
        }
        const cwd = handle.agent.workspacePath ?? null
        const prompt = messageToPromptText(userMessage)
        const tStart = Date.now()
        let firstTokenAt: number | null = null

        // The pre-dispatch awaits above (forAgent, admin settings) are where
        // a cancel is most likely to land; recheck before spawning.
        if (ctx.abortSignal?.aborted) {
            yield abortedEvent()
            return
        }

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
        const transport = streamInteractive({
            cmd: HERMES_ACP_CMD,
            env: {
                // The sprite driver already carries the per-agent base env
                // (extras/identity/connections); only per-turn keys ride here.
                // The alias is the same fix the runner path needs: an exec'd
                // child never sees the resident gateway's service env.
                ...hermesProviderAliasEnv(
                    (creds.primaryModelProvider as string | undefined) ??
                        'openai',
                    creds.primaryModelApiKey ?? ''
                ),
                HERMES_YOLO_MODE: '1'
            },
            ...(cwd ? { dir: cwd } : {}),
            // Bounds the ACP child's whole lifetime, so it has to be the
            // turn's ceiling and not the inactivity budget. The heartbeat
            // keeps an idle LB from dropping the WSS during a silent tool
            // call — with reattach off, that drop would kill the child.
            timeoutMs: budgets.maxDurationMs,
            keepAliveMs: execTimeouts.keepAliveMs,
            livenessTimeoutMs: execTimeouts.livenessTimeoutMs
        })
        const turn = new HermesAcpTurn({
            transport,
            onEvent: enqueue,
            logger: this.logger
        })
        const state: { finished: boolean; aborted: boolean } = {
            finished: false,
            aborted: false
        }
        const onAbort = (): void => {
            state.aborted = true
            turn.abort()
            wake()
        }
        ctx.abortSignal?.addEventListener('abort', onAbort, { once: true })

        const fatal: { yielded: boolean } = { yielded: false }
        // Ordinal over ACP events, persisted as the row identity so an
        // interrupted turn can be replayed without duplicating what it already
        // stored. Before this the ACP path emitted no source rows at all, so
        // its stream events had a null key, insertStreamEvent plain-inserted
        // them, and a replay would have appended the whole answer a second
        // time.
        const acpSeq = { current: 0 }
        const acpXSeq = { current: 0 }
        const contextRef: {
            current: { size: number; used: number } | null
        } = { current: null }
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
                    case 'tool_result': {
                        acpXSeq.current += 1
                        yield* acpEventToChatEvents(ev, acpXSeq.current)
                        break
                    }
                    case 'usage_update': {
                        const cu = contextUsageFromUpdate(ev.usage)
                        if (cu) contextRef.current = cu
                        break
                    }
                    case 'turn_end':
                        break
                    case 'error': {
                        if (fatal.yielded) break
                        // The gateway path classified pool exhaustion from
                        // its 503 body; over ACP the same managed-proxy
                        // refusal only surfaces on stderr, so classify the
                        // fatal line PLUS its tail (the 503 body can print on
                        // a different line than the Aborting marker) or the
                        // breaker (#660) never trips for hermes. A managed
                        // refusal is retryable — the breaker and retry
                        // ladder exist to absorb exactly it — while every
                        // other fatal line stays terminal.
                        const managedChannelFailure =
                            classifyManagedChannelFailureSignal({
                                message: ev.detail ?? ev.message
                            })
                        yield {
                            type: 'error',
                            ...(managedChannelFailure
                                ? { managedChannelFailure }
                                : {}),
                            error: {
                                code: 'hermes_acp_event',
                                message: ev.message,
                                retryable: managedChannelFailure !== null
                            }
                        }
                        fatal.yielded = true
                        state.aborted = true
                        turn.abort()
                        return
                    }
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
                await turn.initialize(30_000)
                const sessionCwd = cwd ?? '.'
                if (ctx.frameworkSessionRef) {
                    try {
                        await turn.resumeSession({
                            cwd: sessionCwd,
                            sessionId: ctx.frameworkSessionRef,
                            timeoutMs: 30_000
                        })
                    } catch (err) {
                        this.logger.warn(
                            `hermes session/resume failed (${(err as Error).message}); creating new session`
                        )
                        await turn.newSession({
                            cwd: sessionCwd,
                            timeoutMs: 30_000
                        })
                    }
                } else {
                    await turn.newSession({
                        cwd: sessionCwd,
                        timeoutMs: 30_000
                    })
                }
                // Reconcile the session's persisted model with what this turn
                // claims to run (override ?? agent default). Diff against the
                // reported state so an untouched session costs no RPC; a build
                // that reports no state only gets set_model for an explicit
                // switch, where failing loudly beats running the wrong model.
                const target = opts.modelTarget
                if (target) {
                    const state = turn.sessionState
                    const shouldSet = state
                        ? !acpModelMatches(state.currentModelId, target)
                        : opts.explicitModelSwitch
                    if (shouldSet)
                        await turn.setModel({
                            modelId: target,
                            timeoutMs: 30_000
                        })
                }
                resultRef.current = await turn.prompt({
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
            // Close BEFORE dropping the abort listener: close() waits a
            // bounded grace for the child to exit on EOF, and a cancel that
            // lands inside that window must still reach the transport.
            await turn.close().catch(() => {})
            ctx.abortSignal?.removeEventListener('abort', onAbort)
        }

        if (fatal.yielded) {
            yield { type: 'done', finalMessageId: ctx.messageId }
            return
        }

        if (state.aborted) {
            yield abortedEvent()
            return
        }

        const runError = errorRef.current
        if (runError) {
            // A set_model failure is its own story: method-not-found means
            // the hermes build predates model switching (fix is a rebuild /
            // `mf update`, not a retry); anything else is worth retrying.
            // Never proceed-with-warning — the user named a model, and
            // answering with a different one silently violates the choice and
            // mislabels billing.
            if (runError.message.includes('session/set_model')) {
                const unsupported = /method not found/i.test(runError.message)
                yield {
                    type: 'error',
                    error: {
                        code: unsupported
                            ? 'hermes_set_model_unsupported'
                            : 'hermes_set_model_failed',
                        message: unsupported
                            ? "this agent's hermes build predates model switching; rebuild the agent image or switch back to the default model"
                            : runError.message,
                        retryable: !unsupported
                    }
                }
                return
            }
            const managedChannelFailure = classifyManagedChannelFailureSignal({
                message: runError.message
            })
            yield {
                type: 'error',
                ...(managedChannelFailure ? { managedChannelFailure } : {}),
                error: {
                    code: 'hermes_acp_failed',
                    message: runError.message,
                    retryable: true
                }
            }
            return
        }

        const sid = turn.currentSessionId
        // `sid !== ref`, not `!ref`: when session/resume fails and the
        // fallback creates a fresh session, the stale stored ref must be
        // REPLACED or every later turn retries the dead session and hermes
        // never regains cross-turn memory. Same condition as drainTurnStream.
        if (sid && sid !== ctx.frameworkSessionRef) {
            await this.chatRepo
                .updateFrameworkSessionRef(ctx.sessionId, sid, ctx.turnFence)
                .catch((err) =>
                    this.logger.warn(
                        `hermes session ref persist failed for ${ctx.sessionId}: ${(err as Error).message}`
                    )
                )
        }
        this.persistHermesAcpState(ctx.agentId, turn.sessionState)

        if (contextRef.current)
            yield { type: 'context_usage', context: contextRef.current }
        const usage = extractAcpUsage(resultRef.current)
        if (usage) {
            yield {
                type: 'usage',
                usage: buildOpenAiUsage(
                    usage,
                    ctx.model ??
                        stringValue(creds.primaryModelName ?? null) ??
                        'hermes',
                    tStart,
                    firstTokenAt,
                    this.pricing,
                    ctx
                )
            }
        }
        yield { type: 'done', finalMessageId: ctx.messageId }
    }
}

// The interactive-ACP cancel terminal. Distinct from hermes_daemon_aborted so
// a cancelled API-owned turn and a cancelled daemon turn stay separable in
// triage; both normalize to cancelled_by_user in chat.service.
const abortedEvent = (): EmittedErrorEvent => ({
    type: 'error',
    error: {
        code: 'hermes_aborted',
        message: 'hermes turn aborted',
        retryable: false
    }
})

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
