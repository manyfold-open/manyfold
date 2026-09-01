import {
    AgentFramework,
    ChatCapabilities,
    ChatMessage,
    DEFAULT_CHAT_EXEC_TIMEOUTS,
    OFFICIAL_PROVIDER_BASE_URL,
    PATH_PREPEND_LOCAL_BIN,
    isGeminiAutoModel,
    resolveChatExecTimeoutMs
} from '@manyfold/shared'
import { Injectable, Logger, Optional } from '@nestjs/common'
import type { ResolvedGeminiCliCredentials } from '@/modules/agents/credentials/resolved-credentials'
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
import { messageToPromptText } from './message-content'
import { redactSecrets } from './claude-stream-consumer'
import { extractGeminiUsage } from './gemini-usage'
import {
    createGeminiThoughtTail,
    geminiThoughtPollMs,
    type GeminiThoughtTail
} from './gemini-thought-tail'
import { UsagePricingService } from '@/modules/usage/usage-pricing.service'
import { AdminSettingsService } from '@/modules/admin-settings/admin-settings.service'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import {
    classifyGeminiCliInspectedFailureSignal,
    classifyManagedChannelFailureSignal,
    countGeminiCliInspectedPoolEmptyCauses
} from '@/modules/chat/managed-channel-failure-signal'
import { classifyChatFailureCause } from '@/modules/chat/chat-failure-cause'
import { TurnFenceLostError } from '@/modules/chat/turn-fence'

const GEMINI_STREAM_PARSER_NAME = 'gemini-cli-stream-json'
const GEMINI_STREAM_PARSER_VERSION = '1'
// How much stderr to keep for the whole turn, and how much of it to attach to
// an error. gemini retries an upstream rejection for minutes before giving up,
// so the tail (the last attempt) is the part worth reading.
const STDERR_TAIL_CHARS = 4_000
const STDERR_DETAIL_CHARS = 512
// ...but the tail alone is a stack trace. The provider's cause (the HTTP status
// and the API's own sentence) is printed FIRST, so a long stderr used to arrive
// with the only actionable line already cut off (#594: the user saw
// "gemini exited 144" and nothing about the missing thought_signature — a ~7 KB
// crash whose first line was the only one worth reading). Both the drain and
// the attach step keep a head as well as a tail, and mark the gap.
const STDERR_HEAD_CHARS = 512
const STDERR_ELISION = '\n...\n'

const isRetryableRateLimit = (
    errorCode: 'gemini_error' | 'gemini_exec_failed' | 'gemini_result_error',
    message: string
): boolean =>
    classifyChatFailureCause({ errorCode, message }) === 'rate_limited'
// Internal gemini-cli model-config aliases (and the concrete ids some agent
// definitions hardcode) that must follow the selected model on a gateway —
// their defaults all point at gemini-3-* ids only Google's official endpoint
// serves. Mirrors packages/core/dist/src/config/defaultModelConfigs.js of the
// pinned CLI; re-run the fake-gateway drill when bumping the CLI version.
const GEMINI_INTERNAL_MODEL_TARGETS = [
    'gemini-2.5-flash-base',
    'gemini-3-flash-base',
    'gemini-3.5-flash-base',
    'loop-detection-double-check',
    'classifier',
    'agent-history-provider-summarizer',
    'chat-compression-default',
    'chat-compression-3-pro',
    'chat-compression-3-flash',
    'chat-compression-3.1-flash-lite',
    'chat-compression-2.5-pro',
    'chat-compression-2.5-flash',
    'chat-compression-2.5-flash-lite',
    'gemini-3-flash-preview',
    'gemini-3-pro-preview',
    'gemini-3.1-flash-lite'
] as const

const GEMINI_CLI_AUTH_BOOTSTRAP = [
    'set -e',
    PATH_PREPEND_LOCAL_BIN,
    'export GEMINI_CLI_TRUST_WORKSPACE=true',
    'if [ -n "${GEMINI_API_KEY:-}" ]; then',
    "node <<'MF_GEMINI_SETTINGS'",
    "const fs = require('fs')",
    "const path = require('path')",
    '',
    'const home = process.env.HOME',
    'if (!home) process.exit(0)',
    '',
    "const settingsPath = path.join(home, '.gemini', 'settings.json')",
    'let settings = {}',
    'try {',
    "    settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))",
    '} catch (err) {',
    "    if (!err || err.code !== 'ENOENT') throw err",
    '}',
    '',
    "if (!settings || typeof settings !== 'object' || Array.isArray(settings))",
    '    settings = {}',
    'const section = (key) => {',
    '    if (',
    '        !settings[key] ||',
    "        typeof settings[key] !== 'object' ||",
    '        Array.isArray(settings[key])',
    '    )',
    '        settings[key] = {}',
    '    return settings[key]',
    '}',
    "section('security')",
    'if (',
    '    !settings.security.auth ||',
    "    typeof settings.security.auth !== 'object' ||",
    '    Array.isArray(settings.security.auth)',
    ')',
    '    settings.security.auth = {}',
    "settings.security.auth.selectedType = 'gemini-api-key'",
    '',
    '// Gateway neutralization: gemini-cli rewrites *flash model ids and routes',
    '// its internal utility calls (web-search, compression, classifiers…) to',
    '// hardcoded gemini-3-* ids only the official endpoint serves. Behind a',
    '// custom base URL, pin every id to the selected model. Official endpoint',
    '// (or no pinned model) removes the keys we own so a provider switch never',
    '// leaves stale overrides behind.',
    `const officialBase = '${OFFICIAL_PROVIDER_BASE_URL.google}'`,
    "const baseUrl = (process.env.GOOGLE_GEMINI_BASE_URL || '')",
    '    .trim()',
    "    .replace(/\\/+$/, '')",
    "const model = (process.env.GEMINI_MODEL || '').trim()",
    'const gateway = baseUrl.length > 0 && baseUrl !== officialBase',
    `const targets = ${JSON.stringify([...GEMINI_INTERNAL_MODEL_TARGETS])}`,
    'if (gateway && model) {',
    "    section('experimental').dynamicModelConfiguration = true",
    "    const modelConfigs = section('modelConfigs')",
    '    // contexts must be emptied explicitly: the CLI deep-merges settings',
    '    // with its defaults, and a surviving context (useGemini3_5Flash is',
    '    // unconditionally true on api-key auth) wins over `default`.',
    '    modelConfigs.modelIdResolutions = {',
    '        [model]: { default: model, contexts: [] }',
    '    }',
    '    modelConfigs.customOverrides = targets.map((target) => ({',
    '        match: { model: target },',
    '        modelConfig: { model }',
    '    }))',
    '} else {',
    "    delete section('experimental').dynamicModelConfiguration",
    "    const modelConfigs = section('modelConfigs')",
    '    delete modelConfigs.modelIdResolutions',
    '    delete modelConfigs.customOverrides',
    '    if (Object.keys(settings.experimental).length === 0)',
    '        delete settings.experimental',
    '    if (Object.keys(settings.modelConfigs).length === 0)',
    '        delete settings.modelConfigs',
    '}',
    '',
    'fs.mkdirSync(path.dirname(settingsPath), { recursive: true })',
    "fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\\n')",
    'MF_GEMINI_SETTINGS',
    'fi'
].join('\n')

// Sprite/k8s exec inlines argv into the WS URL, which 414s on long prompts
// (same limit the claude/codex adapters avoid via stdin), so the prompt
// travels over the stdin frame channel and is re-attached to --prompt here.
// Daemon runtime keeps argv: CLIs <= 0.11 drop the stdin field of the
// exec.start RPC, so stdin content would never reach the binary.
// See claude-code.adapter for the observed symptom and the commit (94559e0).
const geminiBootstrap = (promptViaArgv: boolean): string =>
    [
        GEMINI_CLI_AUTH_BOOTSTRAP,
        ...(promptViaArgv
            ? ['exec gemini "$@"']
            : ['MF_PROMPT="$(cat)"', 'exec gemini --prompt "$MF_PROMPT" "$@"'])
    ].join('\n')

@Injectable()
export class GeminiCliAdapter implements ApiChatAdapter {
    readonly framework: AgentFramework = 'gemini-cli'
    private readonly logger = new Logger(GeminiCliAdapter.name)

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
            // Not from stdout — see gemini-thought-tail.
            thinking: true,
            attachments: true,
            multiTurn: true
        }
    }

    async *sendMessage(
        ctx: ApiChatAdapterContext,
        userMessage: ChatMessage
    ): AsyncIterable<EmittedChatEvent> {
        const {
            driver: spriteDriver,
            creds,
            runtime,
            agent,
            baseEnv
        } = await this.drivers.forAgent(ctx.agentId, ctx.agent)
        // A runner turn swaps the transport only — `runtime` stays
        // 'sprites' so credentials, the bash bootstrap and the workspace cwd all
        // keep their sprite meaning. See claude-code.adapter, including why
        // baseEnv must ride along (#581).
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
        const geminiCreds =
            runtime === 'daemon'
                ? null
                : (creds as ResolvedGeminiCliCredentials)
        // modelConfig null + tuning present = runtime-local turn (see
        // resolveTurnConfig). Gating the env on it keeps GEMINI_API_KEY out
        // of the exec, which both lets the CLI use its own on-disk sign-in
        // and skips the settings.json auth rewrite in geminiBootstrap (that
        // script only runs when GEMINI_API_KEY is set) — otherwise every
        // turn would flip the user's selectedType back to gemini-api-key.
        const runtimeLocalTurn = !ctx.modelConfig && !!ctx.runtimeLocalTuning
        const prompt = messageToPromptText(userMessage)
        const configModel =
            ctx.modelConfig?.framework === 'gemini-cli'
                ? ctx.modelConfig.model?.trim() || null
                : null
        const model =
            ctx.modelOverride?.trim() ||
            configModel ||
            ctx.model?.trim() ||
            (runtime === 'daemon' || runtimeLocalTurn
                ? null
                : geminiCreds?.model?.trim()) ||
            null
        // `auto` is the CLI's own router default, not a callable model id:
        // leave --model / GEMINI_MODEL unset so routing stays in charge.
        const cliModel = isGeminiAutoModel(model) ? null : model

        const promptViaArgv = runtime === 'daemon'
        const cmd = [
            'gemini',
            '--output-format',
            'stream-json',
            '--approval-mode',
            'yolo'
        ]
        if (promptViaArgv) cmd.push('--prompt', prompt)
        if (cliModel) cmd.push('--model', cliModel)
        if (ctx.frameworkSessionRef)
            cmd.push('--resume', ctx.frameworkSessionRef)

        const env =
            runtime === 'sprites' && geminiCreds && !runtimeLocalTurn
                ? {
                      GEMINI_API_KEY: geminiCreds.googleApiKey,
                      GOOGLE_GEMINI_BASE_URL:
                          geminiCreds.googleGeminiBaseUrl?.trim() ||
                          OFFICIAL_PROVIDER_BASE_URL.google,
                      ...(cliModel ? { GEMINI_MODEL: cliModel } : {})
                  }
                : undefined

        const execTimeouts = this.adminSettings
            ? await this.adminSettings.getCachedChatExecTimeoutMs()
            : resolveChatExecTimeoutMs(DEFAULT_CHAT_EXEC_TIMEOUTS)

        const handle = driver.stream({
            cmd: [
                'bash',
                '-lc',
                geminiBootstrap(promptViaArgv),
                'gemini',
                ...cmd.slice(1)
            ],
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

        // Transport-agnostic from here: it only consumes an exec handle, so
        // resumeMessage can feed it the exec.resume handle and a recovered turn
        // is parsed by exactly this code.
        yield* this.drainGeminiStream(handle, ctx, {
            carryingDaemonId,
            usageModel: model,
            // Enables the session-file thought tail: the prompt anchors this
            // turn inside the session record.
            promptText: prompt
        })
    }

    // Resume a turn still buffered on the daemon that ran it (the sprite's own
    // runner, or a user daemon). Replays from `fromSeq` rather than rebuilding
    // from the transcript, which is what adoption falls back to when no daemon
    // is holding the turn.
    async *resumeMessage(
        ctx: ApiChatResumeContext
    ): AsyncIterable<EmittedChatEvent> {
        // Resolve by the daemon that REPORTED the stream: it owns the buffer.
        // Going via the agent's runtime would refuse a sprite runner turn,
        // whose agent is runtime=sprites with a null daemonId.
        const driver = this.drivers.daemonDriverFor(ctx.daemonId)
        if (!ctx.daemonId || !driver.resumeStream) {
            yield {
                type: 'error',
                error: {
                    code: 'gemini_resume_unsupported',
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
        yield* this.drainGeminiStream(handle, ctx, {
            carryingDaemonId: ctx.daemonId,
            // The replayed result line carries its own per-model breakdown;
            // this only labels usage when it doesn't.
            usageModel: ctx.model?.trim() || null,
            // No prompt to anchor on here, so no thought tail: an adopted turn
            // gets its thinking from the session reader instead.
            promptText: null,
            resumeAttach: true
        })
    }

    private async *drainGeminiStream(
        handle: ExecStreamHandle,
        ctx: ApiChatAdapterContext,
        opts: {
            carryingDaemonId: string | null
            usageModel: string | null
            promptText: string | null
            resumeAttach?: boolean
        }
    ): AsyncIterable<EmittedChatEvent> {
        const { carryingDaemonId, usageModel: model } = opts
        let emittedText = false
        let sessionRef: string | null = ctx.frameworkSessionRef
        let persistedSessionRef: string | null = ctx.frameworkSessionRef
        let lineBuffer = ''
        let sourceSeq = 0
        const tStart = Date.now()
        let tFirstToken: number | null = null
        const pricing = this.pricing

        // A rejected model call (404/503 from the gateway) is reported ONLY on
        // stderr: gemini retries it, then still exits 0 with a result line
        // whose message is the generic "[API Error: An unknown error
        // occurred.]". So the exitCode!==0 branch below never sees the cause
        // and the user gets minutes of silence followed by nothing to act on.
        // Drain stderr alongside stdout and keep a bounded tail to attach.
        // This is also the ONLY source on the daemon transport, whose
        // result.stderr is always ''.
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
        // What the two bounded buffers saw, with the dropped middle marked. The
        // head is only prepended for the part the tail no longer covers, so a
        // stderr that fit in the tail comes back verbatim.
        const drainedStderr = (): string => {
            const kept = Math.min(
                stderrHead.length,
                Math.max(0, stderrChars - stderrTail.length)
            )
            return kept
                ? `${stderrHead.slice(0, kept)}${STDERR_ELISION}${stderrTail}`
                : stderrTail
        }
        let resultError: string | null = null
        let streamErrorText = ''
        let untrustedInspectedCauseCount = 0
        const withStderr = (message: string, stderr: string): string => {
            const detail = stderrDetail(stderr)
            return detail ? `${message}\n\nstderr: ${detail}` : message
        }

        // Thoughts never come over stdout (see gemini-thought-tail): they are
        // read from the session JSONL the CLI is writing, which is only
        // locatable once the `init` line has given us the session id.
        const thoughtPollMs = opts.promptText ? geminiThoughtPollMs() : 0
        let tail: GeminiThoughtTail | null = null
        let tailBuilt = false
        const ensureTail = async (): Promise<GeminiThoughtTail | null> => {
            if (tailBuilt) return tail
            if (thoughtPollMs <= 0 || !sessionRef || !opts.promptText)
                return null
            tailBuilt = true
            try {
                const { fs } = await this.drivers.recoveryFsForAgent(
                    ctx.agentId
                )
                tail = createGeminiThoughtTail({
                    fs,
                    frameworkSessionRef: sessionRef,
                    promptText: opts.promptText,
                    pollMs: thoughtPollMs,
                    onWarn: (message) => this.logger.warn(message)
                })
            } catch (err) {
                this.logger.warn(
                    `gemini thought tail unavailable: ${(err as Error).message}`
                )
                tail = null
            }
            return tail
        }

        const consumeLine = function* (
            line: string,
            rawLine: string,
            seq: number
        ): Generator<EmittedChatEvent> {
            const parsed = safeParse(line)
            if (!parsed) return

            const discoveredSession =
                stringField(parsed, 'session_id') ??
                stringField(parsed, 'sessionId')
            yield {
                type: 'raw_source',
                source: {
                    sourceRef: discoveredSession ?? sessionRef,
                    sourceSeq: seq,
                    externalId:
                        stringField(parsed, 'id') ??
                        `${stringField(parsed, 'type') ?? 'event'}-${seq}`,
                    parentExternalId: null,
                    rawFormat: 'jsonl',
                    rawText: rawLine,
                    parserName: GEMINI_STREAM_PARSER_NAME,
                    parserVersion: GEMINI_STREAM_PARSER_VERSION
                }
            }
            if (discoveredSession && !sessionRef) sessionRef = discoveredSession

            const type = stringField(parsed, 'type')

            if (type === 'tool_result')
                untrustedInspectedCauseCount +=
                    reflectedToolResultCauseCount(parsed)

            if (type === 'init') return

            if (type === 'message') {
                const role = stringField(parsed, 'role')
                if (role !== 'assistant' && role !== 'model') return
                const content = extractMessageContent(parsed)
                if (content) {
                    emittedText = true
                    if (tFirstToken === null) tFirstToken = Date.now()
                    yield { type: 'token', text: content }
                }
                return
            }

            if (type === 'tool_call' || type === 'tool_use') {
                const toolCall = extractToolCall(parsed)
                if (toolCall) yield toolCall
                return
            }

            if (type === 'tool_result') {
                const toolResult = extractToolResult(parsed)
                if (toolResult) yield toolResult
                return
            }

            if (type === 'result') {
                // Bill even error results: the per-model breakdowns cover
                // tokens already consumed before the turn failed.
                for (const usage of extractGeminiUsage(
                    parsed,
                    model,
                    tStart,
                    tFirstToken,
                    pricing,
                    {
                        modelProviderId: ctx.modelProviderId,
                        modelProviderBuiltInId: ctx.modelProviderBuiltInId
                    }
                ))
                    yield { type: 'usage', usage }
                const status = stringField(parsed, 'status')
                // Held, not yielded: gemini writes the stderr cause and this
                // line at essentially the same moment (it stays silent through
                // the whole retry window), so reading the tail here would race
                // the stderr drain and usually lose. Emitted below, once the
                // exec has ended and stderr is complete.
                if (status && status !== 'success')
                    resultError =
                        stringField(parsed, 'message') ??
                        stringField(parsed, 'error') ??
                        resultErrorMessage(parsed) ??
                        `gemini result status=${status}`
                return
            }

            if (type === 'error') {
                const message =
                    stringField(parsed, 'message') ??
                    stringField(parsed, 'error') ??
                    JSON.stringify(parsed).slice(0, 512)
                const severity = stringField(parsed, 'severity')
                const managedChannelFailure =
                    classifyManagedChannelFailureSignal({ message }) ??
                    (severity === 'warning'
                        ? null
                        : classifyGeminiCliInspectedFailureSignal({
                              machineStderr: message,
                              untrustedCauseCount: 0
                          }))
                streamErrorText += `\n${message}`
                yield {
                    type: 'error',
                    ...(managedChannelFailure ? { managedChannelFailure } : {}),
                    error: {
                        code: 'gemini_error',
                        message,
                        // #803: the same structured-rate-limit rule the two
                        // terminals below apply, so whichever channel the CLI
                        // reports a throttled attempt on, the user is told the
                        // same thing about sending it again.
                        retryable: isRetryableRateLimit('gemini_error', message)
                    }
                }
                return
            }
        }

        let transportError: Error | null = null
        try {
            for await (const chunk of handle.stdout) {
                lineBuffer += chunk
                let nl = lineBuffer.indexOf('\n')
                while (nl !== -1) {
                    const rawLine = lineBuffer.slice(0, nl).replace(/\r$/, '')
                    const line = rawLine.trim()
                    lineBuffer = lineBuffer.slice(nl + 1)
                    nl = lineBuffer.indexOf('\n')
                    if (!line) continue
                    // Resume watermark: the transport seq of the chunk that
                    // completed this line, and only when the chunk ended
                    // exactly here — a chunk ending mid-line carries the HEAD
                    // of the next one, so resuming past it truncates that line
                    // and it vanishes on parse. Without this every gemini
                    // resume replays the whole turn from 0.
                    const runnerSeq =
                        lineBuffer === ''
                            ? handle.lastDeliveredSeq?.()
                            : undefined
                    // Drained eagerly: consumeLine discovers the session id as
                    // a side effect, which ensureTail needs. pump() only
                    // drains what the background poll already landed — the
                    // remote read must never pace the delivery loop (#518), so
                    // a step's thinking may now trail its first content burst
                    // by up to one poll instead of strictly preceding it.
                    const events = [...consumeLine(line, rawLine, ++sourceSeq)]
                    if (
                        events.some(
                            (ev) =>
                                ev.type === 'token' || ev.type === 'tool_call'
                        )
                    ) {
                        const t = await ensureTail()
                        if (t) yield* t.pump()
                    }
                    for (const ev of events)
                        yield ev.type === 'raw_source' &&
                        runnerSeq !== undefined
                            ? { ...ev, runnerSeq }
                            : ev
                    if (sessionRef && sessionRef !== persistedSessionRef) {
                        persistedSessionRef = sessionRef
                        await this.chatRepo
                            .updateFrameworkSessionRef(
                                ctx.sessionId,
                                sessionRef,
                                ctx.turnFence
                            )
                            .catch((err: Error) => {
                                if (err instanceof TurnFenceLostError) throw err
                                this.logger.warn(
                                    `gemini session-ref persist failed: ${err.message}`
                                )
                            })
                    }
                }
            }
            const rawTrailing = lineBuffer.replace(/\r$/, '')
            const trailing = rawTrailing.trim()
            if (trailing) yield* consumeLine(trailing, rawTrailing, ++sourceSeq)
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
        // Safe to await: both drivers end their stderr sink when the exec
        // settles, on the failure path too.
        await stderrDrained
        const stderrText = execResult?.stderr.trim() || drainedStderr()

        // The unsigned-history 400 is a property of the CLI's own session file,
        // not of this prompt: resuming the same session replays the same illegal
        // history and gets the same 400 forever. Drop the resume ref so the next
        // turn opens a fresh gemini session — the same fork the message-edit path
        // performs. Done before the error yields below, which return early.
        const poisonedHistory = isUnsignedHistoryError(
            `${stderrText}\n${resultError ?? ''}${streamErrorText}`
        )
        if (poisonedHistory && (sessionRef || persistedSessionRef)) {
            this.logger.warn(
                `gemini session history unsigned, forking session agent=${ctx.agentId} session=${ctx.sessionId} ref=${sessionRef ?? persistedSessionRef}`
            )
            await this.chatRepo
                .updateFrameworkSessionRef(ctx.sessionId, null, ctx.turnFence)
                .catch((err: Error) => {
                    if (err instanceof TurnFenceLostError) throw err
                    this.logger.warn(
                        `gemini session-ref reset failed: ${err.message}`
                    )
                })
            sessionRef = null
            persistedSessionRef = null
        }

        if (transportError) {
            const suspendable = opts.resumeAttach
                ? isDaemonResumeSuspendError(transportError)
                : isDaemonOfflineTransportError(transportError)
            if (carryingDaemonId && suspendable) {
                this.logger.log(
                    `gemini exec suspended (daemon offline) agent=${ctx.agentId} session=${ctx.sessionId} message=${ctx.messageId}`
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
                `gemini exec transport error: ${transportError.message}`
            )
            yield {
                type: 'error',
                error: {
                    code: 'gemini_exec_failed',
                    message: transportError.message,
                    retryable: true
                }
            }
            return
        }

        if (execResult && execResult.exitCode !== 0) {
            const message = withHistoryHint(
                withStderr(`gemini exited ${execResult.exitCode}`, stderrText),
                poisonedHistory
            )
            const managedChannelFailure =
                classifyManagedChannelFailureSignal({ message }) ??
                classifyGeminiCliInspectedFailureSignal({
                    machineStderr: stderrText,
                    untrustedCauseCount: untrustedInspectedCauseCount
                })
            // #803: gemini answers a 429 by walking its own retry ladder for
            // minutes and then exiting non-zero, so this branch was writing a
            // failure the provider itself declared transient as a generic
            // non-retryable exit. Read from the same `message` the terminal
            // carries, so the retryability the user is shown and the cause the
            // incident is filed under can never disagree.
            const rateLimited = isRetryableRateLimit(
                'gemini_exec_failed',
                message
            )
            // A newly dispatched turn carries the ref it attempted in its
            // context. A daemon resume does not: chat.service rebuilds the
            // context from the row's CURRENT ref, which may have changed while
            // the exec was suspended. In that case only use the identifier the
            // CLI itself named. `No previous sessions` carries no identifier,
            // so a resumed turn cannot safely clear anything for that shape.
            const attemptedRef = opts.resumeAttach
                ? resumeTargetRefFromStderr(stderrText)
                : ctx.frameworkSessionRef
            const unresolvableResume =
                !poisonedHistory &&
                (!!attemptedRef || !!opts.resumeAttach) &&
                isResumeTargetUnresolvable(execResult.exitCode, stderrText)
            let refClearOutcome: StaleResumeClearOutcome = 'clear_failed'
            if (unresolvableResume && attemptedRef) {
                try {
                    const cleared =
                        await this.chatRepo.clearFrameworkSessionRefIfMatches(
                            ctx.sessionId,
                            attemptedRef,
                            ctx.turnFence
                        )
                    refClearOutcome = cleared ? 'cleared' : 'state_changed'
                } catch (err) {
                    if (err instanceof TurnFenceLostError) throw err
                    this.logger.warn(
                        'gemini stale-resume reference clear failed'
                    )
                }
            }
            if (unresolvableResume) {
                this.logger.warn(
                    `gemini stale-resume recovery ${staleResumeClearLog(refClearOutcome)}`
                )
                this.telemetry?.event('chat.gemini.stale_resume_recovery', {
                    outcome: refClearOutcome
                })
            }
            yield {
                type: 'error',
                ...(managedChannelFailure ? { managedChannelFailure } : {}),
                error: {
                    code: 'gemini_exec_failed',
                    // The stderr is dropped on this path on purpose: its whole
                    // content is the opaque session uuid and the runtime-local
                    // chats directory it searched, neither of which the user
                    // can act on and neither of which redactSecrets covers.
                    message: unresolvableResume
                        ? `gemini exited ${execResult.exitCode}\n\n${staleResumeHint(refClearOutcome)}`
                        : message,
                    // a fresh session is a genuinely different input, so the
                    // retry that used to 400 (or exit 42) forever can now
                    // succeed; a throttled one is the same input at a less busy
                    // moment, which is why neither is replayed for the user
                    retryable:
                        execResult.exitCode === 124 ||
                        poisonedHistory ||
                        unresolvableResume ||
                        rateLimited
                }
            }
            return
        }

        if (resultError) {
            const message = withHistoryHint(
                withStderr(resultError, stderrText),
                poisonedHistory
            )
            const managedChannelFailure =
                classifyManagedChannelFailureSignal({ message }) ??
                classifyGeminiCliInspectedFailureSignal({
                    machineStderr: stderrText,
                    untrustedCauseCount: untrustedInspectedCauseCount
                })
            yield {
                type: 'error',
                ...(managedChannelFailure ? { managedChannelFailure } : {}),
                error: {
                    code: 'gemini_result_error',
                    message,
                    // #803: gemini reports a throttled turn here whenever it
                    // exits 0 having written the 429 into its own result
                    // envelope, so this branch has to read the same signal the
                    // non-zero one above does — otherwise the same upstream
                    // refusal is retryable or not depending on the exit code.
                    retryable:
                        poisonedHistory ||
                        isRetryableRateLimit('gemini_result_error', message)
                }
            }
        }

        if (!emittedText && execResult && execResult.stdout.trim())
            yield { type: 'token', text: execResult.stdout.trim() }

        if (sessionRef && sessionRef !== ctx.frameworkSessionRef)
            await this.chatRepo.updateFrameworkSessionRef(
                ctx.sessionId,
                sessionRef,
                ctx.turnFence
            )

        // Forced: the last step's thoughts are flushed with its final snapshot,
        // which may land after the throttle window of the last poll.
        const finalTail = await ensureTail()
        if (finalTail) yield* await finalTail.finish()

        yield { type: 'done', finalMessageId: ctx.messageId }
    }
}

// Head + tail of the turn's stderr. Redaction runs over everything that is
// still in hand BEFORE this slice, so a credential straddling the cut cannot
// survive in either half.
const stderrDetail = (stderr: string): string => {
    const text = redactSecrets(stderr).trim()
    if (text.length <= STDERR_HEAD_CHARS + STDERR_DETAIL_CHARS) return text
    return `${text.slice(0, STDERR_HEAD_CHARS)}${STDERR_ELISION}${text.slice(-STDERR_DETAIL_CHARS)}`
}

// The provider rejects a REPLAYED history whose functionCall parts carry no
// thought signature — a gemini-cli 0.53.0-0.54.0 defect (google-gemini/
// gemini-cli#28604) that writes such history into the session file. Both spellings
// appear in the wild (`thought_signature` from the API, `thoughtSignature` in
// CLI-side messages), and the phrasing varies either side of the noun.
const UNSIGNED_HISTORY_RE =
    /missing[^\n]{0,80}thought[_ ]?signature|thought[_ ]?signature[^\n]{0,80}(?:missing|required)/i

const isUnsignedHistoryError = (text: string): boolean =>
    UNSIGNED_HISTORY_RE.test(text)

const HISTORY_FORK_HINT =
    'the gemini session history is missing tool-call thought signatures (gemini-cli 0.53.0-0.54.0 regression); the framework session was reset, so a retry starts a fresh gemini session'

const withHistoryHint = (message: string, poisoned: boolean): string =>
    poisoned ? `${message}\n\n${HISTORY_FORK_HINT}` : message

// `--resume <uuid>` is resolved against the CURRENT project's resumable-session
// list. Invalid, unreadable, corrupt, or otherwise non-resumable entries can be
// filtered from that list before SessionSelector.resolveSession runs. The two
// coded errors below therefore prove only that the target cannot be resolved,
// not why. The resolver throws before `init`, so no new session_id replaces the
// stored ref and every later turn otherwise repeats the failure (#729).
const GEMINI_FATAL_INPUT_EXIT = 42
const RESUME_TARGET_UNRESOLVABLE_RE =
    /Error resuming session:[^\n]{0,40}?(?:Invalid session identifier|No previous sessions found for this project)/i
const RESUME_TARGET_IDENTIFIER_RE =
    /Error resuming session:[^\n]{0,40}?Invalid session identifier "([^"\r\n]+)"/i

const isResumeTargetUnresolvable = (
    exitCode: number,
    stderr: string
): boolean =>
    exitCode === GEMINI_FATAL_INPUT_EXIT &&
    RESUME_TARGET_UNRESOLVABLE_RE.test(stderr)

const resumeTargetRefFromStderr = (stderr: string): string | null =>
    stderr.match(RESUME_TARGET_IDENTIFIER_RE)?.[1] ?? null

const STALE_RESUME_HINT =
    'the saved gemini session this chat was resuming could not be resolved by the runtime; its reference was dropped, so a retry starts a fresh gemini session'

// A losing CAS can mean another writer installed a newer ref OR another stale
// turn already cleared this one. Keep the message true for both states.
const STALE_RESUME_STATE_CHANGED_HINT =
    'the saved gemini session this chat was resuming could not be resolved by the runtime; the stored session state has already changed, so a retry uses its current state'

const STALE_RESUME_CLEAR_FAILED_HINT =
    'the saved gemini session this chat was resuming could not be resolved by the runtime; its reference could not be safely dropped, so retry after the session state is available again'

type StaleResumeClearOutcome = 'cleared' | 'state_changed' | 'clear_failed'

const staleResumeHint = (outcome: StaleResumeClearOutcome): string => {
    if (outcome === 'cleared') return STALE_RESUME_HINT
    if (outcome === 'state_changed') return STALE_RESUME_STATE_CHANGED_HINT
    return STALE_RESUME_CLEAR_FAILED_HINT
}

const staleResumeClearLog = (outcome: StaleResumeClearOutcome): string => {
    if (outcome === 'cleared')
        return 'cleared frameworkSessionRef so the next turn starts a fresh session'
    if (outcome === 'state_changed')
        return 'left frameworkSessionRef alone because its stored state already changed'
    return 'could not safely clear frameworkSessionRef; the next turn may still need recovery'
}

const safeParse = (line: string): Record<string, unknown> | null => {
    try {
        return JSON.parse(line) as Record<string, unknown>
    } catch {
        return null
    }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null

const reflectedToolResultCauseCount = (
    obj: Record<string, unknown>
): number => {
    if (stringField(obj, 'status') !== 'error') return 0
    const output = stringField(obj, 'output')
    if (output) return countGeminiCliInspectedPoolEmptyCauses(output)
    const error = obj.error
    return isRecord(error) && typeof error.message === 'string'
        ? countGeminiCliInspectedPoolEmptyCauses(error.message)
        : 0
}

const stringField = (
    obj: Record<string, unknown>,
    key: string
): string | null => {
    const value = obj[key]
    return typeof value === 'string' ? value : null
}

const extractMessageContent = (obj: Record<string, unknown>): string | null => {
    const content = obj.content
    if (typeof content === 'string' && content.length > 0) return content
    if (Array.isArray(content)) {
        const joined = content
            .map((part) =>
                isRecord(part) && typeof part.text === 'string' ? part.text : ''
            )
            .join('')
        return joined.length > 0 ? joined : null
    }
    if (isRecord(content)) {
        const text = content.text
        if (typeof text === 'string' && text.length > 0) return text
    }
    return null
}

const extractToolCall = (
    obj: Record<string, unknown>
): EmittedChatEvent | null => {
    const type = stringField(obj, 'type')
    if (type !== 'tool_call' && type !== 'tool_use') return null
    const id = stringField(obj, 'id') ?? stringField(obj, 'toolCallId')
    const name = stringField(obj, 'name') ?? stringField(obj, 'toolName')
    if (!id || !name) return null
    return {
        type: 'tool_call',
        toolCallId: id,
        toolName: name,
        args: obj.args ?? obj.input ?? null
    }
}

const resultErrorMessage = (obj: Record<string, unknown>): string | null => {
    const error = obj.error
    if (!isRecord(error)) return null
    const message = error.message
    return typeof message === 'string' && message.length > 0 ? message : null
}

const extractToolResult = (
    obj: Record<string, unknown>
): EmittedChatEvent | null => {
    const type = stringField(obj, 'type')
    if (type !== 'tool_result') return null
    const id = stringField(obj, 'id') ?? stringField(obj, 'toolCallId')
    if (!id) return null
    return {
        type: 'tool_result',
        toolCallId: id,
        result: obj.result ?? obj.output ?? null
    }
}
