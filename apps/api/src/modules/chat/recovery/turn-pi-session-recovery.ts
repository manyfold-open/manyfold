import type { ChatUsage } from '@manyfold/shared'
import type { EmittedChatEvent } from '@/modules/chat/chat-adapter'
import type { RecoveryFs } from '@/modules/chat/recovery/recovery-fs'
import {
    addPiUsage,
    emptyPiUsageTotals
} from '@/modules/chat/adapters/pi-usage'
import {
    piSessionLocateScript,
    piSessionPath,
    type PiEntry,
    type PiPathEntry
} from '@/modules/chat/recovery/readers/pi-reader'

// Recover an adopted PI turn from its session file. pi appends one entry per
// finished message along the conversation's path — the prompt, each assistant
// message, each tool result — so the turn comes back one whole message at a
// time, under the tool-call ids the live stream carried. Nothing in the file
// closes a turn: it is over when pi's agent loop is, which shows as an
// assistant message that calls no tool, or one that failed and stayed failed.
// pi takes a failed attempt back before retrying it (and a cut-off reply
// before recovering it) with a context_edit naming it, written ahead of the
// retry's backoff and of the recovery's compaction (pi 0.87.1
// AgentSession._prepareRetry, _checkCompaction) — so a failure the file still
// ends on a poll later is the turn's verdict.

const PI_TURN_PARSER_NAME = 'pi-session-jsonl-turn'
const PI_TURN_PARSER_VERSION = '1'

// A turn anchored much earlier than the adopted message is a previous turn
// with the same prompt (this one died before pi wrote its own): the guard
// codex and gemini-cli recovery use.
const TURN_ANCHOR_MAX_AGE_BEFORE_MESSAGE_MS = 5 * 60 * 1000

export type PiTurnVerdict =
    | { outcome: 'failed'; detail: string }
    | {
          outcome: 'result_lost'
          events: EmittedChatEvent[]
          lastSourceSeq: number
          detail: string
      }
    | {
          outcome: 'turn_failed'
          events: EmittedChatEvent[]
          lastSourceSeq: number
          // pi's last word on the attempt that ended the turn; null for an
          // abort, which is the process being stopped rather than a verdict.
          errorMessage: string | null
      }
    | {
          outcome: 'recovered'
          events: EmittedChatEvent[]
          usage: ChatUsage
          lastSourceSeq: number
          recoveredLines: number
      }

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null

const str = (v: unknown): string | null =>
    typeof v === 'string' && v.length > 0 ? v : null

const messageOf = (entry: PiEntry): Record<string, unknown> | null =>
    entry.type === 'message' && isRecord(entry.message) ? entry.message : null

const userText = (content: unknown): string => {
    if (typeof content === 'string') return content
    if (!Array.isArray(content)) return ''
    return content
        .map((block) =>
            isRecord(block) &&
            block.type === 'text' &&
            typeof block.text === 'string'
                ? block.text
                : ''
        )
        .filter(Boolean)
        .join('\n')
}

// The prompt as the adapter sent it: verbatim on a resumed session, or closing
// the fork transcript a fresh session is given.
const isTurnPrompt = (text: string, promptText: string): boolean => {
    const sent = text.trim()
    const prompt = promptText.trim()
    return (
        sent === prompt ||
        sent.endsWith(
            `<latest_user_message>\n${prompt}\n</latest_user_message>`
        )
    )
}

const entryMs = (entry: PiEntry, message: Record<string, unknown>): number =>
    typeof message.timestamp === 'number' && Number.isFinite(message.timestamp)
        ? message.timestamp
        : typeof entry.timestamp === 'string'
          ? Date.parse(entry.timestamp)
          : Number.NaN

// What the live stream showed for each message of the turn, in its shapes:
// an assistant message's thinking and text (a failed attempt's text is
// followed by a paragraph break, as the adapter sets the retry apart), its
// tool calls, then each tool's result.
const turnEvents = (
    turn: PiPathEntry[],
    lines: string[],
    sourceRef: string,
    sourceFile: string
): Array<{ lineNo: number; events: EmittedChatEvent[] }> => {
    const out: Array<{ lineNo: number; events: EmittedChatEvent[] }> = []
    let separateNextText = false
    for (const { entry, lineNo } of turn) {
        const message = messageOf(entry)
        if (message?.role !== 'assistant' && message?.role !== 'toolResult')
            continue
        const events: EmittedChatEvent[] = [
            {
                type: 'raw_source',
                source: {
                    sourceRef,
                    sourceFile,
                    sourceSeq: lineNo,
                    externalId: String(entry.id),
                    parentExternalId: str(entry.parentId),
                    rawFormat: 'jsonl',
                    rawText: lines[lineNo - 1].replace(/\r$/, ''),
                    parserName: PI_TURN_PARSER_NAME,
                    parserVersion: PI_TURN_PARSER_VERSION
                }
            }
        ]
        if (message.role === 'toolResult') {
            if (typeof message.toolCallId !== 'string') continue
            events.push({
                type: 'tool_result',
                toolCallId: message.toolCallId,
                result: {
                    content: message.content ?? null,
                    details: message.details ?? null,
                    isError: message.isError === true
                }
            })
            out.push({ lineNo, events })
            continue
        }
        let text = ''
        const blocks = Array.isArray(message.content) ? message.content : []
        for (const block of blocks) {
            if (!isRecord(block)) continue
            if (
                block.type === 'thinking' &&
                typeof block.thinking === 'string' &&
                block.thinking &&
                block.redacted !== true
            )
                events.push({ type: 'thinking', text: block.thinking })
            else if (
                block.type === 'text' &&
                typeof block.text === 'string' &&
                block.text
            ) {
                if (separateNextText) {
                    separateNextText = false
                    events.push({ type: 'token', text: '\n\n' })
                }
                text += block.text
                events.push({ type: 'token', text: block.text })
            } else if (
                block.type === 'toolCall' &&
                typeof block.id === 'string'
            )
                events.push({
                    type: 'tool_call',
                    toolCallId: block.id,
                    toolName: str(block.name) ?? 'tool',
                    args: block.arguments ?? null
                })
        }
        const stopReason = str(message.stopReason)
        if ((stopReason === 'error' || stopReason === 'aborted') && text)
            separateNextText = true
        out.push({ lineNo, events })
    }
    return out
}

export const recoverTurnFromPiSession = async (args: {
    fs: RecoveryFs
    frameworkSessionRef: string
    workspacePath: string | null
    promptText: string
    model: string | null
    messageCreatedAt?: Date
    // Lines a settled turn (or a sync) already accounted for — the session's
    // runtime-sync cursor. This turn's prompt lies past them, so a repeated
    // prompt cannot anchor on the turn before it.
    settledLines: number | null
    // Emit only what lies past this line: the caller's cursor across polls.
    sinceLine: number
    // How far the previous poll read. An ending pi may still take back — a
    // failed attempt it retries, a cut-off reply it recovers — stands once
    // the file has not grown since then.
    previousLineCount: number | null
}): Promise<PiTurnVerdict> => {
    try {
        const sourceFile = await args.fs.locate(
            piSessionLocateScript(args.frameworkSessionRef, args.workspacePath)
        )
        if (!sourceFile)
            return { outcome: 'failed', detail: 'session file not found' }
        const text = await args.fs.readFile(sourceFile)
        if (text === null)
            return { outcome: 'failed', detail: `read failed: ${sourceFile}` }

        // Newline-terminated lines only: a line pi is still writing waits for
        // the next poll, and this count is the unit of the session's
        // runtime-sync cursor (`wc -l`).
        const lineCount = (text.match(/\n/g) ?? []).length
        const { path, lines } = piSessionPath(text, args.frameworkSessionRef)
        const complete = path.filter((node) => node.lineNo <= lineCount)

        let anchor = -1
        let anchorMs = Number.NaN
        for (let i = complete.length - 1; i >= 0; i--) {
            if (complete[i].lineNo <= (args.settledLines ?? 0)) break
            const message = messageOf(complete[i].entry)
            if (
                message?.role === 'user' &&
                isTurnPrompt(userText(message.content), args.promptText)
            ) {
                anchor = i
                anchorMs = entryMs(complete[i].entry, message)
                break
            }
        }
        if (anchor === -1)
            return {
                outcome: 'result_lost',
                events: [],
                lastSourceSeq: lineCount,
                detail: 'prompt not found in session'
            }
        if (
            args.messageCreatedAt &&
            Number.isFinite(anchorMs) &&
            anchorMs <
                args.messageCreatedAt.getTime() -
                    TURN_ANCHOR_MAX_AGE_BEFORE_MESSAGE_MS
        )
            return {
                outcome: 'result_lost',
                events: [],
                lastSourceSeq: lineCount,
                detail: 'anchored user message predates this message'
            }

        const turn = complete.slice(anchor + 1)
        const perMessage = turnEvents(
            turn,
            lines,
            args.frameworkSessionRef,
            sourceFile
        )
        const events = perMessage
            .filter((m) => m.lineNo > args.sinceLine)
            .flatMap((m) => m.events)
        const pending = (detail: string): PiTurnVerdict => ({
            outcome: 'result_lost',
            events,
            lastSourceSeq: lineCount,
            detail
        })

        let lastIndex = -1
        for (let i = turn.length - 1; i >= 0 && lastIndex === -1; i--)
            if (messageOf(turn[i].entry)?.role === 'assistant') lastIndex = i
        if (lastIndex === -1) return pending('no assistant message yet')
        const lastEntry = turn[lastIndex].entry
        const lastMessage = messageOf(lastEntry) ?? {}
        const stopReason = str(lastMessage.stopReason)
        // A context_edit naming the ending takes it back: a retry or a
        // recovery is under way. Anything else after it is pi's bookkeeping.
        const takenBack = turn
            .slice(lastIndex + 1)
            .some(
                ({ entry }) =>
                    entry.type === 'context_edit' &&
                    entry.targetId === lastEntry.id
            )
        if (takenBack) return pending(`pi took back its ${stopReason} ending`)
        const settled = args.previousLineCount === lineCount
        if (stopReason === 'aborted')
            return {
                outcome: 'turn_failed',
                events,
                lastSourceSeq: lineCount,
                errorMessage: null
            }
        if (stopReason === 'error') {
            if (!settled) return pending('waiting on pi to retry the error')
            return {
                outcome: 'turn_failed',
                events,
                lastSourceSeq: lineCount,
                errorMessage:
                    str(lastMessage.errorMessage) ?? 'pi reported a model error'
            }
        }
        if (stopReason === 'length' && !settled)
            return pending('waiting on pi to recover a cut-off reply')
        if (stopReason !== 'stop' && stopReason !== 'length')
            return pending(`turn not terminal (${stopReason ?? 'no stop'})`)

        // What agent_end, compaction_end and the usage entries add up to on
        // the live stream: every assistant attempt, and the side calls.
        let totals = emptyPiUsageTotals()
        for (const { entry } of turn) {
            const message = messageOf(entry)
            if (message?.role === 'assistant')
                totals = addPiUsage(totals, message.usage)
            else if (entry.type === 'usage' || entry.type === 'compaction')
                totals = addPiUsage(totals, entry.usage)
        }
        return {
            outcome: 'recovered',
            events,
            usage: {
                model: str(lastMessage.model) ?? args.model,
                inputTokens: totals.inputTokens,
                outputTokens: totals.outputTokens,
                cacheReadTokens: totals.cacheReadTokens,
                cacheCreationTokens: totals.cacheCreationTokens,
                costUsd: null,
                costSource: 'unknown',
                firstTokenMs: null,
                totalMs: null
            },
            lastSourceSeq: lineCount,
            recoveredLines: perMessage.length
        }
    } catch (err) {
        return {
            outcome: 'failed',
            detail: err instanceof Error ? err.message : String(err)
        }
    }
}
