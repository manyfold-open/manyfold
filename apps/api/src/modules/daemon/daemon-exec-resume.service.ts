import type { DaemonInflightStream } from '@manyfold/shared'
import {
    Inject,
    Injectable,
    Logger,
    type OnModuleDestroy
} from '@nestjs/common'
import { and, eq, getTableColumns, isNotNull, isNull, sql } from 'drizzle-orm'
import {
    agents,
    agentRuntimes,
    chatMessages,
    chatStreamEvents,
    turnExecutions,
    type ChatMessage as DbChatMessage,
    type Database
} from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import {
    DaemonRegistryService,
    type DaemonHelloEvidence
} from './daemon-registry.service'

// What a matched hello's resume did with the turn. `handled` means the resume
// path took responsibility for it (attached, terminalized, or deliberately
// left to adoption). A skipped resume leaves another carrier responsible for
// the turn, locally or on a peer, so the hello's one chance to reconcile the
// turn has to be replaced by a scheduled recheck (#648).
export type DaemonResumeOutcome =
    | 'handled'
    | 'skipped_running_locally'
    | 'skipped_owned_elsewhere'

export interface DaemonResumeHandler {
    resumeAssistantTurn(args: {
        message: DbChatMessage
        daemonId: string
        refId: string
    }): Promise<DaemonResumeOutcome>
    // In-process liveness, the same signal the resume declines on. The recheck
    // needs it as evidence: converging a turn an execution here is still
    // streaming would write a terminal over live content.
    isRunningLocally(messageId: string): boolean
    completeOfflineCancel(args: {
        message: DbChatMessage
        daemonId: string
        refId: string
    }): Promise<void>
    failUnresumable(args: {
        message: DbChatMessage
        daemonId: string
    }): Promise<void>
}

// A dispatch that is mid-flight RIGHT NOW has stamped daemonExecRef but the
// daemon may not have created the stream yet; a hello arriving inside that
// window must not read the turn as dead. Real dispatches cross the window in
// well under a second.
const UNMATCHED_TURN_MIN_AGE_MS = 60_000

// A ref the age gate skipped gets a second look shortly after it crosses the
// gate, instead of waiting for the NEXT hello — which needs another daemon
// reconnect. On staging that reconnect only came when the awake lease's 30m
// TTL let the sprite suspend, so a turn whose dispatch was rejected by
// `connection replaced` hung ~31 minutes before converging (#512).
const UNMATCHED_TURN_RECHECK_SLACK_MS = 15_000

// A live turn_executions lease defers convergence until just after it can
// have lapsed; the small slack absorbs clock skew between instances.
const UNMATCHED_LEASE_RECHECK_SLACK_MS = 5_000

// Cadence for re-deriving the verdict while the execution record says someone
// else (handoff → adoption, or a recovery in progress) may still finish the
// turn. Not a hot path: at most one timer per open unmatched turn.
const UNMATCHED_DEFER_RECHECK_MS = 60_000

// Final backstop: past this age an unmatched turn with a lapsed lease
// converges no matter what the execution record says, so a wedged handoff or
// an adoption that never claims cannot park the turn forever. Sized past the
// sprite awake TTL (~30m) + adoption claim + recovery budget.
const UNMATCHED_TURN_GIVE_UP_MS = 45 * 60_000

type UnmatchedVerdict =
    | { action: 'converge' }
    | { action: 'defer'; reason: string; recheckInMs: number }

interface MatchedResumeEvidence {
    stream: DaemonInflightStream
    message: DbChatMessage
    evidence: DaemonHelloEvidence
}

interface ActiveMatchedResume {
    evidence: DaemonHelloEvidence
    matched: MatchedResumeEvidence | null
}

interface TrackedHelloTurn {
    daemonId: string
    message: DbChatMessage
    evidence: DaemonHelloEvidence
    stream: DaemonInflightStream | null
}

interface DaemonHelloSnapshot {
    evidence: DaemonHelloEvidence
    streamsByRef: Map<string, DaemonInflightStream>
}

interface ActiveRecheck {
    supersededByMatchedHello: boolean
    evidence: DaemonHelloEvidence
    // Whether this run holds the shared per-message claim. That claim is also
    // the resume path's single-flight guard, so a matched hello cannot tell it
    // apart from a resume already in flight — it has to be told.
    claimed: boolean
    // A matched hello that found the claim held by this run. Dropping it as a
    // duplicate would lose the ref: this run yields to that same hello, so
    // both sides would return with nobody owning the turn.
    handedBack: MatchedResumeEvidence | null
}

// Why a reconcile run stopped owning the turn, and — when nothing else took
// ownership — how long until the ref has to be looked at again.
interface TerminalVeto {
    outcome: string
    recheckInMs?: number
}

interface UnmatchedTurnSnapshot {
    message: DbChatMessage
    execution: {
        runtime: 'sprites' | 'daemon' | 'k8s' | 'external'
        state: 'running' | 'handoff' | 'adopting' | 'done' | 'failed'
        leaseExpiresAt: Date
    } | null
    streamedRunnerFrames: boolean
}

@Injectable()
export class DaemonExecResumeService implements OnModuleDestroy {
    private readonly log = new Logger(DaemonExecResumeService.name)
    private handler: DaemonResumeHandler | null = null
    private readonly recheckTimers = new Map<string, NodeJS.Timeout>()
    private readonly activeRechecks = new Map<string, ActiveRecheck>()
    private readonly resuming = new Set<string>()
    private readonly matched = new Map<string, ActiveMatchedResume>()
    private readonly helloTurns = new Map<string, TrackedHelloTurn>()
    private readonly pendingOpenLookups = new Map<string, number>()
    private readonly helloSnapshots = new Map<string, DaemonHelloSnapshot>()
    private destroyed = false

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        private readonly registry: DaemonRegistryService
    ) {}

    onModuleDestroy(): void {
        this.destroyed = true
        for (const timer of this.recheckTimers.values()) clearTimeout(timer)
        this.recheckTimers.clear()
        this.helloTurns.clear()
        this.pendingOpenLookups.clear()
        this.helloSnapshots.clear()
    }

    registerHandler(handler: DaemonResumeHandler): void {
        this.handler = handler
    }

    async handleInflightStreams(
        daemonId: string,
        streams: DaemonInflightStream[],
        evidence: DaemonHelloEvidence
    ): Promise<void> {
        if (this.destroyed) return
        if (!this.registry.isCurrentHelloEvidence(daemonId, evidence)) return
        // An older lookup may not know which message owns a reported ref yet.
        // Keep the full list only for that await window; its result will reduce
        // the snapshot to entries for the affected turns.
        if ((this.pendingOpenLookups.get(daemonId) ?? 0) > 0)
            this.helloSnapshots.set(daemonId, {
                evidence,
                streamsByRef: new Map(
                    streams.map((stream) => [stream.refId, stream])
                )
            })
        // Refresh only turns already under this coordinator before the first
        // await: a rejected lookup must not erase the new hello's meaning, and
        // retaining the daemon's full historical buffer would be unbounded.
        const tracked = [...this.helloTurns.entries()].filter(
            ([, turn]) => turn.daemonId === daemonId
        )
        if (tracked.length > 0) {
            const trackedRefs = new Set(
                tracked.flatMap(([, turn]) =>
                    turn.message.daemonExecRef
                        ? [turn.message.daemonExecRef]
                        : []
                )
            )
            const reported = new Map<string, DaemonInflightStream>()
            for (const stream of streams)
                if (trackedRefs.has(stream.refId))
                    reported.set(stream.refId, stream)
            for (const [messageId, turn] of tracked) {
                const refId = turn.message.daemonExecRef
                this.helloTurns.set(messageId, {
                    ...turn,
                    evidence,
                    stream: refId ? (reported.get(refId) ?? null) : null
                })
            }
        }
        await this.repairRuntimeStatus(daemonId)
        if (
            this.destroyed ||
            !this.registry.isCurrentHelloEvidence(daemonId, evidence)
        )
            return
        const open = await this.findOpenTurns(daemonId)
        if (
            this.destroyed ||
            !this.registry.isCurrentHelloEvidence(daemonId, evidence)
        )
            return
        if (open.length === 0) return
        const reported = new Set(streams.map((s) => s.refId))
        const matched = open.filter(
            (m) => m.daemonExecRef && reported.has(m.daemonExecRef)
        )
        if (matched.length > 0)
            this.log.log(
                `daemon.resume daemonId=${daemonId} matched ${matched.length}/${streams.length} orphans`
            )
        const byRefId = new Map(matched.map((m) => [m.daemonExecRef ?? '', m]))
        // Launch every matched resume NOW, without awaiting any of them: a
        // resume promise lives until its remote stream terminalizes or
        // suspends again, which can be minutes. Awaiting them in sequence
        // head-of-line-blocked every later ref behind the earlier ones —
        // staging 2026-08-05, the second of two matched turns waited 87s
        // behind the first, the socket pong-timed out during the wait, and
        // the attach then failed into a terminal (#570). handleOne's
        // per-message single-flight guard keeps a repeated hello (or a
        // duplicate ref within one) from double-consuming a stream.
        const launched = new Set<string>()
        const resumes: Promise<void>[] = []
        for (const stream of streams) {
            const message = byRefId.get(stream.refId)
            if (!message || launched.has(message.id)) continue
            launched.add(message.id)
            resumes.push(
                this.handleOne(daemonId, stream, message, evidence).catch(
                    (err) => {
                        this.scheduleMatchedResumeRetry(
                            daemonId,
                            { stream, message, evidence },
                            UNMATCHED_DEFER_RECHECK_MS
                        )
                        this.log.error(
                            `handleOne failed messageId=${message.id} refId=${stream.refId}: ${(err as Error).message}`
                        )
                    }
                )
            )
        }
        // The hello is the daemon's authoritative list of every stream it can
        // still serve. An open turn stamped onto this daemon that is ABSENT
        // from it will never be resumed: the dispatch never reached the daemon
        // (lost to a socket replacement — hit on staging 2026-07-29, a push
        // rejected by `connection replaced` before the daemon received it) or
        // its buffer is gone. Left alone the turn hangs forever — adoption
        // defers to an online daemon indefinitely, and nothing else owns it.
        // Converge it to the same retryable terminal a restart writes — but
        // only through the SAME guarded path the scheduled recheck uses. That
        // terminal is irreversible and rests on evidence that keeps moving
        // (a matched hello, a local carrier, the durable record), so a second
        // implementation of it here would inevitably guard less: this branch
        // used to converge on a durable verdict alone and could write
        // `server_restart` over a stream this process was still consuming
        // (#728, #518).
        const now = Date.now()
        const unmatched = open.filter(
            (m) => m.daemonExecRef && !reported.has(m.daemonExecRef)
        )
        for (const message of unmatched) {
            if (!this.registry.isCurrentHelloEvidence(daemonId, evidence)) break
            this.noteUnmatchedHello(message.id, evidence)
            if (
                now - message.createdAt.getTime() <=
                UNMATCHED_TURN_MIN_AGE_MS
            ) {
                this.scheduleRecheck(daemonId, message, now, evidence)
                continue
            }
            this.log.log(
                `daemon.resume daemonId=${daemonId} messageId=${message.id} absent from hello (${streams.length} streams); reconciling`
            )
            // Awaited, so this promise still means "the hello is fully
            // reconciled" for every ref it decided inline.
            await this.recheckUnmatchedTurn(
                daemonId,
                message.id,
                evidence
            ).catch((err) =>
                this.log.error(
                    `recheck failed messageId=${message.id}: ${(err as Error).message}`
                )
            )
        }
        // Settle only after every launched resume has: callers treat this
        // promise as "the hello is fully reconciled", and each task above
        // already swallows its own error.
        await Promise.all(resumes)
    }

    // The hello said the daemon holds no stream for this turn. That is negative
    // evidence from ONE socket and the terminal it leads to is irreversible, so
    // this is the only path allowed to converge an unmatched turn — reached
    // from the age-gate timer and from the hello itself alike.
    //
    // Everything it decides on is volatile: a matched hello can arrive, a local
    // carrier can take the stream, the connection can move, the row can
    // terminalize. So each await is followed by a full revalidation, including
    // the ones taken after the claim (#728).
    async recheckUnmatchedTurn(
        daemonId: string,
        messageId: string,
        evidence = this.registry.currentHelloEvidence(daemonId)
    ): Promise<void> {
        if (this.destroyed) return
        if (!this.registry.isCurrentHelloEvidence(daemonId, evidence)) {
            if (this.registry.isOnline(daemonId)) {
                const current = this.registry.currentHelloEvidence(daemonId)
                if (current)
                    this.scheduleHelloReconciliationIn(
                        daemonId,
                        messageId,
                        UNMATCHED_DEFER_RECHECK_MS,
                        current
                    )
                else
                    this.scheduleCurrentHelloRecheck(
                        daemonId,
                        messageId,
                        UNMATCHED_DEFER_RECHECK_MS
                    )
            }
            this.recheckOutcome(daemonId, messageId, 'hello_superseded')
            return
        }
        const active = this.activeRechecks.get(messageId)
        if (active) {
            if (!this.sameEvidence(active.evidence, evidence)) {
                active.evidence = evidence
                active.supersededByMatchedHello = false
                active.handedBack = null
            }
            this.recheckOutcome(daemonId, messageId, 'rechecking')
            return
        }
        const recheck: ActiveRecheck = {
            supersededByMatchedHello: false,
            evidence,
            claimed: false,
            handedBack: null
        }
        this.activeRechecks.set(messageId, recheck)
        let reconcileError: unknown = null
        try {
            await this.reconcileUnmatchedTurn(daemonId, messageId, recheck)
        } catch (err) {
            reconcileError = err
            this.recheckOutcome(daemonId, messageId, 'reconcile_failed')
            if (!recheck.handedBack)
                this.scheduleRecheckIn(
                    daemonId,
                    messageId,
                    UNMATCHED_DEFER_RECHECK_MS,
                    recheck.evidence
                )
        } finally {
            if (recheck.claimed) this.resuming.delete(messageId)
            if (this.activeRechecks.get(messageId) === recheck)
                this.activeRechecks.delete(messageId)
        }
        // A matched hello that our claim turned away. The claim and the token
        // are gone by now, so replaying its ref against a FRESH open row is
        // exactly what would have happened had it arrived a moment later. The
        // fresh row matters if the terminal write itself completed while the
        // hello was waiting: replaying its stale message would resume after a
        // terminal instead of recognizing that the terminal already owns it.
        const handedBack = recheck.handedBack
        if (handedBack)
            await this.replayHandedBack(daemonId, handedBack).catch((err) => {
                this.scheduleMatchedResumeRetry(
                    daemonId,
                    handedBack,
                    UNMATCHED_DEFER_RECHECK_MS
                )
                this.log.error(
                    `handleOne failed messageId=${messageId} refId=${handedBack.stream.refId}: ${(err as Error).message}`
                )
            })
        this.forgetHelloTurnIfUncovered(messageId)
        if (reconcileError) throw reconcileError
    }

    private async reconcileUnmatchedTurn(
        daemonId: string,
        messageId: string,
        recheck: ActiveRecheck
    ): Promise<void> {
        // This run takes over the turn's single timer slot: it re-derives
        // everything a pending timer would, and re-arms below if it defers.
        this.clearRecheck(messageId)
        const message = (await this.findOpenTurns(daemonId)).find(
            (candidate) => candidate.id === messageId
        )
        if (!message?.daemonExecRef) {
            this.forgetHelloTurn(messageId)
            this.recheckOutcome(daemonId, messageId, 'settled')
            return
        }
        this.trackHelloTurn(daemonId, message, recheck.evidence, null)
        const beforeVerdict = this.terminalVeto(daemonId, message, recheck)
        if (beforeVerdict) {
            this.yieldTurn(daemonId, messageId, recheck, beforeVerdict)
            return
        }
        // No await separates that revalidation from the claim, so either this
        // run owns the terminal path or a later matched hello sees the guard —
        // and handleOne hands that hello back to us rather than dropping it.
        this.resuming.add(messageId)
        recheck.claimed = true
        // A matched resume can predate this run, so it cannot mark the token
        // above as superseded. If findOpenTurns snapshotted the row while that
        // resume was still terminalizing, `resuming` may already be released by
        // the time we get here. Re-read under our claim so a stale open row
        // cannot append a restart terminal after the real terminal (the two
        // terminals have different dedup keys).
        const snapshotEvidence = recheck.evidence
        const snapshot = await this.findUnmatchedTurnSnapshot(
            daemonId,
            messageId
        )
        if (!snapshot?.message.daemonExecRef) {
            this.recheckOutcome(daemonId, messageId, 'settled')
            return
        }
        const afterClaim = this.terminalVeto(
            daemonId,
            snapshot.message,
            recheck
        )
        if (afterClaim) {
            this.yieldTurn(daemonId, messageId, recheck, afterClaim)
            return
        }
        if (!this.sameEvidence(snapshotEvidence, recheck.evidence)) {
            this.recheckOutcome(daemonId, messageId, 'hello_changed')
            this.scheduleRecheckIn(
                daemonId,
                messageId,
                UNMATCHED_DEFER_RECHECK_MS,
                recheck.evidence
            )
            return
        }
        const current = snapshot.message
        const verdict = this.unmatchedTurnVerdict(snapshot)
        if (verdict.action === 'defer') {
            this.recheckOutcome(daemonId, messageId, verdict.reason)
            this.scheduleRecheckIn(
                daemonId,
                messageId,
                verdict.recheckInMs,
                recheck.evidence
            )
            return
        }
        const handler = this.handler
        if (!handler) {
            this.yieldTurn(daemonId, messageId, recheck, {
                outcome: 'handler_unavailable',
                recheckInMs: UNMATCHED_DEFER_RECHECK_MS
            })
            return
        }
        const terminal = snapshot.message.cancelRequestedAt
            ? () =>
                  handler.completeOfflineCancel({
                      message: current,
                      daemonId,
                      refId: current.daemonExecRef ?? messageId
                  })
            : () => handler.failUnresumable({ message: current, daemonId })
        try {
            await terminal()
            this.recheckOutcome(
                daemonId,
                messageId,
                snapshot.message.cancelRequestedAt ? 'cancelled' : 'converged'
            )
        } catch (err) {
            this.log.error(
                `unmatched terminal failed messageId=${messageId}: ${(err as Error).message}`
            )
            this.recheckOutcome(daemonId, messageId, 'terminal_failed')
            if (!recheck.handedBack)
                this.scheduleRecheckIn(
                    daemonId,
                    messageId,
                    UNMATCHED_DEFER_RECHECK_MS,
                    recheck.evidence
                )
        }
    }

    // Everything that can invalidate a convergence, re-read from live state. A
    // durable verdict, an open row and the hello's own absence are all
    // point-in-time evidence that only holds until the next await, so this runs
    // after every one of them. Non-null means this run no longer owns the turn.
    private terminalVeto(
        daemonId: string,
        message: DbChatMessage,
        recheck: ActiveRecheck
    ): TerminalVeto | null {
        // The daemon itself reported the ref while this run was deriving its
        // verdict: newer and more authoritative than anything derived before
        // it. Remember the arrival rather than relying only on `resuming` — a
        // fast attach can finish and release that guard again first.
        if (recheck.supersededByMatchedHello)
            return { outcome: 'matched_hello' }
        // Someone else's resume owns the turn. Our own claim is not evidence.
        if (!recheck.claimed && this.resuming.has(message.id))
            return { outcome: 'resuming' }
        if (!this.registry.isCurrentHelloEvidence(daemonId, recheck.evidence))
            return this.registry.isOnline(daemonId)
                ? {
                      outcome: 'hello_superseded',
                      recheckInMs: UNMATCHED_DEFER_RECHECK_MS
                  }
                : { outcome: 'daemon_not_local' }
        if (!this.handler)
            return {
                outcome: 'handler_unavailable',
                recheckInMs: UNMATCHED_DEFER_RECHECK_MS
            }
        // A skipped resume puts the ref back under the recheck (#648), so a
        // recheck can land on a turn whose local execution is still alive — the
        // #624 fence adopting the stream it found as its carrier streams for
        // minutes under exactly that shape. A daemon-runtime turn's durable row
        // (#570) only vetoes while its lease is live, and a carrier that was
        // dispatched before that row existed has none at all, so without this
        // its terminal would land on top of a live stream.
        if (this.handler?.isRunningLocally(message.id))
            return {
                outcome: 'running_locally',
                recheckInMs: UNMATCHED_DEFER_RECHECK_MS
            }
        // Connection gone or moved to another instance: either the daemon is
        // offline (adoption no longer defers to it) or the new connection's
        // hello re-arbitrated the turn there. Both own the turn now.
        if (!this.registry.isOnline(daemonId))
            return { outcome: 'daemon_not_local' }
        // A pending rpc keyed by the exec ref is a positive dispatch receipt:
        // the turn IS on the current socket and its dispatcher is attached.
        if (
            message.daemonExecRef &&
            this.registry.hasPendingRef(daemonId, message.daemonExecRef)
        )
            return { outcome: 'dispatch_attached' }
        return null
    }

    private yieldTurn(
        daemonId: string,
        messageId: string,
        recheck: ActiveRecheck,
        veto: TerminalVeto
    ): void {
        this.recheckOutcome(daemonId, messageId, veto.outcome)
        if (veto.recheckInMs !== undefined)
            this.scheduleRecheckIn(
                daemonId,
                messageId,
                veto.recheckInMs,
                recheck.evidence
            )
    }

    // "Absent from the hello" is negative evidence from ONE socket. Before it
    // becomes a terminal, the durable execution record — the same cross-
    // instance arbiter the adoption sweep trusts — gets a veto. #518: a
    // rolling deploy's hello converged a turn that had COMPLETED on the
    // runner and was still being drained by its owner instance (live lease,
    // events still landing); the buffer had merely aged past the CLI's 5min
    // hello grace. A live lease, a handoff/adoption in flight, or delivered
    // runner frames (proof the dispatch reached the daemon, so transcript
    // recovery has something to work with) each defer convergence; a lapsed
    // lease on a turn that never streamed anything is the #512 shape and
    // converges as before.
    private unmatchedTurnVerdict(
        snapshot: UnmatchedTurnSnapshot
    ): UnmatchedVerdict {
        const { message, execution: exec, streamedRunnerFrames } = snapshot
        if (!exec || exec.state === 'done' || exec.state === 'failed')
            return { action: 'converge' }
        const leaseMs = exec.leaseExpiresAt.getTime() - Date.now()
        if (leaseMs > 0)
            return {
                action: 'defer',
                reason: `lease_held_${exec.state}`,
                recheckInMs: leaseMs + UNMATCHED_LEASE_RECHECK_SLACK_MS
            }
        // #570 stamps daemon-carried turns too, so a matched resume can fence
        // the carrier it displaces. The lease is the only part of that row this
        // verdict may read: everything below waits for an adoption that will
        // never come for a daemon row (listAdoptableTurnExecutions is
        // sprites/external only), so reading it would stall the #512 shape for
        // 45 minutes behind a sweep that is not looking. A lapsed daemon lease
        // converges exactly as the pre-#570 missing row did.
        if (exec.runtime === 'daemon') return { action: 'converge' }
        if (
            Date.now() - message.createdAt.getTime() >
            UNMATCHED_TURN_GIVE_UP_MS
        )
            return { action: 'converge' }
        if (exec.state === 'handoff' || exec.state === 'adopting')
            return {
                action: 'defer',
                reason: `awaiting_adoption_${exec.state}`,
                recheckInMs: UNMATCHED_DEFER_RECHECK_MS
            }
        if (streamedRunnerFrames)
            return {
                action: 'defer',
                reason: 'delivered_runner_frames',
                recheckInMs: UNMATCHED_DEFER_RECHECK_MS
            }
        return { action: 'converge' }
    }

    private scheduleRecheck(
        daemonId: string,
        message: DbChatMessage,
        now: number,
        evidence: DaemonHelloEvidence
    ): void {
        this.trackHelloTurn(daemonId, message, evidence, null)
        const delay = this.ageGateRecheckDelay(message, now)
        this.log.log(
            `daemon.resume.recheck daemonId=${daemonId} messageId=${message.id} absent from hello inside the age gate; recheck in ${delay}ms`
        )
        this.scheduleRecheckIn(daemonId, message.id, delay, evidence)
    }

    // The hello matched — the daemon can still serve this ref — but the resume
    // declined because a carrier IN THIS PROCESS holds the turn. That execution
    // can end WITHOUT settling it: the #624 fence spends up to 15s
    // recovering a zero-frame dispatch and, on a buffer that answers `daemon
    // process crashed`, declines and suspends. By then this hello is gone, and
    // it was the turn's only scheduled reconciliation — the matched branch
    // schedules no recheck and handleOne cleared any earlier one, so nothing
    // re-examines the ref until the NEXT reconnect. Staging drill A6 (#648)
    // hung 337s that way, settling only when the lease sweep caught up, while
    // the same drill's unskipped attempts settled on the ~74s recheck.
    //
    // Putting the ref back under that same bounded recheck restores it. The
    // recheck re-derives everything from live state, so an execution that is
    // genuinely still carrying the turn keeps deferring it. A resume the
    // DURABLE claim turned away is a different verdict and takes the matched
    // replay instead — see handleOne.
    private scheduleSkippedResumeRecheck(
        daemonId: string,
        message: DbChatMessage,
        evidence: DaemonHelloEvidence
    ): void {
        const tracked = this.helloTurns.get(message.id)
        this.trackHelloTurn(
            daemonId,
            message,
            evidence,
            tracked && this.sameEvidence(tracked.evidence, evidence)
                ? tracked.stream
                : null
        )
        const delay = this.ageGateRecheckDelay(message, Date.now())
        this.log.log(
            `daemon.resume.recheck daemonId=${daemonId} messageId=${message.id} matched hello resume skipped while another carrier owns it; recheck in ${delay}ms`
        )
        this.scheduleRecheckIn(daemonId, message.id, delay, evidence)
    }

    private ageGateRecheckDelay(message: DbChatMessage, now: number): number {
        return (
            Math.max(
                0,
                UNMATCHED_TURN_MIN_AGE_MS - (now - message.createdAt.getTime())
            ) + UNMATCHED_TURN_RECHECK_SLACK_MS
        )
    }

    private scheduleRecheckIn(
        daemonId: string,
        messageId: string,
        delayMs: number,
        evidence: DaemonHelloEvidence
    ): void {
        if (this.destroyed) return
        if (!this.registry.isCurrentHelloEvidence(daemonId, evidence)) {
            if (this.registry.isOnline(daemonId)) {
                const current = this.registry.currentHelloEvidence(daemonId)
                if (current)
                    this.scheduleHelloReconciliationIn(
                        daemonId,
                        messageId,
                        delayMs,
                        current
                    )
                else
                    this.scheduleCurrentHelloRecheck(
                        daemonId,
                        messageId,
                        delayMs
                    )
            }
            return
        }
        // A newer hello may reach the same one-timer slot before it fires. Keep
        // one timer, but replace its evidence token: letting the older callback
        // fire would correctly recognize itself as superseded and then leave
        // the newer hello with no owner and no timer.
        this.clearRecheck(messageId)
        const timer = setTimeout(() => {
            this.recheckTimers.delete(messageId)
            void this.recheckUnmatchedTurn(daemonId, messageId, evidence).catch(
                (err) =>
                    this.log.error(
                        `recheck failed messageId=${messageId}: ${(err as Error).message}`
                    )
            )
        }, this.recheckDelay(delayMs))
        timer.unref?.()
        this.recheckTimers.set(messageId, timer)
    }

    // A newer hello superseded the callback that held this timer, but its
    // stream list may be positive OR negative evidence for the turn. Re-run the
    // intersection against that exact hello before choosing matched replay or
    // unmatched reconciliation. Falling straight into recheckUnmatchedTurn
    // loses a newly matched ref when the newer hello's first DB lookup is still
    // waiting or rejected.
    private scheduleHelloReconciliationIn(
        daemonId: string,
        messageId: string,
        delayMs: number,
        evidence: DaemonHelloEvidence
    ): void {
        if (this.destroyed) return
        if (!this.registry.isCurrentHelloEvidence(daemonId, evidence)) {
            if (this.registry.isOnline(daemonId)) {
                const current = this.registry.currentHelloEvidence(daemonId)
                if (current)
                    this.scheduleHelloReconciliationIn(
                        daemonId,
                        messageId,
                        delayMs,
                        current
                    )
                else
                    this.scheduleCurrentHelloRecheck(
                        daemonId,
                        messageId,
                        delayMs
                    )
            }
            return
        }
        this.clearRecheck(messageId)
        const timer = setTimeout(() => {
            this.recheckTimers.delete(messageId)
            void this.reconcileHelloTurn(daemonId, messageId, evidence).catch(
                (err) => {
                    this.scheduleHelloReconciliationIn(
                        daemonId,
                        messageId,
                        UNMATCHED_DEFER_RECHECK_MS,
                        evidence
                    )
                    this.log.error(
                        `hello reconciliation failed messageId=${messageId}: ${(err as Error).message}`
                    )
                }
            )
        }, this.recheckDelay(delayMs))
        timer.unref?.()
        this.recheckTimers.set(messageId, timer)
    }

    private async reconcileHelloTurn(
        daemonId: string,
        messageId: string,
        evidence: DaemonHelloEvidence
    ): Promise<void> {
        if (this.destroyed) return
        if (!this.registry.isCurrentHelloEvidence(daemonId, evidence)) {
            if (this.registry.isOnline(daemonId)) {
                const current = this.registry.currentHelloEvidence(daemonId)
                if (current)
                    this.scheduleHelloReconciliationIn(
                        daemonId,
                        messageId,
                        UNMATCHED_DEFER_RECHECK_MS,
                        current
                    )
                else
                    this.scheduleCurrentHelloRecheck(
                        daemonId,
                        messageId,
                        UNMATCHED_DEFER_RECHECK_MS
                    )
            }
            return
        }
        const hello = this.helloTurns.get(messageId)
        if (
            !hello ||
            hello.daemonId !== daemonId ||
            !this.sameEvidence(hello.evidence, evidence)
        ) {
            this.scheduleCurrentHelloRecheck(
                daemonId,
                messageId,
                UNMATCHED_DEFER_RECHECK_MS
            )
            return
        }
        const message = await this.findOpenTurn(daemonId, messageId)
        if (this.destroyed) return
        if (!this.registry.isCurrentHelloEvidence(daemonId, evidence)) {
            this.scheduleHelloReconciliationIn(
                daemonId,
                messageId,
                UNMATCHED_DEFER_RECHECK_MS,
                evidence
            )
            return
        }
        if (!message?.daemonExecRef) {
            this.forgetHelloTurn(messageId)
            return
        }
        if (message.daemonExecRef !== hello.message.daemonExecRef) {
            this.forgetHelloTurn(messageId)
            return
        }
        this.trackHelloTurn(daemonId, message, evidence, hello.stream)
        const stream = hello.stream
        if (stream) {
            await this.handleOne(daemonId, stream, message, evidence)
            return
        }
        await this.recheckUnmatchedTurn(daemonId, messageId, evidence)
    }

    private scheduleCurrentHelloRecheck(
        daemonId: string,
        messageId: string,
        delayMs: number
    ): void {
        if (this.destroyed) return
        this.clearRecheck(messageId)
        const timer = setTimeout(() => {
            this.recheckTimers.delete(messageId)
            const evidence = this.registry.currentHelloEvidence(daemonId)
            const run = evidence
                ? this.reconcileHelloTurn(daemonId, messageId, evidence)
                : this.recheckUnmatchedTurn(daemonId, messageId)
            void run.catch((err) => {
                if (evidence)
                    this.scheduleHelloReconciliationIn(
                        daemonId,
                        messageId,
                        UNMATCHED_DEFER_RECHECK_MS,
                        evidence
                    )
                else if (this.registry.isOnline(daemonId))
                    this.scheduleCurrentHelloRecheck(
                        daemonId,
                        messageId,
                        UNMATCHED_DEFER_RECHECK_MS
                    )
                this.log.error(
                    `recheck failed messageId=${messageId}: ${(err as Error).message}`
                )
            })
        }, this.recheckDelay(delayMs))
        timer.unref?.()
        this.recheckTimers.set(messageId, timer)
    }

    private clearRecheck(messageId: string): void {
        const timer = this.recheckTimers.get(messageId)
        if (!timer) return
        clearTimeout(timer)
        this.recheckTimers.delete(messageId)
    }

    private trackHelloTurn(
        daemonId: string,
        message: DbChatMessage,
        evidence: DaemonHelloEvidence,
        stream: DaemonInflightStream | null
    ): void {
        if (!message.daemonExecRef) return
        const tracked = this.helloTurns.get(message.id)
        // An older query may return after handleInflightStreams installed a
        // newer hello synchronously. It cannot put the old evidence back.
        if (
            tracked &&
            !this.sameEvidence(tracked.evidence, evidence) &&
            this.registry.isCurrentHelloEvidence(daemonId, tracked.evidence)
        )
            return
        this.helloTurns.set(message.id, {
            daemonId,
            message,
            evidence,
            stream
        })
    }

    private forgetHelloTurnIfUncovered(messageId: string): void {
        if (
            this.recheckTimers.has(messageId) ||
            this.activeRechecks.has(messageId) ||
            this.matched.has(messageId) ||
            this.resuming.has(messageId)
        )
            return
        this.forgetHelloTurn(messageId)
    }

    private forgetHelloTurn(messageId: string): void {
        this.helloTurns.delete(messageId)
    }

    private recheckOutcome(
        daemonId: string,
        messageId: string,
        outcome: string
    ): void {
        const line = `daemon.resume.recheck daemonId=${daemonId} messageId=${messageId} outcome=${outcome}`
        if (outcome === 'converged') this.log.warn(line)
        else this.log.log(line)
    }

    // Overridable in tests, which cannot wait out the real age gate.
    protected recheckDelay(ms: number): number {
        return ms
    }

    private async handleOne(
        daemonId: string,
        stream: DaemonInflightStream,
        message: DbChatMessage,
        evidence: DaemonHelloEvidence
    ): Promise<void> {
        if (!this.registry.isCurrentHelloEvidence(daemonId, evidence)) return
        this.trackHelloTurn(daemonId, message, evidence, stream)
        const activeRecheck = this.activeRechecks.get(message.id)
        if (activeRecheck) {
            activeRecheck.evidence = evidence
            activeRecheck.supersededByMatchedHello = true
        }
        this.clearRecheck(message.id)
        if (activeRecheck?.claimed) {
            // The guard is shared with the reconcile path's terminal claim, and
            // a hello cannot tell the two apart. Returning here when a recheck
            // holds it loses the ref: we just marked that recheck superseded,
            // so it yields to THIS hello, and neither side would own the turn —
            // the shape #648 fixed on the matched branch, reintroduced by the
            // claim (#728). Hand it back to be replayed once the claim drops.
            activeRecheck.handedBack = { stream, message, evidence }
            this.log.log(
                `daemon.resume daemonId=${daemonId} messageId=${message.id} handed back to the recheck holding the claim`
            )
            return
        }
        const activeMatched = this.matched.get(message.id)
        if (activeMatched) {
            activeMatched.evidence = evidence
            activeMatched.matched = { stream, message, evidence }
            this.log.log(
                `daemon.resume daemonId=${daemonId} messageId=${message.id} already resuming; skipping duplicate`
            )
            return
        }
        if (this.resuming.has(message.id)) {
            this.scheduleMatchedResumeRetry(
                daemonId,
                { stream, message, evidence },
                UNMATCHED_DEFER_RECHECK_MS
            )
            return
        }
        const matchedRun: ActiveMatchedResume = {
            evidence,
            matched: { stream, message, evidence }
        }
        this.matched.set(message.id, matchedRun)
        let owned = false
        try {
            const current = await this.findOpenTurn(daemonId, message.id)
            if (!this.registry.isCurrentHelloEvidence(daemonId, evidence))
                return
            if (
                !current?.daemonExecRef ||
                current.daemonExecRef !== stream.refId
            ) {
                owned = true
                return
            }
            if (!this.handler) {
                this.log.warn(
                    `no resume handler registered; cannot resume messageId=${current.id} refId=${stream.refId}`
                )
                return
            }
            if (current.cancelRequestedAt) {
                this.resuming.add(current.id)
                try {
                    const claimed = await this.claimAbort(current.id)
                    if (
                        !this.registry.isCurrentHelloEvidence(
                            daemonId,
                            evidence
                        )
                    ) {
                        if (claimed) await this.releaseAbortClaim(current.id)
                        return
                    }
                    if (!claimed) {
                        owned = true
                        return
                    }
                    try {
                        await this.dispatchAbort(
                            daemonId,
                            stream.refId,
                            current
                        )
                        owned = true
                    } catch (err) {
                        this.log.warn(
                            `exec.abort failed for messageId=${current.id} refId=${stream.refId}: ${(err as Error).message}`
                        )
                    }
                } finally {
                    this.resuming.delete(current.id)
                }
                return
            }
            // The resume rpc runs under a fresh refId (originalRefId travels in
            // the payload), so hasPendingRef cannot see it — track it here so a
            // recheck firing mid-resume does not converge the turn under it.
            // The set doubles as the per-message single-flight guard: matched
            // resumes launch concurrently and a daemon can re-hello mid-resume,
            // and a second consumer of the same stream would duplicate events
            // and can race two terminals onto one turn.
            this.resuming.add(current.id)
            let outcome: DaemonResumeOutcome = 'handled'
            let failed = false
            try {
                outcome = await this.handler.resumeAssistantTurn({
                    message: current,
                    daemonId,
                    refId: stream.refId
                })
            } catch (err) {
                failed = true
                this.log.error(
                    `resumeAssistantTurn failed messageId=${current.id} refId=${stream.refId}: ${(err as Error).message}`
                )
            } finally {
                this.resuming.delete(current.id)
            }
            if (!failed && outcome === 'handled') owned = true
            else if (!failed && outcome === 'skipped_running_locally') {
                this.scheduleSkippedResumeRecheck(
                    daemonId,
                    current,
                    matchedRun.evidence
                )
                owned = true
            }
            // `skipped_owned_elsewhere` — like a rejected resume — leaves the
            // turn unowned, so the finally covers it by REPLAYING this matched
            // ref rather than by arming the unmatched recheck.
            //
            // That outcome says the durable claim lost to a live carrier (a
            // SIGINT handoff's drain grace, a peer mid-resume); it says nothing
            // about the stream, which the daemon listed as servable moments
            // ago. Handing the ref to the unmatched recheck throws that
            // evidence away, and the recheck's verdict for a daemon row is
            // whatever the lease says: once the drain grace lapses it
            // converges. Seen on staging [2026-08-14]: a matched hello landed
            // 1.1s into a SIGINT overlap, could not claim behind the dying
            // owner's grace, and the recheck it left behind claimed generation
            // 2 and wrote `server_restart` over a stream the daemon was still
            // serving. The replay re-derives the row and the hello's currency
            // every time, so it either claims and attaches or steps aside for a
            // newer hello that no longer lists the ref.
        } finally {
            if (this.matched.get(message.id) === matchedRun)
                this.matched.delete(message.id)
            if (!owned)
                this.coverUnownedMatchedRun(daemonId, message.id, matchedRun)
            this.forgetHelloTurnIfUncovered(message.id)
        }
    }

    // A newer hello that does NOT list the ref retires the matched evidence an
    // in-flight resume was holding: the daemon's latest buffer is authoritative
    // over the older one, so whatever that resume returns must fall back to the
    // unmatched recheck rather than replay a ref the daemon no longer offers.
    private noteUnmatchedHello(
        messageId: string,
        evidence: DaemonHelloEvidence
    ): void {
        const active = this.matched.get(messageId)
        if (!active || this.sameEvidence(active.evidence, evidence)) return
        active.evidence = evidence
        active.matched = null
    }

    private coverUnownedMatchedRun(
        daemonId: string,
        messageId: string,
        run: ActiveMatchedResume
    ): void {
        if (this.registry.isCurrentHelloEvidence(daemonId, run.evidence)) {
            if (run.matched)
                this.scheduleMatchedResumeRetry(
                    daemonId,
                    run.matched,
                    UNMATCHED_DEFER_RECHECK_MS
                )
            else
                this.scheduleRecheckIn(
                    daemonId,
                    messageId,
                    UNMATCHED_DEFER_RECHECK_MS,
                    run.evidence
                )
            return
        }
        if (!this.registry.isOnline(daemonId)) return
        const current = this.registry.currentHelloEvidence(daemonId)
        if (current)
            this.scheduleHelloReconciliationIn(
                daemonId,
                messageId,
                UNMATCHED_DEFER_RECHECK_MS,
                current
            )
        else
            this.scheduleCurrentHelloRecheck(
                daemonId,
                messageId,
                UNMATCHED_DEFER_RECHECK_MS
            )
    }

    private async replayHandedBack(
        daemonId: string,
        handedBack: MatchedResumeEvidence
    ): Promise<void> {
        if (
            !this.registry.isCurrentHelloEvidence(daemonId, handedBack.evidence)
        ) {
            this.coverSupersededEvidence(daemonId, handedBack.message.id)
            return
        }
        const current = await this.findOpenTurn(daemonId, handedBack.message.id)
        if (
            !this.registry.isCurrentHelloEvidence(daemonId, handedBack.evidence)
        ) {
            this.coverSupersededEvidence(daemonId, handedBack.message.id)
            return
        }
        if (
            !current?.daemonExecRef ||
            current.daemonExecRef !== handedBack.stream.refId
        ) {
            this.forgetHelloTurn(handedBack.message.id)
            return
        }
        await this.handleOne(
            daemonId,
            handedBack.stream,
            current,
            handedBack.evidence
        )
    }

    private coverSupersededEvidence(daemonId: string, messageId: string): void {
        if (!this.registry.isOnline(daemonId)) return
        const current = this.registry.currentHelloEvidence(daemonId)
        if (current)
            this.scheduleHelloReconciliationIn(
                daemonId,
                messageId,
                UNMATCHED_DEFER_RECHECK_MS,
                current
            )
        else
            this.scheduleCurrentHelloRecheck(
                daemonId,
                messageId,
                UNMATCHED_DEFER_RECHECK_MS
            )
    }

    private scheduleMatchedResumeRetry(
        daemonId: string,
        matched: MatchedResumeEvidence,
        delayMs: number
    ): void {
        if (this.destroyed) return
        if (!this.registry.isCurrentHelloEvidence(daemonId, matched.evidence))
            return
        this.trackHelloTurn(
            daemonId,
            matched.message,
            matched.evidence,
            matched.stream
        )
        this.clearRecheck(matched.message.id)
        const timer = setTimeout(() => {
            this.recheckTimers.delete(matched.message.id)
            void this.replayHandedBack(daemonId, matched).catch((err) => {
                this.scheduleMatchedResumeRetry(
                    daemonId,
                    matched,
                    UNMATCHED_DEFER_RECHECK_MS
                )
                this.log.error(
                    `matched resume retry failed messageId=${matched.message.id} refId=${matched.stream.refId}: ${(err as Error).message}`
                )
            })
        }, this.recheckDelay(delayMs))
        timer.unref?.()
        this.recheckTimers.set(matched.message.id, timer)
    }

    private sameEvidence(
        left: DaemonHelloEvidence,
        right: DaemonHelloEvidence
    ): boolean {
        return (
            left.connectionToken === right.connectionToken &&
            left.helloOrder === right.helloOrder
        )
    }

    private async repairRuntimeStatus(daemonId: string): Promise<void> {
        const now = new Date()
        try {
            await this.db
                .update(agentRuntimes)
                .set({ status: 'ready', updatedAt: now })
                .where(
                    and(
                        eq(agentRuntimes.daemonId, daemonId),
                        eq(agentRuntimes.status, 'stopped')
                    )
                )
            await this.db
                .update(agents)
                .set({
                    status: 'running',
                    failureReason: null,
                    updatedAt: now
                })
                .where(
                    and(
                        eq(agents.daemonId, daemonId),
                        eq(agents.failureReason, 'daemon disconnected')
                    )
                )
        } catch (err) {
            this.log.warn(
                `runtime status repair failed daemonId=${daemonId}: ${(err as Error).message}`
            )
        }
    }

    // Ask the DB for THIS DAEMON's unfinished turns and intersect locally,
    // rather than asking it about every refId the daemon reported.
    //
    // A daemon's hello lists its whole exec buffer, which in practice is
    // thousands of entries (measured: 20559 on one staging daemon, 4815 in
    // prod, growing daily) while the number that matches an unfinished turn is
    // ~1. Passing them all as bind parameters made every reconnect a
    // multi-thousand-parameter query — and daemons reconnect constantly (78
    // times in a day for one prod daemon). Postgres also caps a statement at
    // 65535 parameters, so that shape was on course to fail outright.
    //
    // The flipped query is bounded by open turns instead of buffer size and
    // rides the existing partial index on (daemon_id, daemon_exec_ref).
    private async findOpenTurns(daemonId: string): Promise<DbChatMessage[]> {
        this.pendingOpenLookups.set(
            daemonId,
            (this.pendingOpenLookups.get(daemonId) ?? 0) + 1
        )
        try {
            const rows = await this.db
                .select()
                .from(chatMessages)
                .where(
                    and(
                        eq(chatMessages.daemonId, daemonId),
                        isNotNull(chatMessages.daemonExecRef),
                        sql`not exists (
                            select 1 from ${chatStreamEvents}
                            where ${chatStreamEvents.messageId} = ${chatMessages.id}
                              and ${chatStreamEvents.eventType} in ('done', 'error')
                        )`
                    )
                )
            const snapshot = this.helloSnapshots.get(daemonId)
            if (
                snapshot &&
                this.registry.isCurrentHelloEvidence(
                    daemonId,
                    snapshot.evidence
                )
            )
                for (const message of rows) {
                    const refId = message.daemonExecRef
                    if (!refId) continue
                    this.trackHelloTurn(
                        daemonId,
                        message,
                        snapshot.evidence,
                        snapshot.streamsByRef.get(refId) ?? null
                    )
                }
            return rows
        } finally {
            const pending = (this.pendingOpenLookups.get(daemonId) ?? 1) - 1
            if (pending > 0) this.pendingOpenLookups.set(daemonId, pending)
            else {
                this.pendingOpenLookups.delete(daemonId)
                this.helloSnapshots.delete(daemonId)
            }
        }
    }

    private async findOpenTurn(
        daemonId: string,
        messageId: string
    ): Promise<DbChatMessage | null> {
        const rows = await this.db
            .select()
            .from(chatMessages)
            .where(
                and(
                    eq(chatMessages.id, messageId),
                    eq(chatMessages.daemonId, daemonId),
                    isNotNull(chatMessages.daemonExecRef),
                    sql`not exists (
                        select 1 from ${chatStreamEvents}
                        where ${chatStreamEvents.messageId} = ${chatMessages.id}
                          and ${chatStreamEvents.eventType} in ('done', 'error')
                    )`
                )
            )
            .limit(1)
        return rows[0] ?? null
    }

    // The terminal consumes this ONE statement's snapshot. Keeping the current
    // open row, execution lease/state and delivered-frame evidence in one query
    // removes the await gap where one fact could become stale while another was
    // fetched. Once it returns, the in-memory veto set is re-read and there is
    // no further await before the terminal path starts.
    private async findUnmatchedTurnSnapshot(
        daemonId: string,
        messageId: string
    ): Promise<UnmatchedTurnSnapshot | null> {
        const rows = await this.db
            .select({
                message: getTableColumns(chatMessages),
                execution: {
                    runtime: turnExecutions.runtime,
                    state: turnExecutions.state,
                    leaseExpiresAt: turnExecutions.leaseExpiresAt
                },
                streamedRunnerFrames: sql<boolean>`exists (
                    select 1 from ${chatStreamEvents}
                    where ${chatStreamEvents.messageId} = ${chatMessages.id}
                      and ${chatStreamEvents.runnerSeq} is not null
                )`
            })
            .from(chatMessages)
            .leftJoin(
                turnExecutions,
                eq(turnExecutions.messageId, chatMessages.id)
            )
            .where(
                and(
                    eq(chatMessages.id, messageId),
                    eq(chatMessages.daemonId, daemonId),
                    isNotNull(chatMessages.daemonExecRef),
                    sql`not exists (
                        select 1 from ${chatStreamEvents}
                        where ${chatStreamEvents.messageId} = ${chatMessages.id}
                          and ${chatStreamEvents.eventType} in ('done', 'error')
                    )`
                )
            )
            .limit(1)
        const row = rows[0]
        if (!row) return null
        return {
            message: row.message,
            execution: row.execution,
            streamedRunnerFrames: row.streamedRunnerFrames
        }
    }

    private async claimAbort(messageId: string): Promise<boolean> {
        const rows = await this.db
            .update(chatMessages)
            .set({ abortDispatchedAt: new Date() })
            .where(
                and(
                    eq(chatMessages.id, messageId),
                    isNotNull(chatMessages.cancelRequestedAt),
                    isNull(chatMessages.abortDispatchedAt)
                )
            )
            .returning({ id: chatMessages.id })
        return rows.length > 0
    }

    private async releaseAbortClaim(messageId: string): Promise<void> {
        await this.db
            .update(chatMessages)
            .set({ abortDispatchedAt: null })
            .where(eq(chatMessages.id, messageId))
            .catch(() => {})
    }

    private async dispatchAbort(
        daemonId: string,
        refId: string,
        message: DbChatMessage
    ): Promise<void> {
        try {
            await this.registry.rpc({
                daemonId,
                method: 'exec.abort',
                payload: { refId },
                timeoutMs: 10_000
            })
            if (!this.handler) {
                throw new Error('no resume handler registered')
            }
            await this.handler.completeOfflineCancel({
                message,
                daemonId,
                refId
            })
        } catch (err) {
            await this.releaseAbortClaim(message.id)
            throw err
        }
    }
}
