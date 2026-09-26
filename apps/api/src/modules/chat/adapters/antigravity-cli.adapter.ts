import {
    AGY_MANAGED_HOST_ENV,
    AgentFramework,
    ChatCapabilities,
    ChatMessage,
    DEFAULT_CHAT_EXEC_TIMEOUTS,
    antigravityUpstreamModel,
    isAntigravityConversationId,
    resolveChatExecTimeoutMs
} from '@manyfold/shared'
import type { AgentModelConfigSource } from '@manyfold/shared'
import { Injectable, Logger, Optional } from '@nestjs/common'
import type { ResolvedAntigravityCliCredentials } from '@/modules/agents/credentials/resolved-credentials'
import { antigravityPlatformExec } from '@/modules/agents/credentials/antigravity-app-dir'
import { effectiveModelConfigSource } from '@/modules/agents/model-config/runtime-auth-selection'
import { UsagePricingService } from '@/modules/usage/usage-pricing.service'
import { UNKNOWN_PRICE_SCOPE } from '@/modules/usage/served-price-scope'
import {
    isDaemonOfflineTransportError,
    isDaemonResumeSuspendError,
    type ApiChatAdapter,
    type ApiChatAdapterContext,
    type ApiChatResumeContext,
    type EmittedChatEvent
} from '@/modules/chat/chat-adapter'
import type { ExecStreamHandle } from '@/modules/chat/adapters/exec-driver'
import { ChatRepository } from '@/modules/chat/chat.repository'
import { ExecDriverFactory } from '@/modules/chat/adapters/exec-driver-factory'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { classifyAntigravityFailureSignal } from '@/modules/chat/managed-channel-failure-signal'
import { TurnFenceLostError } from '@/modules/chat/turn-fence'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import {
    antigravityTranscriptLineCountScript,
    parseAntigravityTranscriptLineCount
} from '@/modules/chat/recovery/readers/antigravity-cli-reader'
import { redactSecrets } from './claude-stream-consumer'
import { forkTranscriptPrompt } from './fork-transcript-prompt'
import { messageToPromptText } from './message-content'

export const AGY_STREAM_PARSER_NAME = 'antigravity-cli-stream-json'
export const AGY_STREAM_PARSER_VERSION = '1'

// agy's own verdict on a failed model or agent call (1.2.6+): one line on
// stderr, exit 3. Measured on agy 1.2.11 [2026-09-26] against a local stub.
const AGY_ERROR_LINE = /^AGY_ERROR: (\{.*\})\s*$/m
// A run with no sign-in on the host and no API-key mode: exit 1 at once.
const AGY_SIGN_IN_REQUIRED = /authentication required/i

const STDERR_HEAD_CHARS = 512
const STDERR_TAIL_CHARS = 4000
const STDERR_ELISION = '\n… [stderr elided] …\n'

interface AgyErrorLine {
    shortError: string | null
    retryable: boolean
}

interface AgyResult {
    status: string | null
    error: string | null
    response: string | null
}

interface AgyUsageTotals {
    inputTokens: number
    outputTokens: number
    cacheReadTokens: number
    calls: number
}

@Injectable()
export class AntigravityCliAdapter implements ApiChatAdapter {
    readonly framework: AgentFramework = 'antigravity-cli'
    private readonly logger = new Logger(AntigravityCliAdapter.name)

    constructor(
        private readonly drivers: ExecDriverFactory,
        private readonly chatRepo: ChatRepository,
        private readonly pricing: UsagePricingService,
        @Optional() private readonly adminSettings?: AdminSettingsService,
        @Optional() private readonly telemetry?: TelemetryService
    ) {}

    getCapabilities(): ChatCapabilities {
        return {
            streaming: true,
            toolCalls: true,
            // agy records its reasoning in the transcript, never on stdout.
            thinking: false,
            attachments: true,
            multiTurn: true
        }
    }

    async *sendMessage(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage
    ): AsyncIterable<EmittedChatEvent> {
        const tAdapterStart = Date.now()
        // Platform or agy's own sign-in, per turn (resolveTurnConfig): a
        // platform turn carries its modelConfig, a runtime-local one only its
        // tuning, and a turn that resolved neither runs the saved source.
        const turnSource: AgentModelConfigSource | undefined = ctx.modelConfig
            ? 'platform'
            : ctx.runtimeLocalTuning
              ? 'runtime-local'
              : undefined
        const {
            driver,
            daemonId: carryingDaemonId,
            agent,
            creds,
            runtime,
            resolvePriceScope
        } = await this.drivers.forAgent(
            ctx.agentId,
            ctx.agent,
            turnSource,
            ctx.runnerDaemonId ?? undefined
        )
        const runtimeLocal =
            (turnSource ?? effectiveModelConfigSource(agent)) ===
            'runtime-local'
        const stored = runtimeLocal
            ? null
            : ((creds as ResolvedAntigravityCliCredentials | null) ?? null)
        const platformCreds = stored?.googleApiKey ? stored : null
        if (!runtimeLocal && !platformCreds) {
            yield {
                type: 'error',
                error: {
                    code: 'antigravity_credentials_missing',
                    message:
                        "This Antigravity CLI agent has no provider bound. Bind one in its model settings, or switch it to Antigravity CLI's own sign-in on its runtime.",
                    retryable: false
                }
            }
            return
        }
        // agy keeps one conversation cache per working directory and refuses
        // file tools outside its workspace, so it only ever runs there.
        const workspacePath = agent.workspacePath?.trim() || null
        if (!workspacePath) {
            yield {
                type: 'error',
                error: {
                    code: 'antigravity_workspace_missing',
                    message:
                        'This Antigravity CLI agent has no workspace on its runtime.',
                    retryable: false
                }
            }
            return
        }

        const configModel =
            ctx.modelConfig?.framework === 'antigravity-cli'
                ? ctx.modelConfig.model?.trim() || null
                : null
        const model =
            ctx.modelOverride?.trim() ||
            configModel ||
            ctx.model?.trim() ||
            platformCreds?.model?.trim() ||
            null

        // agy mints conversation ids itself; the stored one is what its first
        // turn reported. Without one, the turn carries the chat so far, since
        // the fresh conversation agy opens knows nothing of it.
        const storedRef = ctx.frameworkSessionRef?.trim() || null
        const requestedRef = isAntigravityConversationId(storedRef)
            ? storedRef
            : null
        const prompt = requestedRef
            ? messageToPromptText(userMessage)
            : forkTranscriptPrompt(ctx.history, userMessage, 'Antigravity CLI')

        // --dangerously-skip-permissions: agy's default policy soft-denies
        // every shell command in a headless run and still exits 0.
        // --disable-slash-commands: chat text that starts with `/` is text,
        // never an agy command. The prompt rides stdin as one stream-json
        // line (a fork transcript does not fit in argv); closing stdin ends
        // the session once the turn is done.
        const agyArgs = [
            '--output-format',
            'stream-json',
            '--input-format',
            'stream-json',
            '--dangerously-skip-permissions',
            '--disable-slash-commands'
        ]
        if (model) agyArgs.push('--model', model)
        if (requestedRef) agyArgs.push('--conversation', requestedRef)

        // A headless turn is never a terminal session: the session hooks,
        // which fire in headless runs too, must not report it.
        const managedHost = runtime === 'sprites' || runtime === 'k8s'
        const { cmd, env } = platformCreds
            ? antigravityPlatformExec({
                  agyArgs,
                  runtimeId: agent.runtimeId ?? agent.id,
                  apiKey: platformCreds.googleApiKey,
                  baseUrl: platformCreds.googleGeminiBaseUrl,
                  managedHost
              })
            : {
                  cmd: ['agy', ...agyArgs],
                  env: managedHost ? { ...AGY_MANAGED_HOST_ENV } : {}
              }
        env.MF_TERMINAL_ID = ''

        const execTimeouts = this.adminSettings
            ? await this.adminSettings.getCachedChatExecTimeoutMs()
            : resolveChatExecTimeoutMs(DEFAULT_CHAT_EXEC_TIMEOUTS)

        if (ctx.timings) {
            ctx.timings.setupMs = Date.now() - tAdapterStart
            ctx.timings.execDispatchedAt = Date.now()
        }
        const servedScope = platformCreds
            ? ((await resolvePriceScope?.()) ?? UNKNOWN_PRICE_SCOPE)
            : UNKNOWN_PRICE_SCOPE
        await ctx.onServedPriceScope?.(servedScope)
        ctx = { ...ctx, ...servedScope }
        if (ctx.abortSignal?.aborted) {
            yield {
                type: 'error',
                error: {
                    code: 'cancelled_by_user',
                    message: 'Cancelled by user',
                    retryable: false
                }
            }
            return
        }
        const handle = driver.stream({
            cmd,
            env,
            stdin: `${JSON.stringify({ event: 'user', message: { content: prompt } })}\n`,
            dir: workspacePath,
            timeoutMs: execTimeouts.timeoutMs,
            keepAliveMs: execTimeouts.keepAliveMs,
            livenessTimeoutMs: execTimeouts.livenessTimeoutMs,
            onExecSession: ctx.onExecSession,
            // refId == messageId is what lets the reverse-WS resume path find
            // this stream again by (daemon_id, daemon_exec_ref).
            execHandle: ctx.messageId
        })

        ctx.abortSignal?.addEventListener('abort', () => handle.abort(), {
            once: true
        })

        yield* this.drainStream(handle, ctx, {
            carryingDaemonId,
            requestedRef,
            persistedRef: storedRef,
            // A platform turn is billed under the Gemini API id the gateway
            // served; the machine's own sign-in is priced as the same model.
            usageModel: antigravityUpstreamModel(model)
        })
    }

    // Resume a turn whose exec is still buffered on the daemon that ran it —
    // the same cursor path as codex (see codex.adapter.ts resumeMessage).
    async *resumeMessage(
        ctx: ApiChatResumeContext
    ): AsyncIterable<EmittedChatEvent> {
        const driver = this.drivers.daemonDriverFor(ctx.daemonId)
        if (!ctx.daemonId || !driver.resumeStream) {
            yield {
                type: 'error',
                error: {
                    code: 'antigravity_resume_unsupported',
                    message:
                        'resume requires a daemon transport with resume support',
                    retryable: false
                }
            }
            return
        }
        const execTimeouts = this.adminSettings
            ? await this.adminSettings.getCachedChatExecTimeoutMs()
            : resolveChatExecTimeoutMs(DEFAULT_CHAT_EXEC_TIMEOUTS)
        const handle = driver.resumeStream({
            refId: ctx.daemonExecRef,
            fromSeq: ctx.fromSeq,
            timeoutMs: execTimeouts.timeoutMs
        })
        ctx.abortSignal?.addEventListener('abort', () => handle.abort(), {
            once: true
        })
        const ref = ctx.frameworkSessionRef?.trim() || null
        yield* this.drainStream(handle, ctx, {
            carryingDaemonId: ctx.daemonId,
            requestedRef: isAntigravityConversationId(ref) ? ref : null,
            persistedRef: ref,
            usageModel: antigravityUpstreamModel(ctx.model?.trim() || null),
            resumeAttach: true
        })
    }

    private async *drainStream(
        handle: ExecStreamHandle,
        ctx: ApiChatAdapterContext,
        opts: {
            carryingDaemonId: string | null
            // The conversation this exec was asked to continue, if any.
            requestedRef: string | null
            // What the session row already holds.
            persistedRef: string | null
            usageModel: string
            resumeAttach?: boolean
        }
    ): AsyncIterable<EmittedChatEvent> {
        const { carryingDaemonId } = opts
        let lineBuffer = ''
        let sourceSeq = 0
        let conversationId: string | null = null
        let persistedRef = opts.persistedRef
        // agy writes the prompt to the transcript when it reports the
        // user_input step done; from then on the id is safe to record.
        let promptRecorded = false
        // agy answered the requested `--conversation` with a new one: the
        // conversation this chat continued is gone from the runtime.
        let resumeLost = false
        let streamedText = false
        const openTools = new Set<number>()
        const closedTools = new Set<number>()
        let usage: AgyUsageTotals = {
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            calls: 0
        }
        // Held on an object: the parser below assigns it from inside a
        // generator, where a plain `let` would stay narrowed to null here.
        const turn: { result: AgyResult | null } = { result: null }
        const tStart = Date.now()
        let tFirstToken: number | null = null

        const consumeLine = function* (
            line: string,
            rawLine: string,
            seq: number
        ): Generator<EmittedChatEvent> {
            const parsed = safeParse(line)
            if (!parsed) return
            const event = stringValue(parsed.event)
            const step = isRecord(parsed.step_update)
                ? parsed.step_update
                : null
            const stepIndex =
                step && typeof step.step_index === 'number'
                    ? step.step_index
                    : null
            yield {
                type: 'raw_source',
                source: {
                    sourceRef: conversationId ?? opts.requestedRef,
                    sourceSeq: seq,
                    externalId:
                        stepIndex !== null
                            ? `step-${stepIndex}-${stringValue(step?.state) ?? 'update'}-${seq}`
                            : `${event ?? 'event'}-${seq}`,
                    parentExternalId: null,
                    rawFormat: 'jsonl',
                    rawText: rawLine,
                    parserName: AGY_STREAM_PARSER_NAME,
                    parserVersion: AGY_STREAM_PARSER_VERSION
                }
            }
            if (event === 'init') {
                const id = stringValue(parsed.conversation_id)
                if (
                    id &&
                    opts.requestedRef &&
                    !opts.resumeAttach &&
                    id !== opts.requestedRef
                )
                    resumeLost = true
                conversationId = id ?? conversationId
                return
            }
            if (event === 'step_update' && step) {
                conversationId =
                    stringValue(step.conversation_id) ?? conversationId
                const type = stringValue(step.step_type)
                const done = step.state === 'DONE'
                if (type === 'user_input') {
                    if (done) promptRecorded = true
                    return
                }
                if (type === 'agent_response') {
                    const delta = stringValue(step.text_delta)
                    if (delta) {
                        streamedText = true
                        yield { type: 'token', text: delta }
                    }
                    if (done) usage = addAgyUsage(usage, step.usage)
                    return
                }
                if (type === 'tool' && stepIndex !== null) {
                    const info = isRecord(step.tool_info)
                        ? step.tool_info
                        : null
                    const toolCallId = `agy-${stepIndex}`
                    if (!openTools.has(stepIndex)) {
                        openTools.add(stepIndex)
                        yield {
                            type: 'tool_call',
                            toolCallId,
                            toolName:
                                stringValue(info?.name) ??
                                stringValue(step.tool_name) ??
                                'tool',
                            args: info?.parameters ?? null
                        }
                    }
                    if (done && !closedTools.has(stepIndex)) {
                        closedTools.add(stepIndex)
                        const failure = isRecord(info?.error)
                            ? info.error
                            : null
                        yield {
                            type: 'tool_result',
                            toolCallId,
                            result: {
                                content: info?.output ?? null,
                                details: failure,
                                isError: failure !== null
                            }
                        }
                    }
                }
                return
            }
            if (event === 'result' && isRecord(parsed.result)) {
                const r = parsed.result
                conversationId =
                    stringValue(r.conversation_id) ?? conversationId
                const result: AgyResult = {
                    status: stringValue(r.status),
                    error: stringValue(r.error),
                    response: stringValue(r.response)
                }
                turn.result = result
                if (
                    !streamedText &&
                    result.status === 'SUCCESS' &&
                    result.response
                ) {
                    streamedText = true
                    yield { type: 'token', text: result.response }
                }
            }
        }

        const recordRef = async (): Promise<void> => {
            if (resumeLost || !promptRecorded || !conversationId) return
            if (!isAntigravityConversationId(conversationId)) return
            if (conversationId === persistedRef) return
            persistedRef = conversationId
            await this.chatRepo
                .updateFrameworkSessionRef(
                    ctx.sessionId,
                    conversationId,
                    ctx.turnFence
                )
                .catch((err: Error) => {
                    if (err instanceof TurnFenceLostError) throw err
                    this.logger.warn(
                        `antigravity session-ref persist failed: ${err.message}`
                    )
                })
        }

        // stderr carries agy's AGY_ERROR verdict and its startup failures, and
        // on the daemon transport `result.stderr` is always ''. Drain it
        // alongside stdout into a bounded head + tail (see gemini-cli.adapter).
        let stderrHead = ''
        let stderrTail = ''
        let stderrChars = 0
        const stderrDrained = (async () => {
            try {
                for await (const chunk of handle.stderr) {
                    stderrChars += chunk.length
                    if (stderrHead.length < STDERR_HEAD_CHARS)
                        stderrHead += chunk.slice(
                            0,
                            STDERR_HEAD_CHARS - stderrHead.length
                        )
                    stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
                }
            } catch {
                // The stdout drain reports transport failures on its own.
            }
        })()
        const drainedStderr = (): string => {
            const kept = Math.min(
                stderrHead.length,
                Math.max(0, stderrChars - stderrTail.length)
            )
            return kept
                ? `${stderrHead.slice(0, kept)}${STDERR_ELISION}${stderrTail}`
                : stderrTail
        }

        let transportError: Error | null = null
        try {
            for await (const chunk of handle.stdout) {
                if (ctx.timings && ctx.timings.firstStdoutAt === undefined)
                    ctx.timings.firstStdoutAt = Date.now()
                lineBuffer += chunk
                let nl = lineBuffer.indexOf('\n')
                while (nl !== -1) {
                    const rawLine = lineBuffer.slice(0, nl).replace(/\r$/, '')
                    const line = rawLine.trim()
                    lineBuffer = lineBuffer.slice(nl + 1)
                    nl = lineBuffer.indexOf('\n')
                    if (!line) continue
                    // Resume watermark: the transport seq of the chunk that
                    // completed this line, but only when the chunk ended
                    // exactly here (see codex.adapter for why).
                    const runnerSeq =
                        lineBuffer === ''
                            ? handle.lastDeliveredSeq?.()
                            : undefined
                    for (const ev of consumeLine(line, rawLine, ++sourceSeq)) {
                        if (ev.type === 'token' && tFirstToken === null)
                            tFirstToken = Date.now()
                        yield ev.type === 'raw_source' &&
                        runnerSeq !== undefined
                            ? { ...ev, runnerSeq }
                            : ev
                    }
                    // Stopped before the model is called, so a turn with no
                    // context is never run, let alone billed.
                    if (resumeLost) {
                        handle.abort()
                        break
                    }
                    await recordRef()
                }
                if (resumeLost) break
            }
            const rawTrailing = lineBuffer.replace(/\r$/, '')
            const trailing = rawTrailing.trim()
            if (trailing && !resumeLost) {
                for (const ev of consumeLine(
                    trailing,
                    rawTrailing,
                    ++sourceSeq
                )) {
                    if (ev.type === 'token' && tFirstToken === null)
                        tFirstToken = Date.now()
                    yield ev
                }
                await recordRef()
            }
        } catch (err) {
            if (err instanceof TurnFenceLostError) throw err
            transportError = err as Error
        }

        let execResult: Awaited<typeof handle.result> | null = null
        try {
            execResult = await handle.result
        } catch (err) {
            if (!transportError) transportError = err as Error
        }
        await stderrDrained

        if (resumeLost) {
            yield* this.resumeLostError(ctx, opts.requestedRef!)
            return
        }

        if (transportError) {
            const suspendable = opts.resumeAttach
                ? isDaemonResumeSuspendError(transportError)
                : isDaemonOfflineTransportError(transportError)
            if (carryingDaemonId && suspendable) {
                this.logger.log(
                    `antigravity exec suspended (daemon offline) agent=${ctx.agentId} session=${ctx.sessionId} message=${ctx.messageId}`
                )
                yield {
                    type: 'suspended',
                    daemonId: carryingDaemonId,
                    daemonExecRef: ctx.messageId,
                    reason: transportError.message
                }
                return
            }
            this.logger.warn(
                `antigravity exec transport error: ${transportError.message}`
            )
            yield {
                type: 'error',
                error: {
                    code: 'antigravity_exec_failed',
                    message: transportError.message,
                    retryable: true
                }
            }
            return
        }

        // agy has exited, so its log is settled; taken before `done` releases
        // the session's turn slot.
        await this.recordTranscriptCursor(ctx, persistedRef)

        const stderr = redactSecrets(
            drainedStderr() || execResult?.stderr || ''
        ).trim()
        const agyError = parseAgyErrorLine(stderr)
        const exitCode = execResult?.exitCode ?? null
        const finished = turn.result?.status === 'SUCCESS' && exitCode === 0

        if (!finished) {
            yield this.failureEvent(stderr, agyError, turn.result, exitCode)
            return
        }

        if (usage.calls > 0) {
            const cost = this.pricing.computeCost({
                model: opts.usageModel,
                inputTokens: usage.inputTokens,
                outputTokens: usage.outputTokens,
                cacheReadTokens: usage.cacheReadTokens,
                cacheCreationTokens: 0,
                modelProviderId: ctx.modelProviderId ?? null,
                modelProviderBuiltInId: ctx.modelProviderBuiltInId ?? null,
                modelProviderManagedBrand: ctx.modelProviderManagedBrand ?? null
            })
            yield {
                type: 'usage',
                usage: {
                    model: opts.usageModel,
                    inputTokens: usage.inputTokens,
                    outputTokens: usage.outputTokens,
                    cacheReadTokens: usage.cacheReadTokens,
                    cacheCreationTokens: 0,
                    costUsd: cost.costUsd,
                    costSource: cost.costSource,
                    firstTokenMs:
                        tFirstToken !== null ? tFirstToken - tStart : null,
                    totalMs: Date.now() - tStart
                }
            }
        }

        yield { type: 'done', finalMessageId: ctx.messageId }
    }

    // Every step agy logged this turn already reached the cloud through the
    // stream, and the runtime-session sync must not read the log back as
    // something a terminal added; the line count it holds when agy exits is
    // where that sync starts (see pi.adapter). A turn whose stream was lost
    // does not count, as agy may still be writing. Costs one exec.
    private async recordTranscriptCursor(
        ctx: ApiChatAdapterContext,
        ref: string | null
    ): Promise<void> {
        if (!ref || !isAntigravityConversationId(ref)) return
        let cursor: number | null = null
        try {
            const handle = await this.drivers.recoveryFsForAgent(ctx.agentId)
            try {
                cursor = parseAntigravityTranscriptLineCount(
                    await handle.fs.exec(
                        antigravityTranscriptLineCountScript(ref)
                    )
                )
            } finally {
                await handle.awakeHold?.release()
            }
        } catch (err) {
            this.logger.warn(
                `antigravity transcript line count failed agent=${ctx.agentId} session=${ctx.sessionId}: ${(err as Error).message}`
            )
        }
        // Left where it was rather than cleared: a stale cursor re-offers this
        // one turn to the sync, a cleared one sends the whole conversation
        // through its content diff.
        if (cursor === null) {
            this.logger.warn(
                `antigravity transcript cursor unavailable agent=${ctx.agentId} session=${ctx.sessionId} ref=${ref}; runtime-sync cursor left unchanged`
            )
            return
        }
        await this.chatRepo
            .setRuntimeSyncCursor(ctx.sessionId, cursor, ctx.turnFence)
            .catch((err: Error) => {
                if (err instanceof TurnFenceLostError) throw err
                this.logger.warn(
                    `antigravity transcript cursor persist failed session=${ctx.sessionId}: ${err.message}`
                )
            })
    }

    // The one ref-clear agy earns: it said the requested conversation does
    // not exist and opened another. Cleared only if the row still names the
    // ref this turn asked for, so a newer one written meanwhile survives; the
    // retry then carries the chat as a transcript, as a first turn does.
    private async *resumeLostError(
        ctx: ApiChatAdapterContext,
        attemptedRef: string
    ): AsyncIterable<EmittedChatEvent> {
        let outcome: 'cleared' | 'state_changed' | 'clear_failed' =
            'clear_failed'
        try {
            outcome = (await this.chatRepo.clearFrameworkSessionRefIfMatches(
                ctx.sessionId,
                attemptedRef,
                ctx.turnFence
            ))
                ? 'cleared'
                : 'state_changed'
        } catch (err) {
            if (err instanceof TurnFenceLostError) throw err
            this.logger.warn('antigravity lost-conversation ref clear failed')
        }
        this.logger.warn(
            `antigravity conversation gone agent=${ctx.agentId} session=${ctx.sessionId} ref=${attemptedRef} outcome=${outcome}`
        )
        this.telemetry?.event('chat.antigravity.resume_lost', { outcome })
        yield {
            type: 'error',
            error: {
                code: 'antigravity_resume_lost',
                message:
                    outcome === 'clear_failed'
                        ? 'The Antigravity CLI conversation this chat continued is gone from its runtime.'
                        : 'The Antigravity CLI conversation this chat continued is gone from its runtime. Retry to continue from the chat history.',
                retryable: outcome !== 'clear_failed'
            }
        }
    }

    private failureEvent(
        stderr: string,
        agyError: AgyErrorLine | null,
        result: AgyResult | null,
        exitCode: number | null
    ): EmittedChatEvent {
        if (AGY_SIGN_IN_REQUIRED.test(stderr))
            return {
                type: 'error',
                error: {
                    code: 'antigravity_sign_in_required',
                    message:
                        "Antigravity CLI is not signed in on this agent's runtime. Open the agent's terminal and run `agy` to sign in, or bind a provider in its model settings.",
                    retryable: false
                }
            }
        // The model or agent failed and agy said so (exit 3, AGY_ERROR); the
        // upstream's own message sits in short_error after `Message:`.
        if (agyError || result) {
            const message =
                agyError?.shortError ??
                result?.error ??
                `agy ended the turn with status ${result?.status ?? 'unknown'}`
            const managedChannelFailure = classifyAntigravityFailureSignal(
                agyError?.shortError ?? null
            )
            return {
                type: 'error',
                ...(managedChannelFailure ? { managedChannelFailure } : {}),
                error: {
                    code: 'antigravity_result_error',
                    message: message.slice(0, 1024),
                    retryable: agyError?.retryable === true
                }
            }
        }
        // No verdict at all: the process died before agy could give one (a
        // signal reads as exit 0 on the daemon transport).
        return {
            type: 'error',
            error: {
                code: 'antigravity_exec_failed',
                message: `agy exited ${exitCode ?? 'without a status'}${stderr ? `: ${stderr.slice(0, 512)}` : ''}`,
                retryable:
                    exitCode === 0 || exitCode === 124 || exitCode === null
            }
        }
    }
}

// Per model call, as agy reports it on each agent_response step: input
// without the cache reads, output with the thinking tokens already in it.
// Stored the way Gemini CLI's usage is (input counting cached tokens), which
// is what computeCost expects. A resumed conversation's `result` usage is the
// whole conversation's, so the result line is never what bills a turn.
const addAgyUsage = (totals: AgyUsageTotals, raw: unknown): AgyUsageTotals => {
    if (!isRecord(raw)) return totals
    const cacheRead = toInt(raw.cache_read_tokens)
    return {
        inputTokens: totals.inputTokens + toInt(raw.input_tokens) + cacheRead,
        outputTokens: totals.outputTokens + toInt(raw.output_tokens),
        cacheReadTokens: totals.cacheReadTokens + cacheRead,
        calls: totals.calls + 1
    }
}

const parseAgyErrorLine = (stderr: string): AgyErrorLine | null => {
    const match = AGY_ERROR_LINE.exec(stderr)
    const parsed = match ? safeParse(match[1]) : null
    if (!parsed) return null
    return {
        shortError: stringValue(parsed.short_error),
        retryable: parsed.retryable === true
    }
}

const safeParse = (line: string): Record<string, unknown> | null => {
    try {
        const parsed: unknown = JSON.parse(line)
        return isRecord(parsed) ? parsed : null
    } catch {
        return null
    }
}

const stringValue = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null

const toInt = (v: unknown): number =>
    typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)
