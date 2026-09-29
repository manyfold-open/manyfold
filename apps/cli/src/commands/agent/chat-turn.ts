import { randomUUID } from 'node:crypto'
import { stat } from 'node:fs/promises'
import { basename } from 'node:path'
import kleur from 'kleur'
import {
    CHAT_ATTACHMENT_MAX_COUNT,
    CHAT_ATTACHMENT_MAX_FILE_BYTES,
    CHAT_ATTACHMENT_MAX_TOTAL_BYTES,
    CHAT_MESSAGE_MAX_TEXT,
    type ChatError,
    type ChatPermissionRequestEvent,
    type ChatSessionSummary,
    type ChatToolCallEvent,
    type ChatUsage,
    type CreateMessageAttachmentInput
} from '@manyfold/shared'
import { ApiError, type NcaClient } from '@manyfold/sdk'
import { uploadFile } from '@/commands/files/transfer'
import { UsageError } from '@/usage-error'

// One turn with an agent from the terminal, as `mf agent send` and
// `mf agent chat` take it: the message is sent the way the web sends it,
// and the reply is read off the session's stream.

// The API sends a keepalive every 15 s.
const IDLE_MS = 60_000
const RECONNECTS = 5
// How long a Ctrl-C waits for the turn to stop before leaving anyway.
const STOP_WAIT_MS = 15_000

// The message: the arguments, or stdin for `-` or when none are given and
// stdin is a pipe. The newline a pipe from echo adds is dropped.
export const readMessage = (
    args: readonly string[],
    stdin: { isTTY: boolean; read: () => string }
): string => {
    const dash = args.length === 1 && args[0] === '-'
    if (dash && stdin.isTTY)
        throw new UsageError(
            '- reads the message from stdin, which is a terminal here: pipe the message in, or pass it as arguments'
        )
    const text =
        dash || (args.length === 0 && !stdin.isTTY)
            ? stdin.read().replace(/\r?\n$/, '')
            : args.join(' ')
    if (text.length > CHAT_MESSAGE_MAX_TEXT)
        throw new UsageError(
            `the message is ${text.length} characters; one message takes at most ${CHAT_MESSAGE_MAX_TEXT}`
        )
    return text
}

export interface LocalFile {
    path: string
    name: string
    size: number
}

const mib = (bytes: number): string =>
    `${(bytes / (1024 * 1024)).toFixed(bytes < 1024 * 1024 ? 2 : 0)} MiB`

// The files to attach, checked before anything is created against the
// limits the API holds a message's attachments to.
export const checkFiles = async (
    paths: readonly string[]
): Promise<LocalFile[]> => {
    if (paths.length > CHAT_ATTACHMENT_MAX_COUNT)
        throw new UsageError(
            `${paths.length} files; one message takes at most ${CHAT_ATTACHMENT_MAX_COUNT}`
        )
    const files: LocalFile[] = []
    for (const path of paths) {
        const info = await stat(path).catch(() => null)
        if (!info) throw new UsageError(`no such file: ${path}`)
        if (!info.isFile())
            throw new UsageError(
                `${path} is not a file; attach files one by one`
            )
        if (info.size > CHAT_ATTACHMENT_MAX_FILE_BYTES)
            throw new UsageError(
                `${path} is ${mib(info.size)}; a file can be at most ${mib(CHAT_ATTACHMENT_MAX_FILE_BYTES)}`
            )
        files.push({ path, name: basename(path), size: info.size })
    }
    const total = files.reduce((sum, file) => sum + file.size, 0)
    if (total > CHAT_ATTACHMENT_MAX_TOTAL_BYTES)
        throw new UsageError(
            `the files come to ${mib(total)}; one message takes at most ${mib(CHAT_ATTACHMENT_MAX_TOTAL_BYTES)}`
        )
    return files
}

// The session last active. The list comes oldest first by creation; a
// session a channel drives is someone else's conversation.
export const latestSession = (
    sessions: readonly ChatSessionSummary[]
): ChatSessionSummary | null =>
    sessions
        .filter((session) => !session.channel)
        .reduce<ChatSessionSummary | null>(
            (latest, session) =>
                !latest ||
                session.updatedAt > latest.updatedAt ||
                (session.updatedAt === latest.updatedAt &&
                    session.createdAt > latest.createdAt)
                    ? session
                    : latest,
            null
        )

export const pickSession = async (
    client: NcaClient,
    agentId: string,
    choice: { session?: string; continue?: boolean }
): Promise<{ id: string; created: boolean }> => {
    if (choice.session) return { id: choice.session, created: false }
    if (choice.continue) {
        const latest = latestSession(await client.chat.listSessions(agentId))
        if (latest) return { id: latest.id, created: false }
        console.error(
            kleur.dim(`${agentId} has no session to continue; starting one`)
        )
    }
    return { id: (await client.chat.createSession(agentId)).id, created: true }
}

// Where the web puts a message's files, in the workspace root; the
// attachment then names them there.
export const uploadFiles = async (
    client: NcaClient,
    agentId: string,
    sessionId: string,
    files: readonly LocalFile[]
): Promise<CreateMessageAttachmentInput[]> => {
    const attachments: CreateMessageAttachmentInput[] = []
    for (const file of files) {
        const path = `chat-attachments/${sessionId}/${randomUUID()}/${file.name}`
        await uploadFile(
            { client, agentId, remotePath: path, rootId: 'workspace' },
            file.path
        )
        attachments.push({
            path,
            rootId: 'workspace',
            name: file.name,
            size: file.size
        })
    }
    return attachments
}

export interface TurnView {
    text: (chunk: string) => void
    // The answer so far was superseded by this one.
    replaced: (text: string) => void
    toolCall: (event: ChatToolCallEvent) => void
    notice: (line: string) => void
    permission: (event: ChatPermissionRequestEvent) => void | Promise<void>
}

export interface TurnOutcome {
    sessionId: string
    userMessageId: string
    assistantMessageId: string
    text: string
    usage: ChatUsage | null
    error: ChatError | null
    // Stopped by a Ctrl-C here, not by an error or from elsewhere.
    cancelled: boolean
    elapsedMs: number
}

// The reply stream could not be followed to the end; the turn itself goes
// on on the server.
export class TurnStreamLost extends Error {
    constructor(
        readonly sessionId: string,
        cause: unknown
    ) {
        super(
            `lost the reply stream (${cause instanceof Error ? cause.message : String(cause)}); the turn goes on on the server`
        )
        this.name = 'TurnStreamLost'
    }
}

// A request the API refused as such is not worth repeating; a dropped
// connection, a 5xx or a stream that ended early is.
const reconnectable = (err: unknown): boolean =>
    !(err instanceof ApiError) || ![400, 401, 403, 404].includes(err.status)

export interface TurnDeps {
    exit?: (code: number) => void
    retryDelayMs?: (attempt: number) => number
}

export const runTurn = async (
    client: NcaClient,
    input: {
        agentId: string
        sessionId: string
        text?: string
        attachments?: CreateMessageAttachmentInput[]
    },
    view: TurnView,
    deps: TurnDeps = {}
): Promise<TurnOutcome> => {
    const { agentId, sessionId } = input
    const exit = deps.exit ?? ((code: number) => process.exit(code))
    const retryDelayMs =
        deps.retryDelayMs ??
        ((attempt: number) => Math.min(1_000 * 2 ** (attempt - 1), 8_000))
    const started = Date.now()
    let assistantMessageId: string | null = null
    let stopping = false
    let cancelSent = false
    let stopTimer: ReturnType<typeof setTimeout> | undefined
    const sendCancel = (): void => {
        if (!assistantMessageId || cancelSent) return
        cancelSent = true
        client.chat
            .cancelStream(agentId, sessionId, assistantMessageId)
            .catch((err: unknown) => {
                // 409: the turn had already ended.
                if (err instanceof ApiError && err.status === 409) return
                view.notice(
                    `could not stop the turn: ${err instanceof Error ? err.message : String(err)}`
                )
            })
    }
    // The first Ctrl-C stops the turn and waits for it to end; a second
    // one, or a turn that does not end, leaves at once.
    const onSigint = (): void => {
        if (stopping) {
            exit(130)
            return
        }
        stopping = true
        view.notice('stopping the turn… (Ctrl-C again to leave now)')
        sendCancel()
        stopTimer = setTimeout(() => exit(130), STOP_WAIT_MS)
    }
    process.on('SIGINT', onSigint)
    try {
        // The agent's saved model and permission settings apply: nothing
        // here overrides or saves them.
        const sent = await client.chat.sendMessage(agentId, sessionId, {
            ...(input.text ? { text: input.text } : {}),
            ...(input.attachments?.length
                ? { attachments: input.attachments }
                : {})
        })
        assistantMessageId = sent.assistantMessageId
        if (stopping) sendCancel()
        let text = ''
        let usage: ChatUsage | null = null
        let error: ChatError | null = null
        let finished = false
        let lastEventId: string | undefined
        let failures = 0
        while (!finished) {
            try {
                const events = client.chat.streamSession(agentId, sessionId, {
                    ...(lastEventId
                        ? { lastEventId }
                        : { replayMessageId: assistantMessageId }),
                    idleTimeoutMs: IDLE_MS
                })
                for await (const event of events) {
                    lastEventId = event.eventId
                    failures = 0
                    // The stream carries every turn of the session.
                    if (event.messageId !== assistantMessageId) continue
                    if (event.type === 'token') {
                        text += event.text
                        view.text(event.text)
                    } else if (event.type === 'replace') {
                        text = event.text
                        view.replaced(event.text)
                    } else if (event.type === 'tool_call') view.toolCall(event)
                    else if (event.type === 'usage') usage = event.usage
                    else if (event.type === 'permission_request')
                        await view.permission(event)
                    else if (event.type === 'turn_status')
                        view.notice(
                            event.phase === 'recovering'
                                ? 'the turn was interrupted; recovering it…'
                                : 'picking the turn up again…'
                        )
                    else if (event.type === 'error') {
                        error = event.error
                        finished = true
                    } else if (event.type === 'done') finished = true
                    if (finished) break
                }
                if (!finished)
                    throw new Error('the stream ended before the turn did')
            } catch (err) {
                if (!reconnectable(err) || ++failures > RECONNECTS)
                    throw new TurnStreamLost(sessionId, err)
                view.notice(
                    `lost the reply stream; reconnecting (${failures}/${RECONNECTS})`
                )
                await new Promise((resolve) =>
                    setTimeout(resolve, retryDelayMs(failures))
                )
            }
        }
        // The stream carries the turn's usage only on some paths; the turn's
        // message has it once the turn has ended.
        if (!usage) {
            const turnId = assistantMessageId
            usage = await client.chat
                .listMessagePage(agentId, sessionId, { limit: 2 })
                .then(
                    (page) =>
                        page.messages.find((message) => message.id === turnId)
                            ?.usage ?? null
                )
                .catch(() => null)
        }
        return {
            sessionId,
            userMessageId: sent.userMessage.id,
            assistantMessageId,
            text,
            usage,
            error,
            cancelled: stopping && error?.code === 'cancelled_by_user',
            elapsedMs: Date.now() - started
        }
    } finally {
        process.removeListener('SIGINT', onSigint)
        clearTimeout(stopTimer)
    }
}

const ARG_KEYS = [
    'file_path',
    'path',
    'command',
    'pattern',
    'url',
    'query',
    'description'
]

// `→ Read src/x.ts`: the tool and the argument that says what it acts on.
export const toolLine = (event: ChatToolCallEvent): string => {
    const args =
        event.args && typeof event.args === 'object'
            ? (event.args as Record<string, unknown>)
            : {}
    const subject = ARG_KEYS.map((key) => args[key]).find(
        (value): value is string => typeof value === 'string' && value !== ''
    )
    const shown = subject?.replace(/\s+/g, ' ').trim()
    return `→ ${event.toolName}${shown ? ` ${shown.length > 80 ? `${shown.slice(0, 79)}…` : shown}` : ''}`
}

const count = (n: number): string =>
    n >= 1_000_000
        ? `${(n / 1_000_000).toFixed(1)}M`
        : n >= 1_000
          ? `${(n / 1_000).toFixed(1)}k`
          : String(n)

// What the turn ran on and cost, and how to go on in the same session.
export const footer = (
    outcome: TurnOutcome,
    continueWith: string
): string[] => {
    const usage = outcome.usage
    const cost =
        usage?.costUsd === null || usage?.costUsd === undefined
            ? null
            : `$${usage.costUsd.toFixed(4)}`
    const parts = [
        usage?.model ?? null,
        usage
            ? `${count(usage.inputTokens)} in / ${count(usage.cacheReadTokens + usage.cacheCreationTokens)} cache / ${count(usage.outputTokens)} out`
            : null,
        cost,
        `${(outcome.elapsedMs / 1000).toFixed(1)} s`
    ].filter((part): part is string => part !== null)
    return [
        parts.join(' · '),
        `session ${outcome.sessionId} · continue: ${continueWith}`
    ]
}

// The reply as a person reads it. On a terminal it streams as it comes;
// otherwise (a pipe, a file) the final answer is printed once at the end,
// after any replacement.
export const humanView = (options: {
    stream: boolean
    chatLink: () => Promise<string | null>
}): TurnView & { finish: (outcome: TurnOutcome) => void } => {
    // Whether stdout holds a line not yet ended, which a line on stderr
    // would otherwise land in the middle of.
    let openLine = false
    const endLine = (): void => {
        if (!openLine) return
        process.stdout.write('\n')
        openLine = false
    }
    const aside = (line: string): void => {
        endLine()
        console.error(line)
    }
    return {
        text: (chunk) => {
            if (!options.stream || !chunk) return
            process.stdout.write(chunk)
            openLine = !chunk.endsWith('\n')
        },
        replaced: (text) => {
            if (!options.stream) return
            aside(kleur.dim('(the answer was rewritten:)'))
            process.stdout.write(text)
            openLine = !text.endsWith('\n')
        },
        toolCall: (event) => aside(kleur.dim(toolLine(event))),
        notice: (line) => aside(kleur.dim(line)),
        permission: async (event) => {
            aside(kleur.yellow(`The agent asks: ${event.title}`))
            if (event.detail) aside(kleur.dim(event.detail))
            const link = await options.chatLink()
            aside(
                kleur.dim(
                    `Answer it in the web chat${link ? `: ${link}` : ''}; the turn waits for it.`
                )
            )
        },
        finish: (outcome) => {
            if (options.stream) endLine()
            else if (!outcome.error && outcome.text) console.log(outcome.text)
        }
    }
}
