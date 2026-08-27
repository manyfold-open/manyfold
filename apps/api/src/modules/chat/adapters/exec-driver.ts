export interface ExecStreamRequest {
    cmd: string[]
    env?: Record<string, string>
    stdin?: string
    dir?: string
    timeoutMs: number
    keepAliveMs?: number
    livenessTimeoutMs?: number
    execHandle?: string
    // Codex per-agent skills: run the final exec with HOME set to this dir (the
    // agent's workspace) so codex's USER skill scope `$HOME/.agents/skills`
    // resolves per-agent, while CODEX_HOME stays the real `~/.codex`
    // (config/auth/sessions). Honored by the sprite driver and by the daemon
    // driver (a runner turn runs on that same sprite); ignored by k8s.
    codexHome?: string
    // Sprite driver only: forwarded to the SDK's onSessionId so the exec
    // session id can be persisted for cross-instance adoption.
    onExecSession?: (execSessionId: string) => void
}

export interface ExecStreamResult {
    exitCode: number
    stdout: string
    stderr: string
}

export interface ExecStreamHandle {
    stdout: AsyncIterable<string>
    stderr: AsyncIterable<string>
    result: Promise<ExecStreamResult>
    abort(): void
    // Transport sequence of the last chunk the consumer has DEQUEUED (not
    // merely received), for transports that sequence their stream. Read right
    // after a chunk yields a complete raw line: that seq is how far a resume
    // may skip. Undefined on transports without sequencing (sprite exec).
    lastDeliveredSeq?(): number
}

// Every driver must pass its handle's `result` through this before handing the
// handle out.
//
// `result` is deliberately not awaited by the caller for a long time: adapters
// drain stdout to completion first, and the turn pipeline persists each event,
// so the generator parks on `yield` across macrotasks. An exec that fails at
// DISPATCH rejects before any of that — and Node reports a promise still
// unhandled at the end of an event-loop turn. apps/api routes
// unhandledRejection into handleFatal -> process.exit(1), so one such handle
// takes down the instance and every turn running on it.
//
// Seen on staging 2026-08-03, twice in one day: `exec.resume` was acked with
// `daemon process crashed` (the daemon had restarted with buffer meta still on
// disk, so its hello kept advertising a stream it could no longer serve), and
// the api died with `reason=unhandled_rejection`, dropping six in-flight turns
// each time. It is a race, not a certainty — a consumer that drains without
// pausing attaches its handler in time, which is why the same ack was survivable
// earlier the same morning.
//
// This marks the promise observed WITHOUT consuming the rejection: the same
// promise is returned, so whoever awaits it still gets the error. Swallowing it
// instead would turn a failed exec into a turn that waits forever.
export const observedResult = <T>(result: Promise<T>): Promise<T> => {
    void result.catch(() => undefined)
    return result
}

export interface ExecResumeRequest {
    refId: string
    fromSeq: number
    timeoutMs: number
}

// Interactive stdio for client-driven protocols (ACP): the caller writes
// frames after start and decides when input ends. No resume — an open stdin
// means the conversation lives in this process, so these handles are
// non-resumable by construction.
export interface InteractiveExecRequest {
    cmd: string[]
    env?: Record<string, string>
    dir?: string
    timeoutMs: number
    onExecSession?: (execSessionId: string) => void
}

export interface InteractiveExecHandle {
    stdout: AsyncIterable<string>
    stderr: AsyncIterable<string>
    // Enqueue a stdin frame; write failures surface via `result` rejecting.
    write(data: Buffer): void
    // Graceful EOF — a stdio JSON-RPC server exits on it.
    endInput(): void
    result: Promise<ExecStreamResult>
    // Hard teardown: kill the remote child and close the transport.
    abort(): void
}

export interface ExecDriver {
    stream(req: ExecStreamRequest): ExecStreamHandle
    resumeStream?(req: ExecResumeRequest): ExecStreamHandle
    streamInteractive?(req: InteractiveExecRequest): InteractiveExecHandle
}
