import type { DaemonOpenclawTurnPayload, DaemonTurnFinalPayload } from '@manyfold/shared'
import type { RpcContext } from './ws-client'
import { ExecStream, execStreams } from './exec-buffer'
import type { TurnAck } from './acp-turn'

// The openclaw half of turn.start. An openclaw gateway CANCELS a run when the
// SSE socket that requested it closes — so the socket must be held by a
// process that outlives the API. This daemon POSTs the prepared
// /v1/chat/completions request itself and journals each SSE `data:` payload
// to the exec buffer as ONE LINE PER FRAME, which is what makes the replayed
// stream immune to chunk boundaries when the API decodes it.
//
// The daemon is transport, not semantics: it does not interpret the deltas.
// The one protocol fact it owns is COMPLETION — `[DONE]` (or an inline
// `{"error":...}` frame, which openclaw uses for upstream failures) is the
// only evidence the gateway finished the stream, and only that writes a
// `stopReason` into the final. A stream that just stops yields no stopReason,
// so a restarted API can never mistake a half-answer for a finished one.

const DEFAULT_TURN_TIMEOUT_MS = 240_000

// #513: a single absolute timer over the whole turn killed streams that were
// still producing events and reported them as stalls. Headers, silence and
// total duration are three different failures with three different budgets;
// only the idle one restarts on activity. `timeoutMs` remains the fallback so
// an API that predates the split keeps the old single-budget behaviour.
type OpenclawTurnTimeoutKind = 'headers' | 'stream_idle' | 'max_duration'

export const runOpenclawTurn = (args: {
    payload: DaemonOpenclawTurnPayload
    ctx: RpcContext
    registerChild: () => void
    releaseChild: () => void
}): Promise<TurnAck> => {
    const { payload, ctx } = args
    const stream = new ExecStream({
        refId: ctx.refId,
        method: 'turn.start',
        // token stays out of meta.json; nothing reads it back from the buffer.
        payload: { framework: payload.framework, url: payload.url }
    })
    execStreams.set(ctx.refId, stream)
    args.registerChild()

    const legacyTimeoutMs = payload.timeoutMs ?? DEFAULT_TURN_TIMEOUT_MS
    const headersTimeoutMs = payload.headersTimeoutMs ?? legacyTimeoutMs
    const idleTimeoutMs = payload.idleTimeoutMs ?? legacyTimeoutMs
    const maxDurationMs = payload.maxDurationMs ?? legacyTimeoutMs
    const abort = new AbortController()
    let cancelled = false
    let timeoutKind: OpenclawTurnTimeoutKind | null = null
    const fire = (kind: OpenclawTurnTimeoutKind): void => {
        if (timeoutKind === null) timeoutKind = kind
        abort.abort()
    }
    ctx.onCancel(() => {
        cancelled = true
        abort.abort()
    })
    const headersTimer = setTimeout(() => fire('headers'), headersTimeoutMs)
    const maxTimer = setTimeout(() => fire('max_duration'), maxDurationMs)
    headersTimer.unref?.()
    maxTimer.unref?.()
    let idleTimer: ReturnType<typeof setTimeout> | null = null
    const touch = (): void => {
        if (idleTimer) clearTimeout(idleTimer)
        idleTimer = setTimeout(() => fire('stream_idle'), idleTimeoutMs)
        idleTimer.unref?.()
    }
    const clearTimers = (): void => {
        clearTimeout(headersTimer)
        clearTimeout(maxTimer)
        if (idleTimer) clearTimeout(idleTimer)
    }

    const safePublish = (data: string): void => {
        if (stream.status !== 'running') return
        try {
            stream.publish('stdout', data)
        } catch (err) {
            // publish() already completed the stream as crashed; stop the
            // upstream so the gateway is not generating into a log nobody
            // can read.
            abort.abort()
            console.error(
                `turn buffer publish failed for ${ctx.refId}: ${(err as Error).message}`
            )
        }
    }

    const drive = async (): Promise<void> => {
        let sawDone = false
        let inlineError: string | null = null
        try {
            const res = await fetch(payload.url, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    accept: 'text/event-stream',
                    ...(payload.token
                        ? { authorization: `Bearer ${payload.token}` }
                        : {})
                },
                body: JSON.stringify(payload.body),
                signal: abort.signal
            })
            clearTimeout(headersTimer)
            touch()
            if (!res.ok || !res.body) {
                const text = await res.text().catch(() => '')
                stream.complete(
                    {
                        ok: false,
                        payload: { stopReason: null, sessionId: null },
                        error: `openclaw gateway ${res.status} ${res.statusText}: ${text.slice(0, 512)}`
                    },
                    'completed'
                )
                return
            }
            const decoder = new TextDecoder()
            let buf = ''
            const handleFrame = (frame: string): void => {
                const dataLines: string[] = []
                for (const line of frame.split('\n'))
                    if (line.startsWith('data:'))
                        dataLines.push(line.slice(5).trim())
                const body = dataLines.join('\n').trim()
                if (!body) return
                if (body === '[DONE]') {
                    sawDone = true
                    return
                }
                // Buffer first: completion is only written after the frame
                // that proved it is durable.
                safePublish(`${body}\n`)
                if (!inlineError && body.startsWith('{') && body.includes('"error"')) {
                    try {
                        const parsed = JSON.parse(body) as {
                            error?: { message?: string }
                        }
                        if (parsed.error)
                            inlineError =
                                parsed.error.message ??
                                'upstream error (no message)'
                    } catch {}
                }
            }
            const reader = res.body.getReader()
            for (;;) {
                const { value, done } = await reader.read()
                if (done) break
                touch()
                buf += decoder.decode(value, { stream: true })
                let boundary = buf.indexOf('\n\n')
                while (boundary !== -1) {
                    handleFrame(buf.slice(0, boundary))
                    buf = buf.slice(boundary + 2)
                    boundary = buf.indexOf('\n\n')
                }
                if (sawDone) break
            }
            if (buf.trim()) handleFrame(buf)
            if (sawDone || inlineError) {
                // Both are protocol-terminal: the gateway finished the stream
                // on purpose. An inline error is still ok:true transport-wise —
                // the API reads the error frame from the buffer and surfaces
                // it; the stopReason only says "nothing more will ever come".
                const final: DaemonTurnFinalPayload = {
                    stopReason: inlineError ? 'error' : 'done',
                    sessionId: null
                }
                stream.complete(
                    {
                        ok: true,
                        payload: final as unknown as Record<string, unknown>
                    },
                    'completed'
                )
                return
            }
            stream.complete(
                {
                    ok: false,
                    payload: { stopReason: null, sessionId: null },
                    error: 'openclaw stream ended without [DONE]'
                },
                'completed'
            )
        } catch (err) {
            const message = cancelled
                ? 'cancelled'
                : timeoutKind === 'headers'
                  ? `openclaw gateway returned no response headers within ${headersTimeoutMs}ms`
                  : timeoutKind === 'stream_idle'
                    ? `openclaw stream went silent for ${idleTimeoutMs}ms`
                    : timeoutKind === 'max_duration'
                      ? `openclaw turn was still streaming when it hit its ${maxDurationMs}ms maximum duration`
                      : (err as Error).message
            stream.complete(
                {
                    ok: false,
                    payload: { stopReason: null, sessionId: null },
                    error: message
                },
                cancelled ? 'aborted' : 'completed'
            )
        } finally {
            clearTimers()
            args.releaseChild()
        }
    }

    return new Promise((resolveAck) => {
        let settled = false
        stream.subscribe((kind, data, seq) => {
            if (kind === '__done__') {
                if (settled) return
                settled = true
                try {
                    resolveAck(JSON.parse(data) as TurnAck)
                } catch {
                    resolveAck({ ok: false, error: 'invalid final payload' })
                }
                return
            }
            ctx.sendEvent(kind, data, seq)
        }, 0)
        void drive()
    })
}
