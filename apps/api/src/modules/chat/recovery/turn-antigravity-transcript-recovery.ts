import type { ChatUsage } from '@manyfold/shared'
import type { EmittedChatEvent } from '@/modules/chat/chat-adapter'
import type { RecoveryFs } from '@/modules/chat/recovery/recovery-fs'
import {
    antigravityTranscriptLocateScript,
    antigravityUserRequest,
    type AgyRecord
} from '@/modules/chat/recovery/readers/antigravity-cli-reader'

// Recover an adopted agy turn from its conversation log. agy appends a record
// per finished step — the prompt, each planner step, each tool result — so
// the turn comes back one step at a time, its tool calls under the ids the
// live stream gave the same steps (`agy-<step index>`). A planner step that
// says something and calls nothing is the turn's end. The log carries no
// token counts, so a recovered turn has no usage to bill, and a turn that
// stops on a failed model call is left to the caller's stall and liveness
// checks: agy retries such a call for minutes, logging each attempt, and the
// log shows no difference between a retry to come and a final give-up.

const AGY_TURN_PARSER_NAME = 'antigravity-cli-transcript-turn'
const AGY_TURN_PARSER_VERSION = '1'

// A turn anchored much earlier than the adopted message is a previous turn
// with the same prompt (this one died before agy wrote its own): the guard
// the other transcript recoveries use.
const TURN_ANCHOR_MAX_AGE_BEFORE_MESSAGE_MS = 5 * 60 * 1000

export type AntigravityTurnVerdict =
    | { outcome: 'failed'; detail: string }
    | {
          outcome: 'result_lost'
          events: EmittedChatEvent[]
          lastSourceSeq: number
          detail: string
      }
    | {
          outcome: 'recovered'
          events: EmittedChatEvent[]
          usage: ChatUsage | null
          lastSourceSeq: number
          recoveredLines: number
      }

interface CompleteRecord {
    record: AgyRecord
    lineNo: number
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
    typeof v === 'object' && v !== null && !Array.isArray(v)

// The prompt as the adapter sent it: verbatim on a resumed conversation, or
// closing the fork transcript a fresh one is given.
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

const isToolStep = (record: AgyRecord): boolean =>
    record.source === 'MODEL' && record.type !== 'PLANNER_RESPONSE'

const hasCalls = (record: AgyRecord): boolean =>
    Array.isArray(record.tool_calls) && record.tool_calls.length > 0

const contentOf = (record: AgyRecord): string =>
    typeof record.content === 'string' ? record.content : ''

// What the live stream showed for each step, in its shapes: a planner step's
// text as agy streamed it — with the newline agy closes every reply with —
// and its tool calls, then each tool's result. The reasoning agy logs never
// reached the stream, so it stays out here too.
const turnEvents = (
    turn: CompleteRecord[],
    lines: string[],
    sourceRef: string,
    sourceFile: string
): Array<{ lineNo: number; events: EmittedChatEvent[] }> => {
    const out: Array<{ lineNo: number; events: EmittedChatEvent[] }> = []
    const pendingCalls: Array<{ name: string; args: unknown }> = []
    for (const { record, lineNo } of turn) {
        const planner = record.type === 'PLANNER_RESPONSE'
        if (!planner && !isToolStep(record)) continue
        const stepIndex =
            typeof record.step_index === 'number' ? record.step_index : lineNo
        const events: EmittedChatEvent[] = [
            {
                type: 'raw_source',
                source: {
                    sourceRef,
                    sourceFile,
                    sourceSeq: lineNo,
                    externalId: `agy-step-${stepIndex}`,
                    parentExternalId: null,
                    rawFormat: 'jsonl',
                    rawText: lines[lineNo - 1].replace(/\r$/, ''),
                    parserName: AGY_TURN_PARSER_NAME,
                    parserVersion: AGY_TURN_PARSER_VERSION
                }
            }
        ]
        if (planner) {
            const content = contentOf(record)
            if (content)
                events.push({
                    type: 'token',
                    text: content.endsWith('\n') ? content : `${content}\n`
                })
            if (Array.isArray(record.tool_calls))
                for (const call of record.tool_calls)
                    if (isRecord(call))
                        pendingCalls.push({
                            name:
                                typeof call.name === 'string'
                                    ? call.name
                                    : 'tool',
                            args: call.args ?? null
                        })
            out.push({ lineNo, events })
            continue
        }
        // agy streams a tool step's call when it starts and its result when
        // it is done, both under the tool step's own index.
        const call = pendingCalls.shift()
        const toolCallId = `agy-${stepIndex}`
        const failed =
            record.status === 'ERROR' ||
            (typeof record.error === 'string' && record.error.length > 0)
        events.push(
            {
                type: 'tool_call',
                toolCallId,
                toolName:
                    call?.name ??
                    (typeof record.type === 'string'
                        ? record.type.toLowerCase()
                        : 'tool'),
                args: call?.args ?? null
            },
            {
                type: 'tool_result',
                toolCallId,
                result: {
                    content: record.content ?? null,
                    details: failed ? { error: record.error ?? null } : null,
                    isError: failed
                }
            }
        )
        out.push({ lineNo, events })
    }
    return out
}

export const recoverTurnFromAntigravityTranscript = async (args: {
    fs: RecoveryFs
    frameworkSessionRef: string
    promptText: string
    messageCreatedAt?: Date
    // Lines a settled turn (or a sync) already accounted for — the session's
    // runtime-sync cursor. This turn's prompt lies past them, so a repeated
    // prompt cannot anchor on the turn before it.
    settledLines: number | null
    // Emit only what lies past this line: the caller's cursor across polls.
    sinceLine: number
}): Promise<AntigravityTurnVerdict> => {
    try {
        const sourceFile = await args.fs.locate(
            antigravityTranscriptLocateScript(args.frameworkSessionRef)
        )
        if (!sourceFile)
            return { outcome: 'failed', detail: 'transcript not found' }
        const text = await args.fs.readFile(sourceFile)
        if (text === null)
            return { outcome: 'failed', detail: `read failed: ${sourceFile}` }

        // Newline-terminated lines only: a line agy is still writing waits
        // for the next poll, and this count is the unit of the session's
        // runtime-sync cursor (`wc -l`).
        const lineCount = (text.match(/\n/g) ?? []).length
        const lines = text.split('\n')
        const complete: CompleteRecord[] = []
        for (let i = 0; i < lineCount; i++) {
            try {
                const parsed: unknown = JSON.parse(lines[i])
                if (isRecord(parsed))
                    complete.push({
                        record: parsed as AgyRecord,
                        lineNo: i + 1
                    })
            } catch {
                // A line that does not parse is no step of this turn.
            }
        }

        let anchor = -1
        for (let i = complete.length - 1; i >= 0; i--) {
            if (complete[i].lineNo <= (args.settledLines ?? 0)) break
            const { record } = complete[i]
            if (record.type !== 'USER_INPUT') continue
            const request = antigravityUserRequest(record.content)
            if (request && isTurnPrompt(request, args.promptText)) {
                anchor = i
                break
            }
        }
        if (anchor === -1)
            return {
                outcome: 'result_lost',
                events: [],
                lastSourceSeq: lineCount,
                detail: 'prompt not found in transcript'
            }
        const createdAt = complete[anchor].record.created_at
        const anchorMs =
            typeof createdAt === 'string' ? Date.parse(createdAt) : Number.NaN
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
                detail: 'anchored prompt predates this message'
            }

        // A later prompt ends the turn whatever its last step was: agy moved
        // on to another (a terminal continuing the conversation), which the
        // runtime-session sync brings in, not this adoption.
        const next = complete.findIndex(
            ({ record }, i) => i > anchor && record.type === 'USER_INPUT'
        )
        const turn = complete.slice(anchor + 1, next === -1 ? undefined : next)
        const turnEnd = next === -1 ? lineCount : complete[next].lineNo - 1
        const perStep = turnEvents(
            turn,
            lines,
            args.frameworkSessionRef,
            sourceFile
        )
        const events = perStep
            .filter((step) => step.lineNo > args.sinceLine)
            .flatMap((step) => step.events)
        const last = [...turn]
            .reverse()
            .find(
                ({ record }) =>
                    record.type === 'PLANNER_RESPONSE' ||
                    record.type === 'ERROR_MESSAGE' ||
                    isToolStep(record)
            )?.record
        const ended =
            next !== -1 ||
            (last?.type === 'PLANNER_RESPONSE' &&
                !hasCalls(last) &&
                contentOf(last).length > 0)
        if (!ended)
            return {
                outcome: 'result_lost',
                events,
                lastSourceSeq: lineCount,
                detail:
                    last?.type === 'ERROR_MESSAGE'
                        ? 'last model call failed; agy may retry it'
                        : 'turn not finished'
            }
        return {
            outcome: 'recovered',
            events,
            usage: null,
            lastSourceSeq: turnEnd,
            recoveredLines: perStep.length
        }
    } catch (err) {
        return {
            outcome: 'failed',
            detail: err instanceof Error ? err.message : String(err)
        }
    }
}
