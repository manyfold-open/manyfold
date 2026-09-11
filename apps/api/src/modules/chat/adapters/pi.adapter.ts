import {
    AgentFramework,
    ChatCapabilities,
    ChatMessage,
    DEFAULT_CHAT_EXEC_TIMEOUTS,
    PI_API_KEY_ENV,
    isOfficialPiBaseUrl,
    piQualifiedModel,
    resolveChatExecTimeoutMs
} from '@manyfold/shared'
import { Injectable, Logger, Optional } from '@nestjs/common'
import { randomUUID } from 'node:crypto'
import type { ResolvedPiCredentials } from '@/modules/agents/credentials/resolved-credentials'
import { UsagePricingService } from '@/modules/usage/usage-pricing.service'
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
import { forkTranscriptPrompt } from './fork-transcript-prompt'
import { messageToPromptText } from './message-content'
import {
    addPiUsage,
    emptyPiUsageTotals,
    piUsageToChatUsage,
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
            driver: spriteDriver,
            agent,
            creds,
            runtime,
            baseEnv,
            authContext
        } = await this.drivers.forAgent(ctx.agentId, ctx.agent)
        // Only the TRANSPORT changes for a runner turn — `runtime` stays
        // 'sprites', so credentials and workspace keep their sprite meaning.
        // See claude-code.adapter, including why baseEnv rides along (#581).
        const viaRunner = !!ctx.runnerDaemonId
        const driver = ctx.runnerDaemonId
            ? this.drivers.daemonDriverFor(
                  ctx.runnerDaemonId,
                  baseEnv,
                  authContext
              )
            : spriteDriver
        const carryingDaemonId =
            runtime === 'daemon' ? agent.daemonId : (ctx.runnerDaemonId ?? null)
        const piCreds = (creds as ResolvedPiCredentials | null) ?? null

        // A sandbox has no ambient login, so a pi agent without a credential
        // row can only fail inside pi ("No API key found for anthropic.", exit
        // 1) — refuse before the exec with the fix in the message. A daemon is
        // the user's own machine: no row means pi's own login there is the
        // intended account (the framework's version of runtime-local).
        if (!piCreds && runtime !== 'daemon') {
            yield {
                type: 'error',
                error: {
                    code: 'pi_credentials_missing',
                    message:
                        'this pi agent has no model credentials — attach a saved provider or an API key in Agent settings → Credentials',
                    retryable: false
                }
            }
            return
        }
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
        // the model is always passed fully qualified once a provider is known.
        // A bare id from the composer/agent row gets the credential's provider;
        // a qualified id naming another vendor would authenticate against the
        // wrong key and is refused outright.
        const requestedModel =
            ctx.modelOverride?.trim() ||
            ctx.model?.trim() ||
            piCreds?.model?.trim() ||
            null
        let cliModel: string | null = requestedModel
        if (piCreds) {
            const qualified = piQualifiedModel(requestedModel, piCreds.provider)
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
        // and every later one share one argv shape and the ref never depends
        // on parsing stdout. Persisted BEFORE the exec because pi only writes
        // the file on its first assistant message — a turn that dies earlier
        // would otherwise leave the next one minting a second id.
        const existingRef = ctx.frameworkSessionRef?.trim() || null
        const sessionRef = existingRef ?? this.mintSessionId()
        if (!existingRef)
            await this.chatRepo
                .updateFrameworkSessionRef(
                    ctx.sessionId,
                    sessionRef,
                    ctx.turnFence
                )
                .catch((err: Error) => {
                    if (err instanceof TurnFenceLostError) throw err
                    this.logger.warn(
                        `pi session-ref persist failed: ${err.message}`
                    )
                })
        const prompt = existingRef
            ? messageToPromptText(userMessage)
            : forkTranscriptPrompt(ctx.history, userMessage, 'Pi')

        // --no-extensions: an extension can open a UI dialog
        // (extension_ui_request) that nothing answers in json mode, hanging
        // the turn. Skills are unaffected (measured on macOS dev [2026-09-10]).
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
        // See claude-code adapter: daemon CLIs <= 0.11 drop the stdin field
        // of the exec.start RPC, so the daemon runtime gets the prompt as a
        // positional (after `--`, prompts may start with a dash). Sprite/k8s
        // keep stdin, which pi reads whenever it is not a TTY (avoids 414 when
        // the prompt embeds a long fork transcript). Never both: pi
        // concatenates stdin and the positional into one message.
        const promptViaArgv = runtime === 'daemon'
        if (promptViaArgv) cmd.push('--', prompt)

        // The key rides each exec; nothing is written to the runtime. Not
        // gated on modelConfig the way codex/claude are — pi has no
        // runtime-local mode, a credential row IS the decision to use it.
        // PI_OFFLINE keeps every turn off pi.dev (update check, telemetry).
        const env: Record<string, string> = { PI_OFFLINE: '1' }
        if (piCreds) env[PI_API_KEY_ENV[piCreds.provider]] = piCreds.apiKey

        const execTimeouts = this.adminSettings
            ? await this.adminSettings.getCachedChatExecTimeoutMs()
            : resolveChatExecTimeoutMs(DEFAULT_CHAT_EXEC_TIMEOUTS)

        if (ctx.timings) {
            ctx.timings.setupMs = Date.now() - tAdapterStart
            ctx.timings.execDispatchedAt = Date.now()
        }
        const handle = driver.stream({
            cmd,
            env,
            stdin: promptViaArgv ? '' : prompt,
            dir: agent.workspacePath ?? undefined,
            timeoutMs: execTimeouts.timeoutMs,
            keepAliveMs: execTimeouts.keepAliveMs,
            livenessTimeoutMs: execTimeouts.livenessTimeoutMs,
            onExecSession: ctx.onExecSession,
            // refId == messageId is what lets the reverse-WS resume path find
            // this stream again by (daemon_id, daemon_exec_ref).
            ...((runtime === 'daemon' && agent.daemonId) || viaRunner
                ? { execHandle: ctx.messageId }
                : {})
        })

        ctx.abortSignal?.addEventListener('abort', () => handle.abort(), {
            once: true
        })

        yield* this.drainPiStream(handle, ctx, {
            carryingDaemonId,
            sessionRef,
            usageFallbackModel: cliModel
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
        yield* this.drainPiStream(handle, ctx, {
            carryingDaemonId: ctx.daemonId,
            sessionRef: ctx.frameworkSessionRef?.trim() || null,
            usageFallbackModel: ctx.model?.trim() || null,
            resumeAttach: true
        })
    }

    private async *drainPiStream(
        handle: ExecStreamHandle,
        ctx: ApiChatAdapterContext,
        opts: {
            carryingDaemonId: string | null
            sessionRef: string | null
            usageFallbackModel: string | null
            resumeAttach?: boolean
        }
    ): AsyncIterable<EmittedChatEvent> {
        const { carryingDaemonId } = opts
        let emittedText = false
        let lineBuffer = ''
        let sourceSeq = 0
        let headerId: string | null = null
        // Text streamed for the assistant message currently open, so the
        // authoritative message_end can top it up when a provider sent no
        // deltas, without repeating what already went out.
        let streamedText = ''
        let usage: PiUsageTotals = emptyPiUsageTotals()
        let usageModel: string | null = null
        let resultError: string | null = null
        const tStart = Date.now()
        let tFirstToken: number | null = null
        const logger = this.logger

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
                if (message?.role === 'assistant') streamedText = ''
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
                    emittedText = true
                    yield { type: 'token', text: delta }
                } else if (ev.type === 'thinking_delta' && delta) {
                    yield { type: 'thinking', text: delta }
                }
                return
            }
            if (type === 'message_end') {
                if (!message || message.role !== 'assistant') return
                usage = addPiUsage(usage, message.usage)
                usageModel = stringValue(message.model) ?? usageModel
                const text = assistantText(message.content)
                if (text) {
                    if (!streamedText) {
                        emittedText = true
                        yield { type: 'token', text }
                    } else if (
                        text.length > streamedText.length &&
                        text.startsWith(streamedText)
                    ) {
                        yield {
                            type: 'token',
                            text: text.slice(streamedText.length)
                        }
                    }
                }
                streamedText = ''
                const stopReason = stringValue(message.stopReason)
                if (stopReason === 'error' || stopReason === 'aborted')
                    resultError =
                        stringValue(message.errorMessage) ??
                        `pi ${stopReason === 'error' ? 'reported a model error' : 'aborted the turn'}`
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
            if (
                ctx.frameworkSessionRef &&
                PI_SESSION_CWD_MISSING_SIGNATURE.test(failureDetail)
            )
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

        // Measured on macOS dev [2026-09-10] with pi 0.85.1: a provider 401
        // ends the turn with stopReason 'error' on the assistant message and
        // exit code 0 — the stream is the only place the failure shows.
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

        if (!emittedText && execResult && execResult.stdout.trim()) {
            // Nothing parsed as a message — surface whatever pi printed rather
            // than an empty reply (a pi build with an unexpected event shape).
            yield { type: 'token', text: execResult.stdout.trim() }
        }

        // The minted id was persisted before the exec; only a header that
        // disagreed with it has anything new to record.
        if (headerId && headerId !== opts.sessionRef)
            await this.chatRepo.updateFrameworkSessionRef(
                ctx.sessionId,
                headerId,
                ctx.turnFence
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
                            modelProviderBuiltInId: ctx.modelProviderBuiltInId
                        }
                    }
                )
            }

        yield { type: 'done', finalMessageId: ctx.messageId }
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
