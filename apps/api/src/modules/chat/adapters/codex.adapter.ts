import {
    AgentFramework,
    ChatCapabilities,
    ChatContentBlock,
    ChatMessage,
    ChatUsage,
    CodexAgentModelConfig,
    CodexPermissionMode,
    DEFAULT_CHAT_EXEC_TIMEOUTS,
    DEFAULT_CODEX_PERMISSION_MODE,
    OFFICIAL_PROVIDER_BASE_URL,
    resolveChatExecTimeoutMs
} from '@manyfold/shared'
import { Injectable, Logger, Optional } from '@nestjs/common'
import type { ResolvedCodexCredentials } from '@/modules/agents/credentials/resolved-credentials'
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
import { extractCodexUsage } from './codex-usage'
import { messageToPromptText } from './message-content'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { classifyManagedChannelFailureSignal } from '@/modules/chat/managed-channel-failure-signal'
import { TurnFenceLostError } from '@/modules/chat/turn-fence'

const CODEX_STREAM_PARSER_NAME = 'codex-exec-json'
const CODEX_STREAM_PARSER_VERSION = '1'

// `codex exec resume <id>` exits non-zero with these stderr signatures when the
// thread's rollout file is missing/unreadable on the runtime. Mirrors the
// claude-code resume-load-failure self-heal: clear the frozen frameworkSessionRef
// so the next turn starts a fresh session instead of resuming a thread codex can
// never load (otherwise every later turn fails identically until the ref is reset).
const isCodexResumeLoadFailure = (stderr: string): boolean =>
    /no rollout found for thread|failed to read thread|thread\/resume failed/i.test(
        stderr
    )

@Injectable()
export class CodexAdapter implements ApiChatAdapter {
    readonly framework: AgentFramework = 'codex'
    private readonly logger = new Logger(CodexAdapter.name)

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
            baseEnv
        } = await this.drivers.forAgent(ctx.agentId, ctx.agent)
        // Only the TRANSPORT changes for a runner turn — `runtime`
        // stays 'sprites', so credentials, workspace cwd and the codex HOME
        // relocation keep their sprite meaning. See claude-code.adapter,
        // including why baseEnv must ride along (#581).
        const viaRunner = !!ctx.runnerDaemonId
        const driver = ctx.runnerDaemonId
            ? this.drivers.daemonDriverFor(ctx.runnerDaemonId, baseEnv)
            : spriteDriver
        // Whoever holds the exec, and can therefore hand it back: losing that
        // socket must SUSPEND the turn (no terminal, so the resume path can
        // still find it) rather than fail it. Mirrors the carrying daemon
        // chat.service stamps on the message.
        const carryingDaemonId =
            runtime === 'daemon' ? agent.daemonId : (ctx.runnerDaemonId ?? null)
        const codexCreds = creds as ResolvedCodexCredentials | null
        const resumeSessionRef = ctx.frameworkSessionRef?.trim() || null
        const prompt = resumeSessionRef
            ? messageToPromptText(userMessage)
            : codexPromptWithHistory(ctx.history, userMessage)
        const cmd = resumeSessionRef
            ? ['codex', 'exec', 'resume', '--skip-git-repo-check', '--json']
            : ['codex', 'exec', '--skip-git-repo-check', '--json']
        applyCodexPermissionMode(
            cmd,
            ctx.codexPermissionMode ?? DEFAULT_CODEX_PERMISSION_MODE,
            !resumeSessionRef
        )
        const modelConfig =
            ctx.modelConfig?.framework === 'codex'
                ? (ctx.modelConfig as CodexAgentModelConfig)
                : null
        const selectedUsageModel = ctx.model?.trim() || null
        const runtimeLocalUsageModel = selectedUsageModel
            ? null
            : codexRuntimeLocalModelFallback(agent)
        const usageFallbackModel = selectedUsageModel ?? runtimeLocalUsageModel
        const usageFallbackModelIsAssumed =
            !selectedUsageModel && !!runtimeLocalUsageModel
        if (modelConfig?.intelligence)
            cmd.push(
                '-c',
                `model_reasoning_effort="${modelConfig.intelligence}"`
            )
        if (modelConfig?.speed === 'fast') cmd.push('-c', 'service_tier="fast"')
        const env =
            runtime === 'daemon' && modelConfig && codexCreds
                ? platformCodexEnvAndArgs(cmd, codexCreds)
                : undefined
        if (ctx.model) cmd.push('--model', ctx.model)
        if (resumeSessionRef) cmd.push(resumeSessionRef)
        // See claude-code adapter: daemon CLIs <= 0.11 drop the stdin field
        // of the exec.start RPC, so we pass the prompt as a positional argv
        // for daemon runtime. For sprite/k8s we keep `-` + stdin (avoids
        // 414 when the prompt embeds a long resume transcript).
        const promptViaArgv = runtime === 'daemon'
        cmd.push(promptViaArgv ? prompt : '-')

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
            // Sprite codex: relocate HOME to the workspace so its USER skill
            // scope `$HOME/.agents/skills` is per-agent (CODEX_HOME keeps config/
            // auth in the real `~/.codex`). Keyed on runtime, not transport: a
            // runner turn stays runtime 'sprites', so it gets this over the
            // daemon driver too (see codexHome in exec-driver.ts). The daemon
            // RUNTIME (the user's own machine) and k8s are unaffected.
            codexHome:
                runtime === 'sprites'
                    ? (agent.workspacePath ?? undefined)
                    : undefined,
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

        // Everything past this point is transport-agnostic: it consumes an
        // exec handle. resumeMessage feeds it the SAME handle shape from
        // exec.resume, so a recovered turn is parsed by exactly this code.
        yield* this.drainCodexStream(handle, ctx, {
            carryingDaemonId,
            initialThreadId: resumeSessionRef,
            usageFallbackModel,
            usageFallbackModelIsAssumed
        })
    }

    // Resume a turn whose exec is still buffered on the daemon that ran it.
    // The runner replays from `fromSeq`, so this is the cursor path — strictly
    // better than rebuilding from the framework transcript, which is what the
    // adoption sweep has to do when no daemon is holding the turn.
    async *resumeMessage(
        ctx: ApiChatResumeContext
    ): AsyncIterable<EmittedChatEvent> {
        // The daemon that REPORTED the stream owns the buffer — resolving by
        // the agent's runtime would reject a sprite runner turn outright (the
        // agent is runtime=sprites with a null daemonId).
        const driver = this.drivers.daemonDriverFor(ctx.daemonId)
        if (!ctx.daemonId || !driver.resumeStream) {
            yield {
                type: 'error',
                error: {
                    code: 'codex_resume_unsupported',
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
        yield* this.drainCodexStream(handle, ctx, {
            carryingDaemonId: ctx.daemonId,
            initialThreadId: ctx.frameworkSessionRef?.trim() || null,
            // The replayed turn.completed line carries its own model; this only
            // backstops a line that omits one, and ctx.model is what the turn
            // was dispatched with.
            usageFallbackModel: ctx.model?.trim() || null,
            usageFallbackModelIsAssumed: false,
            resumeAttach: true
        })
    }

    private async *drainCodexStream(
        handle: ExecStreamHandle,
        ctx: ApiChatAdapterContext,
        opts: {
            carryingDaemonId: string | null
            initialThreadId: string | null
            usageFallbackModel: string | null
            usageFallbackModelIsAssumed: boolean
            resumeAttach?: boolean
        }
    ): AsyncIterable<EmittedChatEvent> {
        const {
            carryingDaemonId,
            usageFallbackModel,
            usageFallbackModelIsAssumed
        } = opts
        let emittedText = false
        let lineBuffer = ''
        let threadId: string | null = opts.initialThreadId
        let persistedThreadId: string | null = opts.initialThreadId
        const tStart = Date.now()
        let tFirstToken: number | null = null
        let pendingUsage: ChatUsage | null = null
        let codexStreamError: string | null = null
        let sourceSeq = 0
        const pricing = this.pricing

        const consumeLine = function* (
            line: string,
            rawLine: string,
            seq: number
        ): Generator<EmittedChatEvent> {
            const parsed = safeParse(line)
            if (!parsed) return
            yield {
                type: 'raw_source',
                source: {
                    sourceRef: codexSessionRefFromEvent(parsed) ?? threadId,
                    sourceSeq: seq,
                    externalId:
                        stringValue(parsed.id) ??
                        (isRecord(parsed.item)
                            ? stringValue(parsed.item.id)
                            : null) ??
                        `${stringValue(parsed.type) ?? 'event'}-${seq}`,
                    parentExternalId: null,
                    rawFormat: 'jsonl',
                    rawText: rawLine,
                    parserName: CODEX_STREAM_PARSER_NAME,
                    parserVersion: CODEX_STREAM_PARSER_VERSION
                }
            }
            const discoveredThreadId = codexSessionRefFromEvent(parsed)
            if (discoveredThreadId && !threadId) threadId = discoveredThreadId
            if (parsed.type === 'turn.completed' || parsed.type === 'result') {
                pendingUsage = extractCodexUsage(
                    parsed,
                    usageFallbackModel,
                    tStart,
                    tFirstToken,
                    pricing,
                    {
                        fallbackModelIsAssumed: usageFallbackModelIsAssumed,
                        scope: {
                            modelProviderId: ctx.modelProviderId,
                            modelProviderBuiltInId: ctx.modelProviderBuiltInId
                        }
                    }
                )
                return
            }
            // Codex reports failures on stdout, not stderr: a `turn.failed`
            // (terminal) and one or more `error` lines (e.g. the upstream 401
            // body, or "Reconnecting... N/5"). Capture the message so the
            // non-zero-exit branch can surface a real reason instead of the
            // bare "codex exited 1:" (stderr is empty in this case).
            if (
                parsed.type === 'turn.failed' &&
                isRecord(parsed.error) &&
                typeof parsed.error.message === 'string'
            ) {
                codexStreamError = parsed.error.message
                return
            }
            if (parsed.type === 'error' && typeof parsed.message === 'string') {
                codexStreamError = parsed.message
                return
            }
            if (parsed.type === 'item.completed' && isRecord(parsed.item)) {
                const item = parsed.item
                if (
                    item.type === 'agent_message' &&
                    typeof item.text === 'string'
                ) {
                    yield { type: 'token', text: item.text }
                    emittedText = true
                    return
                }
                if (
                    item.type === 'reasoning' &&
                    typeof item.text === 'string'
                ) {
                    yield { type: 'thinking', text: item.text }
                    return
                }
                if (
                    item.type === 'command_execution' &&
                    typeof item.id === 'string'
                ) {
                    yield {
                        type: 'tool_call',
                        toolCallId: item.id,
                        toolName: 'command_execution',
                        args: { command: item.command ?? null }
                    }
                    yield {
                        type: 'tool_result',
                        toolCallId: item.id,
                        result: {
                            output: item.aggregated_output ?? '',
                            exit_code: item.exit_code ?? null,
                            status: item.status ?? null
                        }
                    }
                    return
                }
                const itemId =
                    typeof item.id === 'string'
                        ? item.id
                        : `codex-${Date.now()}`
                const itemTypeName =
                    typeof item.type === 'string' ? item.type : 'unknown'
                yield {
                    type: 'tool_call',
                    toolCallId: itemId,
                    toolName: itemTypeName,
                    args: item
                }
                return
            }
            if (
                parsed.type === 'reasoning' &&
                typeof parsed.text === 'string'
            ) {
                yield { type: 'thinking', text: parsed.text }
                return
            }
            if (parsed.type === 'message' && typeof parsed.text === 'string') {
                yield { type: 'token', text: parsed.text }
                emittedText = true
                return
            }
            if (
                parsed.type === 'tool_call' &&
                typeof parsed.id === 'string' &&
                typeof parsed.name === 'string'
            ) {
                yield {
                    type: 'tool_call',
                    toolCallId: parsed.id,
                    toolName: parsed.name,
                    args: parsed.args ?? null
                }
                return
            }
            if (
                parsed.type === 'tool_result' &&
                typeof parsed.id === 'string'
            ) {
                yield {
                    type: 'tool_result',
                    toolCallId: parsed.id,
                    result: parsed.result ?? null
                }
                return
            }
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
                    // Resume watermark for this line: the transport seq of the
                    // chunk that completed it — but ONLY when the chunk ended
                    // exactly here. A chunk ending mid-line also carries the
                    // HEAD of the next line, so resuming past it would deliver
                    // that line truncated and it would vanish on parse. Without
                    // this every codex resume replays the whole turn from 0.
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
                    if (threadId && threadId !== persistedThreadId) {
                        persistedThreadId = threadId
                        await this.chatRepo
                            .updateFrameworkSessionRef(
                                ctx.sessionId,
                                threadId,
                                ctx.turnFence
                            )
                            .catch((err: Error) => {
                                if (err instanceof TurnFenceLostError) throw err
                                this.logger.warn(
                                    `codex session-ref persist failed: ${err.message}`
                                )
                            })
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

        if (transportError) {
            const suspendable = opts.resumeAttach
                ? isDaemonResumeSuspendError(transportError)
                : isDaemonOfflineTransportError(transportError)
            if (carryingDaemonId && suspendable) {
                this.logger.log(
                    `codex exec suspended (daemon offline) agent=${ctx.agentId} session=${ctx.sessionId} message=${ctx.messageId}`
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
                `codex exec transport error: ${transportError.message}`
            )
            yield {
                type: 'error',
                error: {
                    code: 'codex_exec_failed',
                    message: transportError.message,
                    retryable: true
                }
            }
            return
        }

        if (execResult && execResult.exitCode !== 0) {
            const failureDetail =
                execResult.stderr.trim() || codexStreamError || ''
            const status = /(?:^|\s)unexpected status 503(?:\s|$)/.test(
                failureDetail
            )
                ? 503
                : null
            const managedChannelFailure = classifyManagedChannelFailureSignal({
                status,
                message: failureDetail
            })
            if (
                ctx.frameworkSessionRef &&
                isCodexResumeLoadFailure(failureDetail)
            ) {
                await this.chatRepo
                    .updateFrameworkSessionRef(
                        ctx.sessionId,
                        null,
                        ctx.turnFence
                    )
                    .then(() =>
                        this.logger.warn(
                            `codex resume load-failure agent=${ctx.agentId} ` +
                                `session=${ctx.sessionId} ref=${ctx.frameworkSessionRef} — cleared ` +
                                `frameworkSessionRef so the next turn starts a fresh session`
                        )
                    )
                    .catch((err: Error) =>
                        this.logger.warn(
                            `codex resume load-failure ref-clear failed session=${ctx.sessionId}: ${err.message}`
                        )
                    )
            }
            yield {
                type: 'error',
                ...(managedChannelFailure ? { managedChannelFailure } : {}),
                error: {
                    code: 'codex_exec_failed',
                    message: `codex exited ${execResult.exitCode}: ${failureDetail.slice(0, 512)}`,
                    retryable: execResult.exitCode === 124
                }
            }
            return
        }

        if (!emittedText && execResult && execResult.stdout.trim()) {
            yield { type: 'token', text: execResult.stdout.trim() }
        }

        if (threadId && threadId !== ctx.frameworkSessionRef)
            await this.chatRepo.updateFrameworkSessionRef(
                ctx.sessionId,
                threadId,
                ctx.turnFence
            )

        if (pendingUsage) yield { type: 'usage', usage: pendingUsage }

        yield { type: 'done', finalMessageId: ctx.messageId }
    }
}

const platformCodexEnvAndArgs = (
    cmd: string[],
    creds: ResolvedCodexCredentials
): Record<string, string> => {
    const baseUrl =
        creds.openaiBaseUrl?.trim() || OFFICIAL_PROVIDER_BASE_URL.openai
    cmd.push(
        '-c',
        'model_provider="Manyfold"',
        '-c',
        'model_providers.Manyfold.name="Manyfold"',
        '-c',
        `model_providers.Manyfold.base_url=${tomlString(baseUrl)}`,
        '-c',
        'model_providers.Manyfold.wire_api="responses"',
        '-c',
        'model_providers.Manyfold.env_key="OPENAI_API_KEY"',
        '-c',
        'model_providers.Manyfold.requires_openai_auth=false'
    )
    return { OPENAI_API_KEY: creds.openaiApiKey }
}

const applyCodexPermissionMode = (
    cmd: string[],
    mode: CodexPermissionMode,
    supportsSandboxFlag: boolean
): void => {
    if (mode === 'default') return
    if (mode === 'auto-review') {
        if (supportsSandboxFlag) cmd.push('--sandbox', 'workspace-write')
        else cmd.push('-c', 'sandbox_mode="workspace-write"')
        cmd.push('-c', 'approval_policy="never"')
        return
    }
    cmd.push('--dangerously-bypass-approvals-and-sandbox')
}

// Same budget/shape as openclaw/hermes truncateHistory: the fork transcript is
// re-inlined into the prompt of every non-resume turn, so an unbounded history
// grows token cost and TTFT linearly with conversation length.
const CODEX_HISTORY_BUDGET = 30

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

const codexPromptWithHistory = (
    history: ChatMessage[],
    userMessage: ChatMessage
): string => {
    const latestPrompt = messageToPromptText(userMessage)
    const priorMessages = truncateHistory(history, CODEX_HISTORY_BUDGET).filter(
        (message) => message.id !== userMessage.id
    )
    if (priorMessages.length === 0) return latestPrompt

    const transcript = priorMessages
        .map((message) => {
            const role =
                message.role === 'assistant' ? 'assistant' : message.role
            return `<message role="${role}">\n${messageToTranscriptText(message)}\n</message>`
        })
        .join('\n\n')

    return [
        'You are continuing a Manyfold chat in a fresh Codex runtime session.',
        'The prior runtime session was intentionally forked after the user edited an earlier message.',
        'Use the transcript below as conversation context; do not mention the replay unless it is directly relevant.',
        '',
        '<previous_transcript>',
        transcript,
        '</previous_transcript>',
        '',
        'Continue from this latest user message:',
        '<latest_user_message>',
        latestPrompt,
        '</latest_user_message>'
    ].join('\n')
}

const messageToTranscriptText = (message: ChatMessage): string => {
    const visibleText = messageToPromptText(message)
    const activity = message.contentBlocks
        .map(summarizeNonTextBlock)
        .filter((line): line is string => Boolean(line))
    const parts = [visibleText, ...activity].filter(Boolean)
    return parts.length > 0 ? parts.join('\n') : '(no visible content)'
}

const summarizeNonTextBlock = (block: ChatContentBlock): string | null => {
    if (
        block.type === 'text' ||
        block.type === 'attachment' ||
        block.type === 'context_ref'
    )
        return null
    if (block.type === 'thinking') return `[thinking] ${block.text}`
    if (block.type === 'tool_call')
        return `[tool_call ${block.toolName}] ${safeStringify(block.args)}`
    if (block.type === 'tool_result')
        return `[tool_result ${block.toolCallId}] ${safeStringify(
            block.result
        )}`
    return null
}

const safeStringify = (value: unknown): string => {
    if (typeof value === 'string') return value
    try {
        return JSON.stringify(value)
    } catch {
        return String(value)
    }
}

const tomlString = (value: string): string =>
    `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`

const safeParse = (line: string): Record<string, unknown> | null => {
    try {
        return JSON.parse(line) as Record<string, unknown>
    } catch {
        return null
    }
}

const stringValue = (value: unknown): string | null =>
    typeof value === 'string' && value.length > 0 ? value : null

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null

const codexSessionRefFromEvent = (
    event: Record<string, unknown>
): string | null => {
    const payload = isRecord(event.payload) ? event.payload : null
    const item = isRecord(event.item) ? event.item : null
    const refs = [
        event.thread_id,
        event.threadId,
        event.session_id,
        event.sessionId,
        payload?.thread_id,
        payload?.threadId,
        payload?.session_id,
        payload?.sessionId,
        item?.thread_id,
        item?.threadId,
        item?.session_id,
        item?.sessionId
    ]
    for (const ref of refs) {
        const value = stringValue(ref)
        if (value) return value
    }
    if (
        event.type === 'session_meta' &&
        payload &&
        typeof payload.id === 'string'
    )
        return payload.id
    return null
}

const codexRuntimeLocalModelFallback = (agent: {
    extras?: unknown
}): string | null => {
    const extras = isRecord(agent.extras) ? agent.extras : null
    const raw =
        extras && isRecord(extras.runtimeLocalModelConfig)
            ? extras.runtimeLocalModelConfig
            : null
    if (!raw || raw.framework !== 'codex' || raw.ready !== true) return null

    const explicitModel = normalizeModel(raw.model)
    if (explicitModel) return explicitModel

    const current = normalizeModel(raw.current)
    if (!current) return null
    const currentModel = normalizeModel(current.split('\u00b7')[0])
    if (!currentModel) return null

    const models = Array.isArray(raw.models)
        ? raw.models.map(normalizeModel).filter((m): m is string => !!m)
        : []
    return models.includes(currentModel) ? currentModel : null
}

const normalizeModel = (value: unknown): string | null => {
    if (typeof value !== 'string') return null
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : null
}
