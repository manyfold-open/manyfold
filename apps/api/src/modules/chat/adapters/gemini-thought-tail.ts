import type { EmittedChatEvent } from '@/modules/chat/chat-adapter'
import type { RecoveryFs } from '@/modules/chat/recovery/recovery-fs'
import { shellEscape } from '@/modules/chat/recovery/recovery-fs'
import {
    contentText,
    geminiSessionLocateScript,
    reconstructGeminiSessionJsonl,
    thoughtsText
} from '@/modules/chat/recovery/turn-gemini-session-recovery'

// gemini-cli's `--output-format stream-json` has NO thought event: upstream's
// JsonStreamEventType is init/message/tool_use/tool_result/error/result and the
// non-interactive event loop has no GeminiEventType.Thought branch at all, so
// thoughts never reach our stdout. They ARE recorded: ChatRecordingService
// queues each thought in memory and appends it as `thoughts[]` on the gemini
// message snapshot in the session JSONL. This tail re-reads that file during
// the turn and turns the new thoughts into `thinking` events, so the ONLY
// source of gemini thinking in Manyfold is the same file turn adoption reads.
//
// Timing: the CLI flushes queued thoughts when it writes the message snapshot,
// so a step's thoughts land with that step's first content burst — thinking
// arrives just before/with the text it belongs to, not as a live token stream.

const DEFAULT_POLL_MS = 1500
const MAX_READS_PER_TURN = 60
const MAX_LOCATE_ATTEMPTS = 3
const MAX_READ_FAILURES = 2

export const geminiThoughtPollMs = (): number => {
    const raw = Number(process.env.MF_GEMINI_THINKING_POLL_MS ?? DEFAULT_POLL_MS)
    if (!Number.isFinite(raw) || raw < 0) return DEFAULT_POLL_MS
    return Math.floor(raw)
}

export interface GeminiThoughtTail {
    // Emit `thinking` for whatever new thoughts the session file has gained.
    // Throttled to pollMs unless forced. Never throws — a broken tail just
    // stops emitting. AWAITS the remote read: the delivery loop must use
    // pump() instead (#518 — awaiting this per line let a 407KB session file
    // pace token delivery to ~7s/line and a 73s turn took 5.5min to drain).
    maybePoll(force?: boolean): Promise<EmittedChatEvent[]>
    // Non-blocking: drain thoughts landed by the background poll and, when
    // the throttle allows, kick the next poll without awaiting it.
    pump(): EmittedChatEvent[]
    // Await the in-flight poll, then one forced read — the last step's
    // thoughts land with its final snapshot. Call once before the terminal.
    finish(): Promise<EmittedChatEvent[]>
}

export interface GeminiThoughtTailArgs {
    fs: RecoveryFs
    frameworkSessionRef: string
    // The verbatim prompt of THIS turn: gemini does not wrap it, so the last
    // user message matching it anchors the turn inside a multi-turn session.
    promptText: string
    pollMs: number
    now?: () => number
    onWarn?: (message: string) => void
}

export const createGeminiThoughtTail = (
    args: GeminiThoughtTailArgs
): GeminiThoughtTail => {
    const now = args.now ?? ((): number => Date.now())
    // Per gemini message id: how much of its thought text we already emitted.
    // The SAME id is re-appended as the message grows, so only the new suffix
    // may be emitted or every poll would repeat the whole thing.
    const emitted = new Map<string, number>()
    let sourceFile: string | null = null
    let locateAttempts = 0
    let readFailures = 0
    let reads = 0
    let lastPollAt = 0
    let lastSize = -1
    let disabled = args.pollMs <= 0

    // One exec round trip instead of a full re-read: the session file only
    // grows, so an unchanged size means an unchanged file. Any probe failure
    // falls through to the read.
    const probeSize = async (): Promise<number | null> => {
        if (!sourceFile || typeof args.fs.exec !== 'function') return null
        try {
            const escaped = shellEscape(sourceFile)
            const out = await args.fs.exec(
                `stat -c %s ${escaped} 2>/dev/null || stat -f %z ${escaped}`
            )
            if (out === null) return null
            const size = Number(out.trim())
            return Number.isFinite(size) ? size : null
        } catch {
            return null
        }
    }

    const poll = async (force: boolean): Promise<EmittedChatEvent[]> => {
        if (!sourceFile) {
            if (locateAttempts >= MAX_LOCATE_ATTEMPTS) {
                disabled = true
                args.onWarn?.(
                    `gemini thought tail: session file for ${args.frameworkSessionRef} not found`
                )
                return []
            }
            locateAttempts++
            sourceFile = await args.fs.locate(
                geminiSessionLocateScript(args.frameworkSessionRef)
            )
            if (!sourceFile) return []
        }

        if (!force && lastSize >= 0) {
            const size = await probeSize()
            if (size !== null && size === lastSize) return []
        }

        if (reads >= MAX_READS_PER_TURN) {
            disabled = true
            return []
        }
        reads++
        const text = await args.fs.readFile(sourceFile)
        if (text === null) {
            if (++readFailures >= MAX_READ_FAILURES) disabled = true
            return []
        }
        readFailures = 0
        lastSize = Buffer.byteLength(text, 'utf8')

        const { messages } = reconstructGeminiSessionJsonl(text)
        let anchorIdx = -1
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i]
            if (m.type !== 'user') continue
            if (contentText(m.content) === args.promptText) {
                anchorIdx = i
                break
            }
        }
        if (anchorIdx === -1) return []

        const out: EmittedChatEvent[] = []
        for (let i = anchorIdx + 1; i < messages.length; i++) {
            const m = messages[i]
            if (m.type !== 'gemini') continue
            const thought = thoughtsText(m.thoughts)
            if (!thought) continue
            const already = emitted.get(m.id) ?? 0
            if (thought.length <= already) continue
            emitted.set(m.id, thought.length)
            out.push({ type: 'thinking', text: thought.slice(already) })
        }
        return out
    }

    const maybePoll = async (force = false): Promise<EmittedChatEvent[]> => {
        if (disabled) return []
        const t = now()
        if (!force && t - lastPollAt < args.pollMs) return []
        lastPollAt = t
        try {
            return await poll(force)
        } catch (err) {
            if (++readFailures >= MAX_READ_FAILURES) disabled = true
            args.onWarn?.(
                `gemini thought tail failed: ${(err as Error).message}`
            )
            return []
        }
    }

    let pending: EmittedChatEvent[] = []
    let inflight: Promise<void> | null = null

    return {
        maybePoll,
        pump(): EmittedChatEvent[] {
            const out = pending
            if (out.length > 0) pending = []
            if (!inflight && !disabled) {
                const kicked = maybePoll()
                    .then((events) => {
                        if (events.length > 0) pending.push(...events)
                    })
                    .catch(() => {})
                    .finally(() => {
                        if (inflight === kicked) inflight = null
                    })
                inflight = kicked
            }
            return out
        },
        async finish(): Promise<EmittedChatEvent[]> {
            if (inflight) await inflight
            const final = await maybePoll(true)
            const out = [...pending, ...final]
            pending = []
            return out
        }
    }
}
