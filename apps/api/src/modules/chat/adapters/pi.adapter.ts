import {
    AgentFramework,
    ChatCapabilities,
    ChatMessage,
    DEFAULT_CHAT_EXEC_TIMEOUTS,
    PI_API_KEY_ENV,
    PI_OUTRANKING_KEY_ENV,
    isOfficialPiBaseUrl,
    piModelId,
    piQualifiedModel,
    resolveChatExecTimeoutMs
} from '@manyfold/shared'
import { Injectable, Logger, Optional } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { ResolvedPiCredentials } from '@/modules/agents/credentials/resolved-credentials'
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
import { classifyManagedChannelFailureSignal } from '@/modules/chat/managed-channel-failure-signal'
import { TurnFenceLostError } from '@/modules/chat/turn-fence'
import { isManagedSkillWorkspace } from '@/modules/skills/skill-utils'
import { redactSecrets } from './claude-stream-consumer'
import {
    parsePiSessionLineCount,
    piSessionLineCountScript
} from '@/modules/chat/recovery/readers/pi-reader'
import { forkTranscriptPrompt } from './fork-transcript-prompt'
import { messageToPromptText } from './message-content'
import {
    addPiUsage,
    emptyPiUsageTotals,
    piUsageToChatUsage,
    sumPiUsage,
    type PiUsageTotals
} from './pi-usage'

export const PI_STREAM_PARSER_NAME = 'pi-mode-json'
export const PI_STREAM_PARSER_VERSION = '1'

// pi refuses to open a session whose recorded cwd is gone (exit 1, this line
// on stderr, nothing on stdout). Measured on macOS dev [2026-09-10] with pi
// 0.85.1. The session cannot be resumed from this workspace any more, so the
// ref is cleared and the next turn starts fresh — the one pi-side failure
// that is a verdict on the ref rather than on the turn.
export const PI_SESSION_CWD_MISSING_SIGNATURE =
    /Stored session working directory does not exist/

const STDERR_HEAD_CHARS = 512
const STDERR_TAIL_CHARS = 4000
const STDERR_ELISION = '\n… [stderr elided] …\n'

@Injectable()
export class PiAdapter implements ApiChatAdapter {
    readonly framework: AgentFramework = 'pi'
    private readonly logger = new Logger(PiAdapter.name)

    constructor(
        private readonly drivers: ExecDriverFactory,
        private readonly chatRepo: ChatRepository,
        private readonly pricing: UsagePricingService,
        @Optional() private readonly adminSettings?: AdminSettingsService
    ) {}

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
        const tAdapterStart = Date.now()
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
            undefined,
            ctx.runnerDaemonId ?? undefined
        )
        // A sandbox or pod always has a credential row (the factory refuses
        // the turn before this point when it does not). A daemon is the
        // user's own machine: no row means pi's own login there is the
        // intended account (the framework's version of runtime-local).
        const piCreds = (creds as ResolvedPiCredentials | null) ?? null
        if (
            piCreds &&
            runtime === 'daemon' &&
            !isOfficialPiBaseUrl(piCreds.provider, piCreds.baseUrl)
        ) {
            yield {
                type: 'error',
                error: {
                    code: 'pi_base_url_unsupported',
                    message: `pi on a daemon runtime cannot use a custom base URL (${piCreds.baseUrl}); pick the official ${piCreds.provider} endpoint or run this agent on a sandbox`,
                    retryable: false
                }
            }
            return
        }

        // pi's default provider follows whatever credentials the host has, so
        // the model is always passed fully qualified once a provider is known
        // (see piQualifiedModel for what the id is on a gateway). A qualified
        // id naming another vendor would authenticate against the wrong key
        // and is refused outright.
        const requestedModel =
            ctx.modelOverride?.trim() ||
            ctx.model?.trim() ||
            piCreds?.model?.trim() ||
            null
        let cliModel: string | null = requestedModel
        if (piCreds) {
            const qualified = piQualifiedModel(
                requestedModel,
                piCreds.provider,
                piCreds.baseUrl
            )
            if (qualified.providerMismatch) {
                yield {
                    type: 'error',
                    error: {
                        code: 'pi_model_provider_mismatch',
                        message: `model ${requestedModel} targets provider ${qualified.providerMismatch}, but this agent's credentials are for ${piCreds.provider}`,
                        retryable: false
                    }
                }
                return
            }
            cliModel = qualified.model
        }

        // Manyfold mints the pi session id: `--session-id` opens the exact
        // session in this cwd or creates it under that id, so the first turn
        // and every later one share one argv shape. The minted id is recorded
        // only once pi has written the session file (its first assistant
        // message, see drainPiStream): a ref pointing at a file that was never
        // written would make the next turn open an empty session and send it
        // only the latest message, losing the transcript this one carries.
        const existingRef = ctx.frameworkSessionRef?.trim() || null
        const sessionRef = existingRef ?? this.mintSessionId()
        const prompt = existingRef
            ? messageToPromptText(userMessage)
            : forkTranscriptPrompt(ctx.history, userMessage, 'Pi')

        // --no-extensions: an extension can open a UI dialog
        // (extension_ui_request) that nothing answers in json mode, hanging
        // the turn. Skills are unaffected (measured on macOS dev [2026-09-10]).
        // The prompt rides stdin, which pi reads whenever it is not a TTY
        // (a fork transcript would not fit in argv); never also as a
        // positional — pi concatenates the two into one message.
        const cmd = [
            'pi',
            '--mode',
            'json',
            '--no-extensions',
            '--session-id',
            sessionRef
        ]
        if (cliModel) cmd.push('--model', cliModel)
        // pi treats `<cwd>/.agents/skills` as a project resource and, without a
        // TTY, silently skips it unless the project is trusted. A managed
        // workspace holds only what the platform activated there, so trusting
        // it is what makes the agent's installed skills load.
        if (agent.workspacePath && isManagedSkillWorkspace(agent.workspacePath))
            cmd.push('--approve')

        // The key rides each exec; nothing is written to the runtime. Not
        // gated on modelConfig the way codex/claude are — pi has no
        // runtime-local mode, a credential row IS the decision to use it, so
        // the vars pi would read ahead of it are blanked (see
        // PI_OUTRANKING_KEY_ENV). PI_OFFLINE keeps every turn off pi.dev
        // (update check, telemetry).
        const env: Record<string, string> = { PI_OFFLINE: '1' }
        if (piCreds) {
            for (const outranking of PI_OUTRANKING_KEY_ENV[piCreds.provider])
                env[outranking] = ''
            env[PI_API_KEY_ENV[piCreds.provider]] = piCreds.apiKey
        }

        const execTimeouts = this.adminSettings
            ? await this.adminSettings.getCachedChatExecTimeoutMs()
            : resolveChatExecTimeoutMs(DEFAULT_CHAT_EXEC_TIMEOUTS)

        if (ctx.timings) {
            ctx.timings.setupMs = Date.now() - tAdapterStart
            ctx.timings.execDispatchedAt = Date.now()
        }
        const servedScope = piCreds
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
            stdin: prompt,
            dir: agent.workspacePath ?? undefined,
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

        yield* this.drainPiStream(handle, ctx, {
            carryingDaemonId,
            sessionRef,
            persistedRef: existingRef,
            usageFallbackModel:
                cliModel && piCreds ? piModelId(cliModel) : cliModel
        })
    }

    // Overridable so a test can replay a captured pi stream whose header
    // names a known id; production always mints a fresh UUID.
    protected mintSessionId(): string {
        return randomUUID()
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
                    code: 'pi_resume_unsupported',
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
        yield* this.drainPiStream(handle, ctx, {
            carryingDaemonId: ctx.daemonId,
            sessionRef: ref,
            persistedRef: ref,
            usageFallbackModel: ctx.model?.trim() || null,
            resumeAttach: true
        })
    }

    private async *drainPiStream(
        handle: ExecStreamHandle,
        ctx: ApiChatAdapterContext,
        opts: {
            carryingDaemonId: string | null
            // The id this exec runs under: minted or resumed on a send, the
            // stored ref (if any) on a resume, where the header may be past
            // the replay cursor.
            sessionRef: string | null
            // What the session row already holds.
            persistedRef: string | null
            usageFallbackModel: string | null
            resumeAttach?: boolean
        }
    ): AsyncIterable<EmittedChatEvent> {
        const { carryingDaemonId } = opts
        let lineBuffer = ''
        let sourceSeq = 0
        let headerId: string | null = null
        let persistedRef = opts.persistedRef
        // pi writes the session file with its first assistant message; from
        // then on the id is safe to record.
        let sessionFileWritten = false
        // Text streamed for the assistant message currently open, so the
        // authoritative message_end can top it up when a provider sent no
        // deltas, without repeating what already went out. A message whose
        // start lies before a resume cursor is never topped up: what streamed
        // of it before the cursor is not known here.
        let streamedText = ''
        let messageOpen = false
        // A failed attempt's text stays in the answer, so the retried one
        // starts a new paragraph instead of running on from mid-sentence.
        let separateNextText = false
        // Usage per run: agent_end carries every message that run generated,
        // so the total survives a resume cursor past the individual
        // message_end lines. Streamed message_end usage only stands in when no
        // run finished. Compaction and cache warming bill outside any message.
        let runUsage: PiUsageTotals = emptyPiUsageTotals()
        let streamedUsage: PiUsageTotals = emptyPiUsageTotals()
        let sideUsage: PiUsageTotals = emptyPiUsageTotals()
        let sawAgentEnd = false
        let usageModel: string | null = null
        // The latest assistant message's failure: pi retries overloaded and
        // transient errors itself (and compacts on overflow), so an error is
        // the turn's verdict only when no later message succeeded.
        let resultError: string | null = null
        const tStart = Date.now()
        let tFirstToken: number | null = null
        const logger = this.logger

        const text = function* (delta: string): Generator<EmittedChatEvent> {
            if (separateNextText) {
                separateNextText = false
                yield { type: 'token', text: '\n\n' }
            }
            yield { type: 'token', text: delta }
        }

        const consumeLine = function* (
            line: string,
            rawLine: string,
            seq: number
        ): Generator<EmittedChatEvent> {
            const parsed = safeParse(line)
            if (!parsed) return
            const type = stringValue(parsed.type)
            yield {
                type: 'raw_source',
                source: {
                    sourceRef: headerId ?? opts.sessionRef,
                    sourceSeq: seq,
                    externalId: externalIdFor(parsed, type, seq),
                    parentExternalId: null,
                    rawFormat: 'jsonl',
                    rawText: rawLine,
                    parserName: PI_STREAM_PARSER_NAME,
                    parserVersion: PI_STREAM_PARSER_VERSION
                }
            }
            if (type === 'session') {
                const id = stringValue(parsed.id)
                if (id) {
                    if (opts.sessionRef && id !== opts.sessionRef)
                        logger.warn(
                            `pi session id mismatch agent=${ctx.agentId} session=${ctx.sessionId} asked=${opts.sessionRef} got=${id}`
                        )
                    headerId = id
                }
                return
            }
            const message = isRecord(parsed.message) ? parsed.message : null
            if (type === 'message_start') {
                if (message?.role === 'assistant') {
                    streamedText = ''
                    messageOpen = true
                }
                return
            }
            if (type === 'message_update') {
                const ev = isRecord(parsed.assistantMessageEvent)
                    ? parsed.assistantMessageEvent
                    : null
                if (!ev) return
                const delta = stringValue(ev.delta)
                if (ev.type === 'text_delta' && delta) {
                    streamedText += delta
                    yield* text(delta)
                } else if (ev.type === 'thinking_delta' && delta) {
                    yield { type: 'thinking', text: delta }
                }
                return
            }
            if (type === 'message_end') {
                if (!message || message.role !== 'assistant') return
                sessionFileWritten = true
                streamedUsage = addPiUsage(streamedUsage, message.usage)
                usageModel = stringValue(message.model) ?? usageModel
                const full = assistantText(message.content)
                if (full && messageOpen) {
                    if (!streamedText) yield* text(full)
                    else if (
                        full.length > streamedText.length &&
                        full.startsWith(streamedText)
                    )
                        yield* text(full.slice(streamedText.length))
                }
                const stopReason = stringValue(message.stopReason)
                resultError =
                    stopReason === 'error' || stopReason === 'aborted'
                        ? (stringValue(message.errorMessage) ??
                          `pi ${stopReason === 'error' ? 'reported a model error' : 'aborted the turn'}`)
                        : null
                if (resultError && streamedText) separateNextText = true
                streamedText = ''
                messageOpen = false
                return
            }
            if (type === 'agent_end') {
                sawAgentEnd = true
                if (Array.isArray(parsed.messages))
                    for (const m of parsed.messages)
                        if (isRecord(m) && m.role === 'assistant') {
                            runUsage = addPiUsage(runUsage, m.usage)
                            usageModel = stringValue(m.model) ?? usageModel
                        }
                return
            }
            if (type === 'compaction_end') {
                const result = isRecord(parsed.result) ? parsed.result : null
                if (result?.usage)
                    sideUsage = addPiUsage(sideUsage, result.usage)
                return
            }
            if (type === 'entry_appended') {
                const entry = isRecord(parsed.entry) ? parsed.entry : null
                if (entry?.type === 'usage' && entry.usage)
                    sideUsage = addPiUsage(sideUsage, entry.usage)
                return
            }
            if (type === 'tool_execution_start') {
                const toolCallId = stringValue(parsed.toolCallId)
                if (!toolCallId) return
                yield {
                    type: 'tool_call',
                    toolCallId,
                    toolName: stringValue(parsed.toolName) ?? 'tool',
                    args: parsed.args ?? null
                }
                return
            }
            if (type === 'tool_execution_end') {
                const toolCallId = stringValue(parsed.toolCallId)
                if (!toolCallId) return
                const result = isRecord(parsed.result) ? parsed.result : null
                yield {
                    type: 'tool_result',
                    toolCallId,
                    result: {
                        content: result?.content ?? parsed.result ?? null,
                        details: result?.details ?? null,
                        isError: parsed.isError === true
                    }
                }
                return
            }
            if (type === 'extension_error')
                logger.warn(
                    `pi extension error agent=${ctx.agentId}: ${stringValue(parsed.error) ?? 'unknown'}`
                )
        }

        const recordRef = async (): Promise<void> => {
            const ref = headerId ?? opts.sessionRef
            if (!sessionFileWritten || !ref || ref === persistedRef) return
            persistedRef = ref
            await this.chatRepo
                .updateFrameworkSessionRef(ctx.sessionId, ref, ctx.turnFence)
                .catch((err: Error) => {
                    if (err instanceof TurnFenceLostError) throw err
                    this.logger.warn(
                        `pi session-ref persist failed: ${err.message}`
                    )
                })
        }

        // stderr is the only place pi's startup failures land, and on the
        // daemon transport `result.stderr` is always ''. Drain it alongside
        // stdout into a bounded head + tail (see gemini-cli.adapter).
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
                    await recordRef()
                }
            }
            const rawTrailing = lineBuffer.replace(/\r$/, '')
            const trailing = rawTrailing.trim()
            if (trailing) {
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

        if (transportError) {
            const suspendable = opts.resumeAttach
                ? isDaemonResumeSuspendError(transportError)
                : isDaemonOfflineTransportError(transportError)
            if (carryingDaemonId && suspendable) {
                this.logger.log(
                    `pi exec suspended (daemon offline) agent=${ctx.agentId} session=${ctx.sessionId} message=${ctx.messageId}`
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
                `pi exec transport error: ${transportError.message}`
            )
            yield {
                type: 'error',
                error: {
                    code: 'pi_exec_failed',
                    message: transportError.message,
                    retryable: true
                }
            }
            return
        }

        const stderr = redactSecrets(
            drainedStderr() || execResult?.stderr || ''
        ).trim()

        if (execResult && execResult.exitCode !== 0) {
            const failureDetail = stderr || resultError || ''
            const managedChannelFailure = classifyManagedChannelFailureSignal({
                status: null,
                message: failureDetail
            })
            const cwdMissing =
                !!ctx.frameworkSessionRef &&
                PI_SESSION_CWD_MISSING_SIGNATURE.test(failureDetail)
            if (cwdMissing)
                await this.chatRepo
                    .updateFrameworkSessionRef(
                        ctx.sessionId,
                        null,
                        ctx.turnFence
                    )
                    .then(() =>
                        this.logger.warn(
                            `pi session cwd missing agent=${ctx.agentId} session=${ctx.sessionId} ref=${ctx.frameworkSessionRef} — cleared frameworkSessionRef so the next turn starts a fresh session`
                        )
                    )
                    .catch((err: Error) => {
                        if (err instanceof TurnFenceLostError) throw err
                        this.logger.warn(
                            `pi session ref-clear failed session=${ctx.sessionId}: ${err.message}`
                        )
                    })
            else await this.recordTranscriptCursor(ctx, persistedRef)
            yield {
                type: 'error',
                ...(managedChannelFailure ? { managedChannelFailure } : {}),
                error: {
                    code: 'pi_exec_failed',
                    message: `pi exited ${execResult.exitCode}: ${failureDetail.slice(0, 512)}`,
                    retryable: execResult.exitCode === 124
                }
            }
            return
        }

        await this.recordTranscriptCursor(ctx, persistedRef)

        // Measured on macOS dev [2026-09-23] with pi 0.87.1: a provider 401
        // ends the turn with stopReason 'error' on the assistant message and
        // exit code 0 — the stream is the only place the failure shows. A 529
        // that pi retried ends with the retried message's success instead.
        if (resultError) {
            const managedChannelFailure = classifyManagedChannelFailureSignal({
                status: null,
                message: resultError
            })
            yield {
                type: 'error',
                ...(managedChannelFailure ? { managedChannelFailure } : {}),
                error: {
                    code: 'pi_result_error',
                    message: stderr
                        ? `${resultError}\n\nstderr: ${stderr.slice(0, 512)}`
                        : resultError,
                    retryable: false
                }
            }
            return
        }

        const usage = sumPiUsage(
            sawAgentEnd ? runUsage : streamedUsage,
            sideUsage
        )
        if (usage.messages > 0)
            yield {
                type: 'usage',
                usage: piUsageToChatUsage(
                    usage,
                    usageModel ?? opts.usageFallbackModel,
                    tStart,
                    tFirstToken,
                    this.pricing,
                    {
                        fallbackModelIsAssumed: !usageModel,
                        scope: {
                            modelProviderId: ctx.modelProviderId,
                            modelProviderBuiltInId: ctx.modelProviderBuiltInId,
                            modelProviderManagedBrand:
                                ctx.modelProviderManagedBrand
                        }
                    }
                )
            }

        yield { type: 'done', finalMessageId: ctx.messageId }
    }

    // Every line pi wrote this turn already reached the cloud through the
    // stream, and the runtime-session sync must not read the session file
    // back as something a TUI added. Content cannot be trusted to tell them
    // apart — the file carries the prompt pi was given (a fork transcript
    // included) and one entry per assistant message where the stream made one
    // reply — but a line count can: the sync only takes what lies past it.
    // Taken once pi has exited, so the file is settled, and before `done`
    // releases the session's turn slot; a turn whose stream was lost does not
    // count, since pi may still be writing. Costs one exec.
    private async recordTranscriptCursor(
        ctx: ApiChatAdapterContext,
        ref: string | null
    ): Promise<void> {
        if (!ref) return
        let cursor: number | null = null
        try {
            const handle = await this.drivers.recoveryFsForAgent(ctx.agentId)
            try {
                cursor = parsePiSessionLineCount(
                    await handle.fs.exec(
                        piSessionLineCountScript(
                            ref,
                            handle.agent.workspacePath
                        )
                    )
                )
            } finally {
                await handle.awakeHold?.release()
            }
        } catch (err) {
            this.logger.warn(
                `pi session line count failed agent=${ctx.agentId} session=${ctx.sessionId}: ${(err as Error).message}`
            )
        }
        // Left where it was rather than cleared: a stale cursor re-offers this
        // one turn to the sync, a cleared one sends the whole session through
        // the content diff described above.
        if (cursor === null) {
            this.logger.warn(
                `pi session cursor unavailable agent=${ctx.agentId} session=${ctx.sessionId} ref=${ref}; runtime-sync cursor left unchanged`
            )
            return
        }
        await this.chatRepo
            .setRuntimeSyncCursor(ctx.sessionId, cursor, ctx.turnFence)
            .catch((err: Error) => {
                if (err instanceof TurnFenceLostError) throw err
                this.logger.warn(
                    `pi session cursor persist failed session=${ctx.sessionId}: ${err.message}`
                )
            })
    }
}

const externalIdFor = (
    parsed: Record<string, unknown>,
    type: string | null,
    seq: number
): string => {
    const toolCallId = stringValue(parsed.toolCallId)
    if (toolCallId && type) return `${type}-${toolCallId}`
    const message = isRecord(parsed.message) ? parsed.message : null
    const responseId = message ? stringValue(message.responseId) : null
    if (type === 'message_end' && responseId) return responseId
    return `${type ?? 'event'}-${seq}`
}

// The visible text of an assistant message: its text blocks in order.
const assistantText = (content: unknown): string => {
    if (!Array.isArray(content)) return ''
    return content
        .map((block) =>
            isRecord(block) && block.type === 'text'
                ? (stringValue(block.text) ?? '')
                : ''
        )
        .join('')
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

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null
