import { Injectable, Logger } from '@nestjs/common'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import {
    DaemonRegistryService,
    DaemonRpcResponseError,
    type StreamRpcCallbacks
} from '@/modules/daemon/daemon-registry.service'

// #619: a fresh turn can be dispatched onto a websocket generation that is
// already dead. The canonical shape: the turn's own awake-hold thaws a
// suspended sprite, the thawed daemon abandons its frozen socket and re-dials,
// register() closes the old generation and fails its pending rpcs with
// `connection replaced` — killing the dispatch that went out ~1.4s earlier.
// The turn then suspended and waited out the unmatched-turn age gate plus the
// execution lease (#517/#519) before converging ~95s later as a retryable
// `server_restart` the user had to notice and retry.
//
// This wrapper recovers that loss at the transport seam, framework-neutrally,
// within seconds. The safety argument rests on positive evidence from the
// CURRENT generation, never on guessing from the absence of output:
//
//   - The daemon runs a strict single-socket loop (apps/cli ws-client.ts):
//     it dials a new connection only after its old socket has closed, and
//     exec.start registers the stream synchronously on receipt. So once a new
//     generation is live, an `exec.resume` probe against it is authoritative:
//     `no buffer for refId` PROVES the lost dispatch never reached the daemon
//     and never can (both ends of its socket are closed) — re-dispatching the
//     identical payload cannot double-execute anything.
//   - If the probe finds the stream instead, the dispatch DID arrive: the
//     probe itself is the replacement carrier, replaying from seq 0 into a
//     consumer that has taken nothing — exactly-once by construction.
//
// A turn that has delivered ANY event stays on the suspend → hello-resume
// path untouched: mid-stream replacement semantics are owned by the resume
// machinery, not by this wrapper.
//
// Cross-instance care: when the daemon's socket lives on a peer api instance,
// that peer's hello-matched resume has no way to see the adapter still
// running HERE (runningAdapters is per-process), so attaching a probe as a
// carrier could double-consume the stream. A remote recovery therefore acts
// ONLY on the `no buffer` proof (where the hello was necessarily unmatched
// and nothing else owns the turn) and otherwise yields to the owner by
// surfacing the original transport error, i.e. today's suspend path.

const RECOVERY_BUDGET_MS = 15_000
const RECOVERY_RETRY_DELAY_MS = 500
// A remote probe cannot linger: past this it stops being a proof lookup and
// starts being a second consumer racing the owner instance's resume.
const REMOTE_PROBE_TIMEOUT_MS = 3_000

const errorMessage = (error: unknown): string =>
    error instanceof Error ? error.message : String(error)

const isConnectionReplaced = (error: unknown): boolean =>
    errorMessage(error).toLowerCase().includes('connection replaced')

// The registry's connection-lifecycle rejections for which a zero-frame turn
// may still be recoverable on the current generation. Deliberately excludes
// `daemon rpc broker shutting down` (THIS process is dying — the shutdown
// drain owns that turn) and anything a live daemon answered.
const isFreshRecoverableTransportError = (error: unknown): boolean => {
    if (error instanceof DaemonRpcResponseError) return false
    const m = errorMessage(error).toLowerCase()
    return (
        m.includes('connection replaced') ||
        m.includes('connection closed') ||
        m.includes('is not connected') ||
        m.includes('is offline; no active websocket') ||
        m.includes('websocket lease is stale')
    )
}

// execResume's authoritative "this daemon holds no stream for that ref".
const isNoBufferForRef = (error: unknown): boolean =>
    /no buffer for refid/i.test(errorMessage(error))

// Lookup-time failures thrown before any frame went on the wire: the probe
// reached no daemon, so no stream owner can be racing this side yet and the
// probe may simply be retried once the daemon finishes reconnecting.
const isProbeNeverReachedDaemon = (error: unknown): boolean => {
    if (error instanceof DaemonRpcResponseError) return false
    const m = errorMessage(error).toLowerCase()
    return (
        m.includes('is not connected') ||
        m.includes('is offline; no active websocket') ||
        m.includes('websocket lease is stale')
    )
}

const isInconclusiveProbeResponse = (error: Error): boolean =>
    /daemon process crashed|not_implemented:\s*exec\.resume|no rpc handler registered/i.test(
        error.message
    )

const cancelledError = (): Error => new Error('cancelled')

export interface FencedTurnDispatchArgs {
    daemonId: string
    method: 'exec.start' | 'turn.start'
    payload: Record<string, unknown>
    timeoutMs: number
    // The stable exec ref (messageId) the dispatch is pinned to — what the
    // probe looks up and what the re-dispatch re-pins, keeping the turn's
    // (daemon_id, daemon_exec_ref) bookkeeping true across attempts.
    refId: string
    onEvent: StreamRpcCallbacks['onEvent']
}

interface PendingAttempt {
    result: Promise<Record<string, unknown> | undefined>
    cancel: () => void
}

interface DispatchState {
    cancelled: boolean
    eventsDelivered: number
    dispatches: number
    probes: number
    current: PendingAttempt | null
}

@Injectable()
export class DaemonFencedDispatchService {
    private readonly logger = new Logger(DaemonFencedDispatchService.name)

    constructor(
        private readonly registry: DaemonRegistryService,
        private readonly telemetry: TelemetryService
    ) {}

    // Overridable in tests, which cannot wait out real recovery delays.
    protected delay(ms: number): Promise<void> {
        return new Promise((resolve) => setTimeout(resolve, ms))
    }

    // Same reason: the give-up deadline is wall-clock.
    protected recoveryBudgetMs(): number {
        return RECOVERY_BUDGET_MS
    }

    streamTurnRpc(args: FencedTurnDispatchArgs): {
        refId: string
        result: Promise<Record<string, unknown> | undefined>
        cancel: () => void
    } {
        const state: DispatchState = {
            cancelled: false,
            eventsDelivered: 0,
            dispatches: 0,
            probes: 0,
            current: null
        }
        return {
            refId: args.refId,
            result: this.drive(args, state),
            cancel: () => {
                state.cancelled = true
                state.current?.cancel()
            }
        }
    }

    private async drive(
        args: FencedTurnDispatchArgs,
        state: DispatchState
    ): Promise<Record<string, unknown> | undefined> {
        const forward: StreamRpcCallbacks['onEvent'] = (kind, data, seq) => {
            state.eventsDelivered += 1
            args.onEvent?.(kind, data, seq)
        }
        const dispatchedGeneration = this.registry.localConnectionGeneration(
            args.daemonId
        )
        let firstError: Error | null = null
        let firstErrorAt = 0
        let deadline: number | null = null
        let mode: 'dispatch' | 'probe-local' | 'probe-remote' = 'dispatch'
        let pending = this.dispatch(args, state, forward)
        for (;;) {
            let payload: Record<string, unknown> | undefined
            try {
                payload = await pending.result
            } catch (err) {
                const error =
                    err instanceof Error ? err : new Error(errorMessage(err))
                const message = error.message
                if (state.cancelled) throw cancelledError()
                if (state.eventsDelivered > 0) throw error
                firstError ??= error
                if (firstErrorAt === 0) firstErrorAt = Date.now()
                if (
                    mode === 'probe-remote' &&
                    !isNoBufferForRef(error) &&
                    !isProbeNeverReachedDaemon(error)
                ) {
                    // The stream may exist on the peer that owns the socket,
                    // and its hello-resume is (or will be) the consumer:
                    // yield with the original transport error, i.e. today's
                    // suspend path.
                    this.logger.log(
                        `fenced dispatch yielding to remote stream owner daemonId=${args.daemonId} refId=${args.refId}: ${message}`
                    )
                    throw firstError
                }
                if (mode !== 'dispatch' && isNoBufferForRef(error)) {
                    // The current generation answered authoritatively: it
                    // holds no stream for this ref, so the lost dispatch
                    // never reached the daemon — and never can, both ends of
                    // its socket being closed. Re-dispatch the identical
                    // payload on the live generation.
                    this.emitRecovery(args, state, {
                        action: 'redispatch',
                        trigger: firstError.message,
                        dispatchedGeneration,
                        sinceFirstErrorMs: Date.now() - firstErrorAt
                    })
                    mode = 'dispatch'
                    pending = this.dispatch(args, state, forward)
                    continue
                }
                if (!isFreshRecoverableTransportError(error)) {
                    if (
                        mode === 'probe-local' &&
                        error instanceof DaemonRpcResponseError &&
                        !isInconclusiveProbeResponse(error)
                    ) {
                        this.emitRecovery(args, state, {
                            action: 'resumed',
                            trigger: firstError.message,
                            dispatchedGeneration,
                            sinceFirstErrorMs: Date.now() - firstErrorAt
                        })
                        throw error
                    }
                    // A probe failure that proves nothing either way (a CLI
                    // without exec.resume, a crashed-buffer verdict) must
                    // surface the ORIGINAL transport error so the adapter's
                    // suspend classification is unchanged.
                    throw mode === 'dispatch' ? error : firstError
                }
                deadline ??= Date.now() + this.recoveryBudgetMs()
                if (Date.now() >= deadline) {
                    this.emitRecovery(args, state, {
                        action: 'gave_up',
                        trigger: firstError.message,
                        dispatchedGeneration,
                        sinceFirstErrorMs: Date.now() - firstErrorAt
                    })
                    throw firstError
                }
                // `connection replaced` means a register() has ALREADY
                // completed — the new generation is probeable right now.
                // Every other shape gives the daemon a moment to finish
                // reconnecting before the next look.
                if (!isConnectionReplaced(error) || state.probes > 0)
                    await this.delay(RECOVERY_RETRY_DELAY_MS)
                if (state.cancelled) throw cancelledError()
                if (this.registry.isOnline(args.daemonId)) {
                    mode = 'probe-local'
                    pending = this.probe(args, state, forward, args.timeoutMs)
                } else {
                    mode = 'probe-remote'
                    pending = this.probe(
                        args,
                        state,
                        () => undefined,
                        REMOTE_PROBE_TIMEOUT_MS
                    )
                }
                continue
            }
            if (mode === 'probe-remote') {
                // The stream completed on the peer that owns the socket, but
                // its events were discarded here (the owner's hello-resume is
                // the consumer). Returning the final alone would fabricate a
                // content-less `done`.
                this.logger.log(
                    `fenced dispatch yielding to remote stream owner daemonId=${args.daemonId} refId=${args.refId}: stream already complete`
                )
                throw firstError ?? new Error('connection replaced')
            }
            if (mode === 'probe-local')
                this.emitRecovery(args, state, {
                    action: 'resumed',
                    trigger: firstError?.message ?? 'unknown',
                    dispatchedGeneration,
                    sinceFirstErrorMs: Date.now() - firstErrorAt
                })
            return payload
        }
    }

    private dispatch(
        args: FencedTurnDispatchArgs,
        state: DispatchState,
        onEvent: StreamRpcCallbacks['onEvent']
    ): PendingAttempt {
        state.dispatches += 1
        const stream = this.registry.streamRpc({
            daemonId: args.daemonId,
            method: args.method,
            payload: args.payload,
            timeoutMs: args.timeoutMs,
            onEvent,
            refIdOverride: args.refId
        })
        state.current = stream
        if (state.cancelled) stream.cancel()
        return stream
    }

    // The probe is an exec.resume from seq 0 against whichever generation is
    // current. Locally it doubles as the replacement carrier (forwarding
    // onEvent, full turn budget): this process both rejected the pending rpc
    // and registered the replacement socket, and its hello-matched resume was
    // skipped because THIS adapter is still running, so nothing else consumes
    // the stream. Remotely it is a proof lookup only (discarding onEvent,
    // short deadline): the peer's hello-resume cannot see an adapter running
    // here and would double-consume, so only the `no buffer` proof may act.
    private probe(
        args: FencedTurnDispatchArgs,
        state: DispatchState,
        onEvent: StreamRpcCallbacks['onEvent'],
        timeoutMs: number
    ): PendingAttempt {
        state.probes += 1
        const probe = this.registry.streamRpc({
            daemonId: args.daemonId,
            method: 'exec.resume',
            payload: { originalRefId: args.refId, fromSeq: 0 },
            timeoutMs,
            onEvent
        })
        state.current = probe
        if (state.cancelled) probe.cancel()
        return probe
    }

    private emitRecovery(
        args: FencedTurnDispatchArgs,
        state: DispatchState,
        outcome: {
            action: 'redispatch' | 'resumed' | 'gave_up'
            trigger: string
            dispatchedGeneration: string | null
            sinceFirstErrorMs: number
        }
    ): void {
        const currentGeneration = this.registry.localConnectionGeneration(
            args.daemonId
        )
        this.logger.log(
            `fenced dispatch ${outcome.action} daemonId=${args.daemonId} refId=${args.refId} method=${args.method} trigger="${outcome.trigger}" dispatches=${state.dispatches} probes=${state.probes}`
        )
        this.telemetry.event('chat.daemon.dispatch.recovery', {
            daemonId: args.daemonId,
            refId: args.refId,
            method: args.method,
            action: outcome.action,
            trigger: outcome.trigger,
            dispatches: state.dispatches,
            probes: state.probes,
            local: currentGeneration !== null,
            dispatchedGeneration: outcome.dispatchedGeneration,
            currentGeneration,
            sinceFirstErrorMs: outcome.sinceFirstErrorMs
        })
    }
}
