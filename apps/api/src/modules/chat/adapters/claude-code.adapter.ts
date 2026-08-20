import {
    DEFAULT_CHAT_EXEC_TIMEOUTS,
    DEFAULT_CLAUDE_CODE_PERMISSION_MODE,
    claudeCliModel,
    claudeModelMapEnv,
    compareCliSemver,
    normalizeClaudeCodeEffortForModel,
    parseProbedVersion,
    resolveChatExecTimeoutMs,
    resolveClaudeCodeProviderModel
} from '@manyfold/shared'
import type {
    AgentFramework,
    ChatCapabilities,
    ChatMessage,
    ChatUsage,
    ClaudeCodeAgentModelConfig,
    ClaudeCodeEffort
} from '@manyfold/shared'
import { Injectable, Logger, Optional } from '@nestjs/common'
import type { ResolvedClaudeCodeCredentials } from '@/modules/agents/credentials/resolved-credentials'
import { resolveAnthropicBaseUrl } from '@/modules/agents/orchestration/bootstrap-invariants'
import {
    isDaemonOfflineTransportError,
    isDaemonResumeSuspendError,
    type ApiChatAdapter,
    type ApiChatAdapterContext,
    type ApiChatResumeContext,
    type EmittedChatEvent
} from '@/modules/chat/chat-adapter'
import { SpritesError } from '@manyfold/sprites'
import type { ExecDriver, ExecStreamHandle } from './exec-driver'
import { ChatRepository } from '@/modules/chat/chat.repository'
import { ExecDriverFactory } from '@/modules/chat/adapters/exec-driver-factory'
import {
    extractClaudeCodeUsage,
    type StreamJsonLine
} from './claude-code-usage'
import {
    createClaudeStreamConsumer,
    formatClaudeResultError,
    parseLine,
    redactSecrets,
    stringValue,
    CLAUDE_STREAM_PARSER_NAME,
    CLAUDE_STREAM_PARSER_VERSION
} from './claude-stream-consumer'
import { messageToPromptText } from './message-content'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { classifyManagedChannelFailureSignal } from '@/modules/chat/managed-channel-failure-signal'
import { TurnFenceLostError } from '@/modules/chat/turn-fence'
import {
    recoverTurnFromClaudeJsonl,
    type TurnRecoveryVerdict,
    type TurnSeenState
} from '@/modules/chat/recovery/turn-jsonl-recovery'

// Overall bound on the post-drop JSONL recovery attempt. SpriteRecoveryFs already
// bounds its own locate (30s) and read (60s); this caps their sum + parse so a
// slow sprite fs can't stall an already-failed turn indefinitely.
const RECOVERY_OVERALL_TIMEOUT_MS = 75_000
const CLAUDE_XHIGH_MIN_CLI_VERSION = '2.1.111'
const CLAUDE_VERSION_PROBE_TIMEOUT_MS = 5_000

// Off by default: it re-enables delta output for runner turns. Safe since
// their resumes moved to the exact cursor (see resumeFromSeq()); the default
// is a rollout choice, not a safety gate. Read per call rather than frozen at
// module load so a same-process test or drill can exercise both sides without
// reloading the module (same reasoning as MF_SPRITE_RUNNER_AGENTS).
const runnerDeltaStreamingEnabled = (): boolean =>
    ['1', 'true', 'yes'].includes(
        (process.env.MF_RUNNER_DELTA_STREAM ?? '').toLowerCase()
    )

@Injectable()
export class ClaudeCodeAdapter implements ApiChatAdapter {
    readonly framework: AgentFramework = 'claude-code'
    private readonly logger = new Logger(ClaudeCodeAdapter.name)

    constructor(
        private readonly drivers: ExecDriverFactory,
        private readonly chatRepo: ChatRepository,
        @Optional() private readonly adminSettings?: AdminSettingsService,
        @Optional() private readonly telemetry?: TelemetryService
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
            creds,
            runtime,
            agent,
            baseEnv
        } = await this.drivers.forAgent(ctx.agentId, ctx.agent)
        const claudeCreds = creds as ResolvedClaudeCodeCredentials | null
        // Only the TRANSPORT changes for a runner turn: runtime stays 'sprites'
        // so credential injection, workspace path and model config keep the
        // sprite semantics (the daemon exec RPC forwards env, stdin and cwd).
        // baseEnv rides along: the sprite driver carries the per-agent identity
        // (MF_API_TOKEN et al) internally, so the swapped transport must carry
        // the same or every `mf` call in the turn 401s (#581).
        const driver = ctx.runnerDaemonId
            ? this.drivers.daemonDriverFor(ctx.runnerDaemonId, baseEnv)
            : spriteDriver
        const prompt = messageToPromptText(userMessage)

        const cmd = [
            'claude',
            '--print',
            '--output-format',
            'stream-json',
            '--verbose'
        ]
        const modelConfig =
            ctx.modelConfig?.framework === 'claude-code'
                ? (ctx.modelConfig as ClaudeCodeAgentModelConfig)
                : null
        const cliModel = claudeCliModel(modelConfig, ctx.model)
        if (cliModel) cmd.push('--model', cliModel)
        const requestedCliEffort = claudeCliEffort(modelConfig)
        const cliEffort = await this.effortForRuntime(
            driver,
            requestedCliEffort,
            ctx
        )
        if (cliEffort) cmd.push('--effort', cliEffort)
        const permissionMode =
            ctx.claudeCodePermissionMode ?? DEFAULT_CLAUDE_CODE_PERMISSION_MODE
        if (permissionMode !== 'default')
            cmd.push('--permission-mode', permissionMode)
        if (ctx.frameworkSessionRef) {
            cmd.push('--resume', ctx.frameworkSessionRef)
        }
        // Token-level streaming: without this flag the CLI only emits complete
        // assistant lines, so first visible text waits for the model to finish
        // its whole first content block. Sprite/k8s images pin a CLI that
        // supports the flag; daemon runs the user's local CLI, so it stays
        // block-level rather than risking an unknown-option failure.
        const viaRunner = !!ctx.runnerDaemonId
        // A runner turn was block-level because resuming a DELTA stream from a
        // cursor could silently drop content — the conservative cursor re-sent
        // one line, and a re-sent delta row can collide with a row holding
        // different text once the broadcaster's merge boundaries shift. The
        // exact cursor (chat_stream_events.runner_seq) re-sends nothing, so
        // token-level output is safe here now. What still keeps a runner turn
        // block-level is MF_RUNNER_DELTA_STREAM defaulting off — a rollout
        // lever, not a safety gate, kept separate from the runner allowlist so
        // streaming can be rolled back without giving up resumability.
        const runnerDeltaOk = viaRunner && runnerDeltaStreamingEnabled()
        // Whoever is holding the exec, and therefore whoever can hand it back:
        // losing that socket must SUSPEND the turn (no terminal, so the resume
        // path can still find it) rather than fail it. Mirrors the carrying
        // daemon chat.service stamps on the message.
        const carryingDaemonId =
            runtime === 'daemon' ? agent.daemonId : (ctx.runnerDaemonId ?? null)
        const includePartial =
            runtime !== 'daemon' &&
            (!viaRunner || runnerDeltaOk) &&
            (this.adminSettings
                ? await this.adminSettings.isFeatureEnabled(
                      'claude_partial_stream'
                  )
                : false)
        if (includePartial) cmd.push('--include-partial-messages')
        // Daemon-runtime: legacy CLIs (<= 0.11) drop the stdin field of the
        // exec.start RPC and spawn claude with stdin closed, so the prompt
        // never reaches the binary and `claude --print` exits 1 with empty
        // stderr. Sprite/k8s exec transports inline argv into the WS URL,
        // which 414s on long resume transcripts (94559e0); daemon RPC has no
        // such limit, so we pass the prompt as a positional argv for daemon
        // and keep the stdin path for sprite/k8s. Newer CLIs that read
        // payload.stdin still work because we keep stdin empty here.
        const promptViaArgv = runtime === 'daemon'
        if (promptViaArgv) cmd.push(prompt)

        const modelEnv = claudeModelMapEnv(modelConfig)
        const credentialEnv = claudeCreds
            ? {
                  ANTHROPIC_BASE_URL: resolveAnthropicBaseUrl({
                      source: 'byo',
                      byoBaseUrl: claudeCreds.anthropicBaseUrl
                  }),
                  ANTHROPIC_AUTH_TOKEN: claudeCreds.anthropicAuthToken,
                  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1'
              }
            : null
        const shouldInjectPlatformCredentials =
            runtime === 'sprites' || (runtime === 'daemon' && !!modelConfig)
        const env =
            shouldInjectPlatformCredentials && credentialEnv
                ? {
                      ...credentialEnv,
                      ...modelEnv
                  }
                : Object.keys(modelEnv).length > 0
                  ? modelEnv
                  : undefined

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

        let persistedSessionRef: string | null = ctx.frameworkSessionRef
        let errored = false
        let lineBuffer = ''
        const tStart = Date.now()
        // Recovery may synthesize usage; a result-line usage lives in the
        // consumer and the tail below prefers the recovered one.
        let recoveredUsage: ChatUsage | null = null
        // Owns the per-turn parse state (delta coalescing, seen tracking for
        // recovery, usage/result capture); shared with cross-process turn
        // adoption, which re-runs it over an exec re-attach's stdout replay.
        const consumer = createClaudeStreamConsumer({
            model: ctx.model,
            initialSessionRef: ctx.frameworkSessionRef,
            tStart
        })

        let transportError: Error | null = null
        try {
            outer: for await (const chunk of handle.stdout) {
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
                    // Resume watermark for this line: the transport seq of the
                    // chunk that completed it — but ONLY when the chunk ended
                    // exactly here. A chunk that ends mid-line also carries the
                    // HEAD of the next line, so resuming past it would deliver
                    // that line truncated and it would vanish on parse.
                    // Without this every resume replays the whole turn from 0.
                    const runnerSeq =
                        lineBuffer === ''
                            ? handle.lastDeliveredSeq?.()
                            : undefined
                    for (const ev of consumer.consume(line, rawLine)) {
                        if ('__terminalError' in ev) {
                            errored = true
                            break outer
                        }
                        yield ev.type === 'raw_source' &&
                        runnerSeq !== undefined
                            ? { ...ev, runnerSeq }
                            : ev
                    }
                    if (
                        consumer.frameworkSessionRef &&
                        consumer.frameworkSessionRef !== persistedSessionRef
                    ) {
                        persistedSessionRef = consumer.frameworkSessionRef
                        await this.chatRepo
                            .updateFrameworkSessionRef(
                                ctx.sessionId,
                                consumer.frameworkSessionRef,
                                ctx.turnFence
                            )
                            .catch((err: Error) => {
                                if (err instanceof TurnFenceLostError) throw err
                                this.logger.warn(
                                    `claude session-ref persist failed: ${err.message}`
                                )
                            })
                    }
                }
            }
            const rawTrailing = lineBuffer.replace(/\r$/, '')
            const trailing = rawTrailing.trim()
            if (trailing && !errored) {
                for (const ev of consumer.consume(trailing, rawTrailing)) {
                    if ('__terminalError' in ev) {
                        errored = true
                        break
                    }
                    yield ev
                }
            }
            if (!errored) yield* consumer.flushDeltas()
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

        if (consumer.errorLast) {
            const stderrTail = (execResult?.stderr ?? '').slice(-1024).trim()
            this.logger.warn(
                `claude is_error agent=${ctx.agentId} session=${ctx.sessionId} ` +
                    `subtype=${consumer.errorLast.subtype ?? 'unknown'} ` +
                    `result=${redactSecrets(consumer.errorLast.result ?? 'null').slice(0, 1024)} ` +
                    `exit=${execResult?.exitCode ?? 'unknown'} ` +
                    `stderr=${redactSecrets(stderrTail) || '<empty>'}`
            )
        }

        if (
            consumer.errorLast &&
            isResumeLoadFailure(consumer.errorLast, !!ctx.frameworkSessionRef)
        ) {
            await this.chatRepo
                .updateFrameworkSessionRef(ctx.sessionId, null, ctx.turnFence)
                .then(() =>
                    this.logger.warn(
                        `claude resume load-failure agent=${ctx.agentId} ` +
                            `session=${ctx.sessionId} ref=${ctx.frameworkSessionRef} ` +
                            `subtype=${consumer.errorLast?.subtype ?? 'unknown'} — cleared ` +
                            `frameworkSessionRef so the next turn starts a fresh session`
                    )
                )
                .catch((err: Error) =>
                    this.logger.warn(
                        `claude resume load-failure ref-clear failed session=${ctx.sessionId}: ${err.message}`
                    )
                )
        }

        if (transportError && !errored) {
            if (
                carryingDaemonId &&
                isDaemonOfflineTransportError(transportError)
            ) {
                this.logger.log(
                    `claude exec suspended (daemon offline) agent=${ctx.agentId} session=${ctx.sessionId} message=${ctx.messageId}`
                )
                yield {
                    type: 'suspended',
                    daemonId: carryingDaemonId,
                    daemonExecRef: ctx.messageId,
                    reason: transportError.message
                }
                return
            }
            const spriteExecSessionId =
                transportError instanceof SpritesError
                    ? transportError.execSessionId
                    : undefined
            const baseAttrs = this.recoveryAttrs(
                ctx,
                runtime,
                spriteExecSessionId
            )
            // Only the sprite reap (structured reason, never abort/timeout/
            // liveness which carry no reason) is recoverable; a user cancel
            // mid-flight opts out so the turn ends promptly as cancelled.
            const gone =
                runtime === 'sprites' &&
                transportError instanceof SpritesError &&
                transportError.reason === 'exec_session_gone' &&
                !ctx.abortSignal?.aborted
            const recoveryRef =
                consumer.frameworkSessionRef ?? ctx.frameworkSessionRef

            if (gone && consumer.sawResultLine && !consumer.errorLast) {
                // The terminal result already streamed; only the exit frame was
                // lost to the reap. Fall through to the normal usage+done tail.
                this.telemetry?.event('chat.exec.recovery', {
                    ...baseAttrs,
                    outcome: 'recovered_noop'
                })
            } else if (gone && recoveryRef) {
                const tRecoveryStart = Date.now()
                const verdict = await this.attemptTurnRecovery(
                    ctx,
                    recoveryRef,
                    prompt,
                    consumer.seen,
                    consumer.sourceSeq,
                    tStart,
                    consumer.tFirstToken
                )
                const durationMs = Date.now() - tRecoveryStart
                if (verdict.outcome === 'recovered') {
                    for (const ev of verdict.events) yield ev
                    recoveredUsage = verdict.usage
                    // errored stays false: the ref-persist / usage / done tail
                    // below completes the assistant message exactly once.
                    this.telemetry?.event('chat.exec.recovery', {
                        ...baseAttrs,
                        outcome: 'recovered',
                        recoveredLines: verdict.recoveredLines,
                        sourceFile: verdict.sourceFile,
                        synthOutputTokens: verdict.usage.outputTokens,
                        durationMs
                    })
                } else if (verdict.outcome === 'result_lost') {
                    for (const ev of verdict.events) yield ev
                    this.telemetry?.event('chat.exec.recovery', {
                        ...baseAttrs,
                        outcome: 'result_lost',
                        detail: verdict.detail,
                        sourceFile: verdict.sourceFile,
                        durationMs
                    })
                    yield {
                        type: 'error',
                        error: {
                            code: 'sprite_exec_result_lost',
                            message:
                                'claude finished or died while the runtime connection was interrupted, and no final result could be recovered from the session log; partial output was kept — send a new message to continue from the last saved state',
                            retryable: true
                        }
                    }
                    errored = true
                } else {
                    this.telemetry?.event('chat.exec.recovery', {
                        ...baseAttrs,
                        outcome: 'failed',
                        detail: verdict.detail,
                        durationMs
                    })
                    this.logger.warn(
                        `claude exec transport error (recovery failed: ${verdict.detail}): ${transportError.message}`
                    )
                    yield {
                        type: 'error',
                        error: {
                            code: 'claude_exec_failed',
                            message: transportError.message,
                            retryable: true
                        }
                    }
                    errored = true
                }
            } else {
                if (gone && !recoveryRef)
                    this.telemetry?.event('chat.exec.recovery', {
                        ...baseAttrs,
                        outcome: 'skipped',
                        detail: 'no_session_ref'
                    })
                this.logger.warn(
                    `claude exec transport error: ${transportError.message}`
                )
                yield {
                    type: 'error',
                    error: {
                        code: 'claude_exec_failed',
                        message: transportError.message,
                        retryable: true
                    }
                }
                errored = true
            }
        }

        if (!errored && execResult && execResult.exitCode !== 0) {
            yield {
                type: 'error',
                error: {
                    code: 'claude_exec_failed',
                    message: `claude exited ${execResult.exitCode}: ${execResult.stderr.slice(0, 512)}`,
                    retryable: execResult.exitCode === 124
                }
            }
            errored = true
        }

        if (
            consumer.frameworkSessionRef &&
            consumer.frameworkSessionRef !== ctx.frameworkSessionRef
        )
            await this.chatRepo.updateFrameworkSessionRef(
                ctx.sessionId,
                consumer.frameworkSessionRef,
                ctx.turnFence
            )

        const finalUsage = recoveredUsage ?? consumer.pendingUsage
        if (!errored && finalUsage) yield { type: 'usage', usage: finalUsage }

        if (!errored) yield { type: 'done', finalMessageId: ctx.messageId }
    }

    // Bounded, never-throwing JSONL recovery for a reaped sprite exec session.
    // Fresh RecoveryFs (its own connections, independent of the dead exec
    // session) raced against an overall cap and the turn's abort signal.
    private async attemptTurnRecovery(
        ctx: ApiChatAdapterContext,
        frameworkSessionRef: string,
        promptText: string,
        seen: TurnSeenState,
        firstSourceSeq: number,
        tStart: number,
        tFirstToken: number | null
    ): Promise<TurnRecoveryVerdict> {
        try {
            const { fs } = await this.drivers.recoveryFsForAgent(ctx.agentId)
            return await Promise.race([
                recoverTurnFromClaudeJsonl({
                    fs,
                    frameworkSessionRef,
                    promptText,
                    seen,
                    firstSourceSeq,
                    model: ctx.model,
                    tStart,
                    tFirstToken
                }),
                new Promise<TurnRecoveryVerdict>((resolve) => {
                    const timer = setTimeout(
                        () =>
                            resolve({
                                outcome: 'failed',
                                detail: 'recovery timed out'
                            }),
                        RECOVERY_OVERALL_TIMEOUT_MS
                    )
                    if (typeof timer.unref === 'function') timer.unref()
                    ctx.abortSignal?.addEventListener(
                        'abort',
                        () =>
                            resolve({
                                outcome: 'failed',
                                detail: 'aborted during recovery'
                            }),
                        { once: true }
                    )
                })
            ])
        } catch (err) {
            return {
                outcome: 'failed',
                detail: err instanceof Error ? err.message : String(err)
            }
        }
    }

    private recoveryAttrs(
        ctx: ApiChatAdapterContext,
        runtime: string,
        spriteExecSessionId: string | undefined
    ): Record<string, string | number | boolean | null | undefined> {
        return {
            agentId: ctx.agentId,
            sessionId: ctx.sessionId,
            messageId: ctx.messageId,
            frameworkSessionRef: ctx.frameworkSessionRef,
            runtime,
            spriteExecSessionId
        }
    }

    // Resume a turn whose exec is still buffered on the daemon that ran it,
    // replaying from `fromSeq`. Strictly better than the adoption sweep's
    // fallback (recoverTurnFromClaudeJsonl re-reads the session transcript),
    // because the buffer holds what the CLI actually emitted. Note this has
    // its own parse loop: unlike codex/gemini-cli, the send path here consumes
    // the stream inline rather than through a shared drain.
    async *resumeMessage(
        ctx: ApiChatResumeContext
    ): AsyncIterable<EmittedChatEvent> {
        // Resume goes to the daemon that HOLDS the buffer, which is the one that
        // just reported this stream in its hello — not whatever driver the
        // agent's runtime would pick. For a daemon-runtime turn the two are the
        // same; for a runner turn the agent is `sprites` with a null
        // daemonId, and resolving by runtime rejected the resume outright
        // (`claude_resume_unsupported`), which silently made every runner turn
        // unresumable — the one property the runner exists to provide.
        const driver = this.drivers.daemonDriverFor(ctx.daemonId)
        if (!ctx.daemonId || !driver.resumeStream) {
            yield {
                type: 'error',
                error: {
                    code: 'claude_resume_unsupported',
                    message:
                        'resume requires a daemon transport with resume support',
                    retryable: false
                }
            }
            return
        }
        const resumeTimeouts = this.adminSettings
            ? await this.adminSettings.getCachedChatExecTimeoutMs()
            : resolveChatExecTimeoutMs(DEFAULT_CHAT_EXEC_TIMEOUTS)
        const handle: ExecStreamHandle = driver.resumeStream({
            refId: ctx.daemonExecRef,
            fromSeq: ctx.fromSeq,
            timeoutMs: resumeTimeouts.timeoutMs
        })
        ctx.abortSignal?.addEventListener('abort', () => handle.abort(), {
            once: true
        })

        let frameworkSessionRef: string | null = ctx.frameworkSessionRef
        let persistedSessionRef: string | null = ctx.frameworkSessionRef
        let errored = false
        const errorState: { last: StreamJsonLine | null } = { last: null }
        let lineBuffer = ''
        const tStart = Date.now()
        let tFirstToken: number | null = null
        let pendingUsage: ChatUsage | null = null
        let sourceSeq = 0

        const consumeLine = function* (
            line: string,
            rawLine: string,
            seq: number
        ): Generator<EmittedChatEvent | { __terminalError: true }> {
            const parsed = parseLine(line)
            if (!parsed) return
            yield {
                type: 'raw_source',
                source: {
                    sourceRef: parsed.session_id ?? ctx.frameworkSessionRef,
                    sourceSeq: seq,
                    externalId:
                        stringValue((parsed as Record<string, unknown>).uuid) ??
                        `${parsed.type ?? 'event'}-${seq}`,
                    parentExternalId:
                        stringValue(
                            (parsed as Record<string, unknown>).parentUuid
                        ) ??
                        stringValue(
                            (parsed as Record<string, unknown>).parent_uuid
                        ),
                    rawFormat: 'jsonl',
                    rawText: rawLine,
                    parserName: CLAUDE_STREAM_PARSER_NAME,
                    parserVersion: CLAUDE_STREAM_PARSER_VERSION
                }
            }
            if (parsed.session_id && !frameworkSessionRef)
                frameworkSessionRef = parsed.session_id
            if (parsed.type === 'assistant' && parsed.message?.content) {
                for (const block of parsed.message.content) {
                    if (block.type === 'text' && typeof block.text === 'string')
                        yield { type: 'token', text: block.text }
                    if (
                        block.type === 'thinking' &&
                        typeof block.text === 'string'
                    )
                        yield { type: 'thinking', text: block.text }
                    if (
                        block.type === 'tool_use' &&
                        typeof block.id === 'string' &&
                        typeof block.name === 'string'
                    )
                        yield {
                            type: 'tool_call',
                            toolCallId: block.id,
                            toolName: block.name,
                            args: block.input ?? null
                        }
                }
            }
            if (parsed.type === 'user' && parsed.message?.content) {
                for (const block of parsed.message.content) {
                    if (
                        block.type === 'tool_result' &&
                        typeof block.tool_use_id === 'string'
                    )
                        yield {
                            type: 'tool_result',
                            toolCallId: block.tool_use_id,
                            result: block.content ?? block
                        }
                }
            }
            if (parsed.type === 'result') {
                pendingUsage = extractClaudeCodeUsage(
                    parsed,
                    ctx.model,
                    tStart,
                    tFirstToken
                )
                if (parsed.is_error) {
                    errorState.last = parsed
                    const message = formatClaudeResultError(parsed)
                    const managedChannelFailure =
                        classifyManagedChannelFailureSignal({
                            status: /API Error:\s*503\b/.test(message)
                                ? 503
                                : null,
                            message
                        })
                    yield {
                        type: 'error',
                        ...(managedChannelFailure
                            ? { managedChannelFailure }
                            : {}),
                        error: {
                            code: 'claude_result_error',
                            message,
                            retryable: false
                        }
                    }
                    yield { __terminalError: true }
                }
            }
        }

        let transportError: Error | null = null
        try {
            outer: for await (const chunk of handle.stdout) {
                lineBuffer += chunk
                let nl = lineBuffer.indexOf('\n')
                while (nl !== -1) {
                    const rawLine = lineBuffer.slice(0, nl).replace(/\r$/, '')
                    const line = rawLine.trim()
                    lineBuffer = lineBuffer.slice(nl + 1)
                    nl = lineBuffer.indexOf('\n')
                    if (!line) continue
                    const runnerSeq =
                        lineBuffer === ''
                            ? handle.lastDeliveredSeq?.()
                            : undefined
                    for (const ev of consumeLine(line, rawLine, ++sourceSeq)) {
                        if ('__terminalError' in ev) {
                            errored = true
                            break outer
                        }
                        if (ev.type === 'token' && tFirstToken === null)
                            tFirstToken = Date.now()
                        yield ev.type === 'raw_source' &&
                        runnerSeq !== undefined
                            ? { ...ev, runnerSeq }
                            : ev
                    }
                    if (
                        frameworkSessionRef &&
                        frameworkSessionRef !== persistedSessionRef
                    ) {
                        persistedSessionRef = frameworkSessionRef
                        await this.chatRepo
                            .updateFrameworkSessionRef(
                                ctx.sessionId,
                                frameworkSessionRef,
                                ctx.turnFence
                            )
                            .catch((err: Error) => {
                                if (err instanceof TurnFenceLostError) throw err
                                this.logger.warn(
                                    `claude session-ref persist failed: ${err.message}`
                                )
                            })
                    }
                }
            }
            const rawTrailing = lineBuffer.replace(/\r$/, '')
            const trailing = rawTrailing.trim()
            if (trailing && !errored) {
                for (const ev of consumeLine(
                    trailing,
                    rawTrailing,
                    ++sourceSeq
                )) {
                    if ('__terminalError' in ev) {
                        errored = true
                        break
                    }
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

        if (transportError && !errored) {
            if (isDaemonResumeSuspendError(transportError)) {
                this.logger.log(
                    `claude resume suspended again (daemon offline) agent=${ctx.agentId} message=${ctx.messageId}`
                )
                yield {
                    type: 'suspended',
                    daemonId: ctx.daemonId,
                    daemonExecRef: ctx.daemonExecRef,
                    reason: transportError.message
                }
                return
            }
            this.logger.warn(
                `claude resume transport error: ${transportError.message}`
            )
            yield {
                type: 'error',
                error: {
                    code: 'claude_exec_failed',
                    message: transportError.message,
                    retryable: true
                }
            }
            errored = true
        }

        if (!errored && execResult && execResult.exitCode !== 0) {
            yield {
                type: 'error',
                error: {
                    code: 'claude_exec_failed',
                    message: `claude exited ${execResult.exitCode}: ${execResult.stderr.slice(0, 512)}`,
                    retryable: execResult.exitCode === 124
                }
            }
            errored = true
        }

        if (
            frameworkSessionRef &&
            frameworkSessionRef !== ctx.frameworkSessionRef
        )
            await this.chatRepo.updateFrameworkSessionRef(
                ctx.sessionId,
                frameworkSessionRef,
                ctx.turnFence
            )

        if (!errored && pendingUsage)
            yield { type: 'usage', usage: pendingUsage }

        if (!errored) yield { type: 'done', finalMessageId: ctx.messageId }
    }

    private async effortForRuntime(
        driver: ExecDriver,
        requested: ClaudeCodeEffort | null,
        ctx: ApiChatAdapterContext
    ): Promise<ClaudeCodeEffort | null> {
        if (requested !== 'xhigh') return requested

        const probe = await probeClaudeVersion(driver, ctx.abortSignal)
        const comparison = probe.version
            ? compareCliSemver(probe.version, CLAUDE_XHIGH_MIN_CLI_VERSION)
            : null
        if (comparison === 0 || comparison === 1) return requested

        const reason = comparison === -1 ? 'unsupported_cli' : 'unknown_cli'
        this.logger.warn(
            `claude effort fallback agent=${ctx.agentId} session=${ctx.sessionId} ` +
                `requested=xhigh effective=high cliVersion=${probe.version ?? 'unknown'} ` +
                `reason=${reason}${probe.detail ? ` detail=${probe.detail}` : ''}`
        )
        this.telemetry?.event('chat.claude.effort_fallback', {
            agentId: ctx.agentId,
            sessionId: ctx.sessionId,
            messageId: ctx.messageId,
            runtimeKind: ctx.runtimeKind,
            requestedEffort: 'xhigh',
            effectiveEffort: 'high',
            cliVersion: probe.version,
            minimumCliVersion: CLAUDE_XHIGH_MIN_CLI_VERSION,
            reason
        })
        return 'high'
    }
}

const probeClaudeVersion = async (
    driver: ExecDriver,
    signal?: AbortSignal
): Promise<{ version: string | null; detail: string | null }> => {
    const handle = driver.stream({
        cmd: ['claude', '--version'],
        timeoutMs: CLAUDE_VERSION_PROBE_TIMEOUT_MS
    })
    const abort = (): void => handle.abort()
    signal?.addEventListener('abort', abort, { once: true })
    if (signal?.aborted) handle.abort()
    try {
        const [stdout, stderr, result] = await Promise.all([
            collectStreamText(handle.stdout),
            collectStreamText(handle.stderr),
            handle.result
        ])
        const combined = [stdout, stderr, result.stdout, result.stderr]
            .filter(Boolean)
            .join('\n')
        const version = parseProbedVersion(combined)
        if (result.exitCode === 0 && version) return { version, detail: null }
        return {
            version: null,
            detail:
                result.exitCode === 0
                    ? 'version was not parseable'
                    : `version probe exited ${result.exitCode}`
        }
    } catch (err) {
        return {
            version: null,
            detail: err instanceof Error ? err.message : String(err)
        }
    } finally {
        signal?.removeEventListener('abort', abort)
    }
}

const collectStreamText = async (
    stream: AsyncIterable<string>
): Promise<string> => {
    let out = ''
    for await (const chunk of stream) out += chunk
    return out
}

// A `--resume` whose session transcript is missing/unreadable on the runtime
// makes claude abort instantly: is_error result with subtype error_during_execution
// and num_turns 0 (it never started a turn). Distinct from a mid-turn failure
// (num_turns >= 1) or an auth error (subtype "success"). When this happens on a
// turn that used --resume, the stored frameworkSessionRef points at a session
// claude can no longer load, so every future turn fails identically until the
// ref is cleared (the failing turn still surfaces an error; the next turn recovers).
const isResumeLoadFailure = (
    parsed: StreamJsonLine,
    usedResume: boolean
): boolean => {
    // Require an EXPLICIT num_turns === 0 (not a missing field coerced to 0): a
    // load failure aborts before any turn runs, whereas a transient mid-turn or
    // upstream error reports >= 1 turns (or omits the field). Only then is it safe
    // to drop continuity by clearing the session ref.
    const numTurns = (parsed as Record<string, unknown>).num_turns
    return (
        usedResume &&
        parsed.is_error === true &&
        parsed.subtype === 'error_during_execution' &&
        typeof numTurns === 'number' &&
        numTurns === 0
    )
}

const claudeCliEffort = (
    config: ClaudeCodeAgentModelConfig | null
): ClaudeCodeEffort | null => {
    if (!config) return null
    return normalizeClaudeCodeEffortForModel(
        config.effort,
        resolveClaudeCodeProviderModel(config.model, config.modelMap)
    )
}
