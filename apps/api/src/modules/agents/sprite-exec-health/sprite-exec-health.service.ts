import { Inject, Injectable, Logger, Optional } from '@nestjs/common'
import { and, eq, isNotNull, lte, sql } from 'drizzle-orm'
import { runtimeHosts, type Database } from '@manyfold/db'
import { DRIZZLE } from '@/db/tokens'
import { TelemetryService } from '@/common/telemetry/telemetry.service'

// `pass` — nothing is known against this VM's exec endpoint; run the turn.
// `blocked` — the endpoint is known bad, or its one probe is already taken.
//             Refuse without touching it, and hand back the deadline.
// `probe` — this turn WON the fleet-wide probe; it is the only one allowed to
//           pay the handshake, and it must report the outcome.
export type SpriteExecDecision = 'pass' | 'blocked' | 'probe'

// How the endpoint said no. Kept to shapes that describe the exec endpoint
// itself — a bad prompt, a cancelled turn or an agent crash say nothing about
// whether the VM can be reached, and quarantining on them would take healthy
// capacity out of the turn path.
//
// The first three ARE RunnerExecFailureClass, spelled the same on purpose: the
// runner inspect is what usually reports one, and a vocabulary that renamed the
// same fact on the way in would make one incident read as two in telemetry.
// `probe_failed` is the only member no classifier can produce — it belongs to
// this service's own no-op probe, the one command it is safe to run at all.
export type SpriteExecFailureClass =
    | 'handshake_5xx'
    | 'transport_error'
    | 'timeout'
    | 'probe_failed'

export interface SpriteExecAdmission {
    hostId: string
    decision: SpriteExecDecision
    // When a blocked turn may come back. Null on `pass` and on `probe`.
    retryAt: Date | null
    // Only a `probe` admission carries one: the exact deadline this turn wrote
    // into the column. It is the probe's proof of ownership — recordProbe
    // compares it back and does nothing if it no longer matches.
    lease: Date | null
}

export interface SpriteExecFailure {
    hostId: string
    failureClass: SpriteExecFailureClass
    upstreamStatus?: number | null
}

export interface SpriteExecProbeResult {
    hostId: string
    ok: boolean
    lease: Date
}

export interface SpriteExecProbeRecord {
    outcome: 'recorded' | 'not_owner' | 'unavailable'
    retryAt: Date | null
}

export const SPRITE_EXEC_UNAVAILABLE_EVENT = 'sprite_exec.unavailable'
export const SPRITE_EXEC_BLOCKED_EVENT = 'sprite_exec.blocked'
export const SPRITE_EXEC_PROBE_EVENT = 'sprite_exec.probe'
const SPRITE_EXEC_RECOVERED_EVENT = 'sprite_exec.recovered'

// How long a failing exec endpoint stays out of the turn path. A sprite backend
// that 502s the WebSocket upgrade stays that way for minutes (#730), so a
// window measured in seconds still saves most of the wasted handshakes while
// keeping a recovered VM's return cheap.
export const DEFAULT_SPRITE_EXEC_COOLDOWN_MS = 60_000
// Long enough to cover one probe end to end, short enough that a prober whose
// instance is deployed over mid-turn delays recovery by one lease, not forever.
export const DEFAULT_SPRITE_EXEC_PROBE_LEASE_MS = 20_000
// The probe's own budget. A dead endpoint answers fast or not at all; anything
// longer is a hung handshake, which is the very thing being measured.
export const DEFAULT_SPRITE_EXEC_PROBE_TIMEOUT_MS = 5_000
// The budget for the turn's FIRST exec — the runner inspect, which is the exec
// a dead endpoint surfaces on. It has to be a health budget rather than a
// command budget: the 60s it used to get is why the failure took 39s to be
// noticed and then 39s more to be re-proven by the direct fallback (#730).
//
// Not the 5s above, and deliberately: this exec also WAKES a suspended VM and
// runs a login shell, where the probe only ever meets a sprite something else
// already woke. 15s is the bound the provisioning no-op probe settled on for
// the same staging fault (SANDBOX_EXEC_PROBE_TIMEOUT_MS) — several times what a
// healthy inspect needs, well under the 36–39s the fault takes to surface.
export const DEFAULT_SPRITE_EXEC_FIRST_EXEC_TIMEOUT_MS = 15_000

// Read per call rather than frozen at import: these are operational knobs an
// operator flips on a running fleet, and freezing them also makes them
// untestable (same reasoning as the turn budgets). Garbage falls back to the
// default rather than to 0 — a cooldown of 0 is an always-open breaker nobody
// asked for.
const envMs = (name: string, fallback: number): number => {
    const raw = process.env[name]
    if (raw === undefined || raw.trim() === '') return fallback
    const parsed = Number(raw)
    if (!Number.isSafeInteger(parsed) || parsed <= 0) return fallback
    return parsed
}

export const spriteExecHealthConfig = (): {
    cooldownMs: number
    probeLeaseMs: number
    probeTimeoutMs: number
    firstExecTimeoutMs: number
} => {
    const probeTimeoutMs = envMs(
        'MF_SPRITE_EXEC_PROBE_TIMEOUT_MS',
        DEFAULT_SPRITE_EXEC_PROBE_TIMEOUT_MS
    )
    const probeLeaseMs = Math.max(
        envMs(
            'MF_SPRITE_EXEC_PROBE_LEASE_MS',
            DEFAULT_SPRITE_EXEC_PROBE_LEASE_MS
        ),
        probeTimeoutMs + 1_000
    )
    return {
        cooldownMs: Math.max(
            envMs(
                'MF_SPRITE_EXEC_COOLDOWN_MS',
                DEFAULT_SPRITE_EXEC_COOLDOWN_MS
            ),
            probeLeaseMs + 1_000
        ),
        probeLeaseMs,
        probeTimeoutMs,
        firstExecTimeoutMs: envMs(
            'MF_SPRITE_EXEC_FIRST_EXEC_TIMEOUT_MS',
            DEFAULT_SPRITE_EXEC_FIRST_EXEC_TIMEOUT_MS
        )
    }
}

// A durable, cross-instance breaker over one sandbox VM's exec endpoint.
//
// It exists because a sprite backend that 502s every WebSocket upgrade is not a
// per-request accident: it stays broken for minutes, and every turn routed at
// that VM pays a full handshake to rediscover it (#730). The API runs on more
// than one instance, so an in-memory flag would let instance B walk the next
// turn straight back into the endpoint instance A just proved dead.
//
// The verdict therefore lives in the column that already means exactly this —
// runtime_hosts.exec_cooldown_until, shared with the provisioning readiness
// quarantine:
//
//   null    healthy. The common case: one read per turn and no write at all.
//   future  unavailable, or a probe lease held by some turn somewhere. Refuse.
//   past    the window lapsed. Permission for exactly ONE turn fleet-wide to go
//           look — never proof on its own that the endpoint came back.
//
// Correctness is in the WHERE clauses and nowhere else. Instances racing the
// same host serialize on the row lock and re-check the predicate against the
// winner's committed value, so there is one prober rather than one per
// instance — two winners would mean two handshakes against an endpoint that is
// still bad, which is the cost this whole thing exists to avoid.
@Injectable()
export class SpriteExecHealthService {
    private readonly logger = new Logger(SpriteExecHealthService.name)

    constructor(
        @Inject(DRIZZLE) private readonly db: Database,
        @Optional() private readonly telemetry?: TelemetryService
    ) {}

    // Decide whether a turn may use this host's exec endpoint. Returns null for
    // anything this breaker does not own — no host, a deleted one, or a daemon
    // that reaches its machine over the reverse websocket instead — so callers
    // can tell "not mine" apart from "mine and healthy".
    async admit(
        hostId: string | null | undefined
    ): Promise<SpriteExecAdmission | null> {
        if (!hostId) return null
        const pass: SpriteExecAdmission = {
            hostId,
            decision: 'pass',
            retryAt: null,
            lease: null
        }
        try {
            const host = await this.read(hostId)
            if (!host) return null
            if (!host.execCooldownUntil) return pass
            if (host.execCooldownUntil.getTime() > Date.now())
                return this.refuse(hostId, host)

            // The one-winner primitive. The predicate IS the guard: concurrent
            // callers serialize on the row lock and re-evaluate it against the
            // winner's committed lease, which is in the future, so they match
            // zero rows.
            //
            // The lease is a JS Date rather than clock_timestamp() because the
            // value IS the probe's token and recordProbe compares it back
            // against the column. exec_cooldown_until carries no precision cap,
            // so a µs value written in SQL would return through the driver
            // rounded to ms and could never match itself again — the same trap
            // active_accrual_since documents from the other side.
            const lease = new Date(
                Date.now() + spriteExecHealthConfig().probeLeaseMs
            )
            const claimed = await this.db
                .update(runtimeHosts)
                .set({ execCooldownUntil: lease, updatedAt: new Date() })
                .where(
                    and(
                        eq(runtimeHosts.id, hostId),
                        eq(runtimeHosts.kind, 'sandbox'),
                        isNotNull(runtimeHosts.execCooldownUntil),
                        lte(
                            runtimeHosts.execCooldownUntil,
                            sql`clock_timestamp()`
                        )
                    )
                )
                .returning({ id: runtimeHosts.id })
            if (claimed.length > 0) {
                this.telemetry?.event(SPRITE_EXEC_PROBE_EVENT, {
                    ...this.hostAttrs(hostId, host.spriteName),
                    leaseMs: spriteExecHealthConfig().probeLeaseMs
                })
                return { hostId, decision: 'probe', retryAt: null, lease }
            }

            // Losing the claim means somebody else moved the column, and that
            // is not the same as them taking the probe: a successful prober
            // clears it. Re-read rather than blocking on a stale snapshot,
            // which would refuse a turn against a host already proven healthy.
            const current = await this.read(hostId)
            if (!current?.execCooldownUntil) return pass
            return this.refuse(hostId, current)
        } catch (err) {
            // Fail OPEN, never closed. A breaker that cannot read its own state
            // must never become the reason a healthy turn is refused; a missed
            // refusal costs one handshake, which is exactly the behaviour
            // without this service at all.
            this.warn('admit', hostId, err)
            return pass
        }
    }

    // Read-only verdict for the paths that CHOOSE a host rather than run a turn
    // on one (placement, co-residence reuse). Every non-null state counts as
    // unavailable, a lapsed one included: a lapsed window is permission for one
    // turn to go check, and a placement decision is not that check. It never
    // claims the lease — spending the fleet's one probe on host selection would
    // leave the turn that follows with nothing left to claim.
    async isKnownUnavailable(
        hostId: string | null | undefined
    ): Promise<boolean> {
        if (!hostId) return false
        try {
            const host = await this.read(hostId)
            return Boolean(host?.execCooldownUntil)
        } catch (err) {
            this.warn('placement check', hostId, err)
            return false
        }
    }

    // A turn proved this VM's exec endpoint unusable. One conditional statement
    // so instances reporting the same bad endpoint cannot lose each other's
    // writes.
    async markUnavailable(failure: SpriteExecFailure): Promise<Date | null> {
        const { cooldownMs } = spriteExecHealthConfig()
        const until = new Date(Date.now() + cooldownMs)
        try {
            const [row] = await this.db
                .update(runtimeHosts)
                .set({
                    // greatest() ignores NULLs, so one expression both arms a
                    // clean host and extends an armed one — and never shortens
                    // it. The provisioning readiness quarantine writes minutes
                    // to this column on a different failure; releasing a
                    // quarantined VM early because a chat turn wrote a shorter
                    // window would put it straight back into placement.
                    // ms-precision ISO string, NOT a raw Date: postgres-js binds
                    // a JS Date interpolated into a sql`` fragment as text and
                    // crashes in Buffer.byteLength.
                    execCooldownUntil: sql`greatest(${runtimeHosts.execCooldownUntil}, ${until.toISOString()}::timestamptz)`,
                    updatedAt: new Date()
                })
                .where(
                    and(
                        eq(runtimeHosts.id, failure.hostId),
                        eq(runtimeHosts.kind, 'sandbox')
                    )
                )
                .returning({
                    spriteName: runtimeHosts.spriteName,
                    until: runtimeHosts.execCooldownUntil
                })
            if (!row) return null
            this.telemetry?.event(SPRITE_EXEC_UNAVAILABLE_EVENT, {
                ...this.hostAttrs(failure.hostId, row.spriteName),
                failureClass: failure.failureClass,
                upstreamStatus: failure.upstreamStatus ?? undefined,
                cooldownMs,
                retryInMs: row.until
                    ? row.until.getTime() - Date.now()
                    : undefined
            })
            return row.until
        } catch (err) {
            this.warn('unavailable', failure.hostId, err)
            return null
        }
    }

    // The probe answered. Conditional on the lease this turn was given, so a
    // prober that comes back after its lease lapsed — the slow instance the
    // expiry path exists to route around — cannot clear or re-arm the window a
    // newer prober now owns. Its result describes an endpoint state somebody
    // else has already moved past, so it does nothing at all.
    async recordProbe(
        result: SpriteExecProbeResult
    ): Promise<SpriteExecProbeRecord> {
        const { cooldownMs } = spriteExecHealthConfig()
        try {
            const [row] = await this.db
                .update(runtimeHosts)
                .set({
                    execCooldownUntil: result.ok
                        ? null
                        : new Date(Date.now() + cooldownMs),
                    updatedAt: new Date()
                })
                .where(
                    and(
                        eq(runtimeHosts.id, result.hostId),
                        eq(runtimeHosts.kind, 'sandbox'),
                        eq(runtimeHosts.execCooldownUntil, result.lease)
                    )
                )
                .returning({
                    spriteName: runtimeHosts.spriteName,
                    retryAt: runtimeHosts.execCooldownUntil
                })
            if (!row) return { outcome: 'not_owner', retryAt: null }
            const attrs = this.hostAttrs(result.hostId, row.spriteName)
            if (result.ok)
                this.telemetry?.event(SPRITE_EXEC_RECOVERED_EVENT, attrs)
            else
                this.telemetry?.event(SPRITE_EXEC_UNAVAILABLE_EVENT, {
                    ...attrs,
                    failureClass: 'probe_failed',
                    cooldownMs
                })
            return { outcome: 'recorded', retryAt: row.retryAt }
        } catch (err) {
            // Bookkeeping, and it runs after the turn's outcome is already
            // decided: a throw here would turn a successful probe into a failed
            // turn.
            this.warn('probe', result.hostId, err)
            return { outcome: 'unavailable', retryAt: null }
        }
    }

    private async read(hostId: string): Promise<{
        spriteName: string | null
        execCooldownUntil: Date | null
    } | null> {
        const [row] = await this.db
            .select({
                spriteName: runtimeHosts.spriteName,
                execCooldownUntil: runtimeHosts.execCooldownUntil
            })
            .from(runtimeHosts)
            .where(
                and(
                    eq(runtimeHosts.id, hostId),
                    eq(runtimeHosts.kind, 'sandbox')
                )
            )
            .limit(1)
        return row ?? null
    }

    private refuse(
        hostId: string,
        host: { spriteName: string | null; execCooldownUntil: Date | null }
    ): SpriteExecAdmission {
        const retryAt = host.execCooldownUntil
        this.telemetry?.event(SPRITE_EXEC_BLOCKED_EVENT, {
            ...this.hostAttrs(hostId, host.spriteName),
            retryInMs: retryAt ? retryAt.getTime() - Date.now() : undefined
        })
        return { hostId, decision: 'blocked', retryAt, lease: null }
    }

    // Operational identifiers only. Nothing a turn carries — prompt text, the
    // exec token, the endpoint URL — belongs in an event about a machine.
    private hostAttrs(
        hostId: string,
        spriteName: string | null
    ): Record<string, string | undefined> {
        return { hostId, spriteName: spriteName ?? undefined }
    }

    // Breaker bookkeeping never changes a turn's outcome: the terminal the user
    // sees is decided by the time these run, so a dead write costs accuracy,
    // not the answer.
    private warn(op: string, hostId: string, err: unknown): void {
        this.logger.warn(
            `sprite exec health ${op} failed host=${hostId} class=${err instanceof Error && err.name ? err.name : typeof err}`
        )
    }
}
