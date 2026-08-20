import { randomUUID } from 'node:crypto'
import {
    Injectable,
    Logger,
    Optional,
    type OnApplicationBootstrap,
    type OnModuleDestroy
} from '@nestjs/common'
import type { TurnExecutionRow } from '@manyfold/db'
import { TelemetryService } from '@/common/telemetry/telemetry.service'
import { ChatRepository } from '@/modules/chat/chat.repository'

export interface TurnAdoptionHandler {
    // Continue/finish a turn this instance just claimed. Must terminate the
    // turn under its original assistantMessageId (so web SSE, the channel
    // sweep, and A2A all converge) or throw to release the lease for retry.
    adopt(row: TurnExecutionRow): Promise<void>
    // A turn that has been claimed too many times without converging — stop
    // retrying and close it out with a retryable terminal.
    giveUp(row: TurnExecutionRow): Promise<void>
}

// Per-turn lease (seconds). A live owner renews well inside this; a dead owner's
// turn becomes adoptable one TTL after its last renew. Matches the house lease
// pattern (service_leases / channel_leases).
export const TURN_LEASE_SECONDS = 90
export const TURN_LEASE_RENEW_MS = 30_000
const SWEEP_INTERVAL_MS = 15_000
const ADOPT_BATCH = 20
// Bound re-adoption of a turn that never converges (e.g. its transcript stays
// non-terminal): after this many claims, give up with a retryable terminal.
const MAX_ADOPT_ATTEMPTS = 5
// One adoption legitimately re-polls a still-generating turn for minutes, so
// adoptions run concurrently (an inline await would head-of-line-block every
// other orphan's recovery behind the longest turn). The cap bounds transcript
// re-reads; overflow is picked up by the next sweep tick.
const MAX_CONCURRENT_ADOPTIONS = 10

const parseFlag = (raw: string | undefined): boolean =>
    raw === '1' || raw === 'true' || raw === 'yes'

// Owns the turn-adoption sweep: discover lapsed/handed-off sprite turns, CAS a
// single owner per turn (the platform gives no attach arbitration — the DB
// lease is the arbiter), and dispatch to the registered handler. Gated by
// MF_TURN_ADOPTION; off = the pre-existing terminalize-on-subscribe behavior.
@Injectable()
export class TurnAdoptionService
    implements OnApplicationBootstrap, OnModuleDestroy
{
    private readonly logger = new Logger(TurnAdoptionService.name)
    readonly ownerId =
        process.env.MF_API_INSTANCE_ID ||
        process.env.FLY_MACHINE_ID ||
        process.env.HOSTNAME ||
        randomUUID()
    readonly enabled = parseFlag(process.env.MF_TURN_ADOPTION)
    private handler: TurnAdoptionHandler | null = null
    private timer: ReturnType<typeof setInterval> | null = null
    private sweeping = false
    private stopped = false
    private sweepPromise: Promise<void> | null = null
    private readonly adopting = new Set<string>()

    constructor(
        private readonly repo: ChatRepository,
        @Optional() private readonly telemetry?: TelemetryService
    ) {}

    registerHandler(handler: TurnAdoptionHandler): void {
        this.handler = handler
    }

    onApplicationBootstrap(): void {
        if (!this.enabled) return
        this.stopped = false
        this.logger.log(`turn adoption enabled (owner=${this.ownerId})`)
        // Kick once on boot so a deploy's orphans are adopted within seconds,
        // not on the first tick.
        this.startSweep('bootstrap')
        this.timer = setInterval(
            () => this.startSweep('periodic'),
            SWEEP_INTERVAL_MS
        )
        this.timer.unref()
    }

    async onModuleDestroy(): Promise<void> {
        await this.stopClaiming()
    }

    async stopClaiming(): Promise<void> {
        this.stopped = true
        if (this.timer) {
            clearInterval(this.timer)
            this.timer = null
        }
        await this.sweepPromise?.catch(() => undefined)
    }

    // Cheap nudge from subscribeStream so a user reopening a session triggers
    // immediate adoption instead of waiting for the next tick.
    kick(): void {
        if (!this.enabled || this.stopped) return
        this.startSweep('kick')
    }

    private startSweep(source: string): void {
        if (this.stopped || this.sweepPromise) return
        const promise = this.sweep(source)
        this.sweepPromise = promise
        void promise.finally(() => {
            if (this.sweepPromise === promise) this.sweepPromise = null
        })
    }

    private async sweep(source: string): Promise<void> {
        if (!this.enabled || this.stopped || !this.handler || this.sweeping)
            return
        this.sweeping = true
        try {
            const candidates =
                await this.repo.listAdoptableTurnExecutions(ADOPT_BATCH)
            for (const candidate of candidates) {
                if (this.stopped) break
                const handler = this.handler
                if (!handler) break
                // Already adopting here (its lease renews between polls, but
                // guard the gaps) — never double-run a turn in-process.
                if (this.adopting.has(candidate.messageId)) continue
                if (candidate.adoptCount >= MAX_ADOPT_ATTEMPTS) {
                    // Claim it first so only one instance gives up, then close.
                    const claimed = await this.repo.claimTurnForAdoption(
                        candidate.messageId,
                        this.ownerId,
                        TURN_LEASE_SECONDS
                    )
                    if (!claimed) continue
                    if (this.stopped) {
                        await this.handoffLateClaim(claimed)
                        break
                    }
                    this.telemetry?.event('chat.turn.adopt_gave_up', {
                        messageId: claimed.messageId,
                        adoptCount: claimed.adoptCount
                    })
                    await handler
                        .giveUp(claimed)
                        .catch((err: Error) =>
                            this.logger.warn(
                                `adopt giveUp failed messageId=${claimed.messageId}: ${err.message}`
                            )
                        )
                    continue
                }
                if (this.adopting.size >= MAX_CONCURRENT_ADOPTIONS) continue
                const claimed = await this.repo.claimTurnForAdoption(
                    candidate.messageId,
                    this.ownerId,
                    TURN_LEASE_SECONDS
                )
                // Lost the CAS: another instance owns it now.
                if (!claimed) continue
                if (this.stopped) {
                    await this.handoffLateClaim(claimed)
                    break
                }
                this.telemetry?.event('chat.turn.adopt_claimed', {
                    messageId: claimed.messageId,
                    runtime: claimed.runtime,
                    adoptCount: claimed.adoptCount,
                    source
                })
                this.adopting.add(claimed.messageId)
                void handler
                    .adopt(claimed)
                    .catch((err: Error) =>
                        // Throwing left the lease held at claim time; it lapses
                        // and another sweep re-claims (adopt_count caps the
                        // loop).
                        this.logger.warn(
                            `adopt failed messageId=${claimed.messageId}: ${err.message}`
                        )
                    )
                    .finally(() => this.adopting.delete(claimed.messageId))
            }
        } catch (err) {
            this.logger.warn(`adoption sweep failed: ${(err as Error).message}`)
        } finally {
            this.sweeping = false
        }
    }

    private async handoffLateClaim(claimed: TurnExecutionRow): Promise<void> {
        await this.repo
            // Generation-scoped: this sweep stopped between claiming and
            // running, and by now a matched daemon resume may have taken the
            // turn. Handing off on owner alone would re-open a live turn for
            // adoption when that resume happens to run on this same instance.
            .handoffOwnedTurn(
                claimed.messageId,
                this.ownerId,
                claimed.generation
            )
            .catch((err: Error) => {
                this.logger.warn(
                    `late adoption claim handoff failed messageId=${claimed.messageId}: ${err.message}`
                )
            })
    }
}
