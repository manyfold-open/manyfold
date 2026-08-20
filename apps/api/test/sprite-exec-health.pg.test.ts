import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import {
    createDb,
    plans,
    runtimeHosts,
    users,
    type Database
} from '@manyfold/db'
import { withScratchDatabase } from '../scripts/scratch-db'
import type { TelemetryService } from '../src/common/telemetry/telemetry.service'
import {
    SPRITE_EXEC_BLOCKED_EVENT,
    SPRITE_EXEC_PROBE_EVENT,
    SPRITE_EXEC_UNAVAILABLE_EVENT,
    SpriteExecHealthService,
    type SpriteExecAdmission
} from '../src/modules/agents/sprite-exec-health/sprite-exec-health.service'
import { AgentRuntimesService } from '../src/modules/agent-runtimes/agent-runtimes.service'

// #730. A sprite whose exec endpoint 502s every WebSocket upgrade stays broken
// for minutes, and the API runs on more than one instance. Two properties are
// properties of the SQL and of nothing else, so they are proven here against a
// real Postgres with several services on their OWN pools standing in for
// several API instances:
//
//   * the unhealthy verdict is SHARED. An in-memory flag passes any
//     single-process test and still lets instance B walk the next turn straight
//     back into the endpoint instance A just proved dead.
//   * exactly ONE turn in the whole fleet probes a cooled-down host. Two winners
//     mean two turns paying the handshake against an endpoint that is still bad.
//
// Each test creates, migrates and drops a throwaway database, because the rows
// under test are runtime_hosts rows and a shared DATABASE_URL would put real
// ones in reach. Run per-file:
//   RUN_PG_E2E=1 PG_TEST_SCRATCH=1 \
//     PG_TEST_ADMIN_URL=postgres://postgres:postgres@127.0.0.1:5432/postgres \
//     node --import tsx --test test/sprite-exec-health.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

interface TelemetryEvent {
    name: string
    attrs: Record<string, unknown>
}

// One API instance: its own pool, its own service.
interface Instance {
    db: Database
    health: SpriteExecHealthService
}

interface Harness {
    fleet: Instance[]
    first: Instance
    sick: string
    healthy: string
    daemon: string
    events: () => TelemetryEvent[]
    named: (name: string) => TelemetryEvent[]
    cooldownUntil: (hostId: string) => Promise<Date | null>
    setCooldown: (hostId: string, at: Date | null) => Promise<void>
}

const closeDb = async (db: Database): Promise<void> => {
    const client = (
        db as unknown as { $client?: { end?: () => Promise<void> } }
    ).$client
    if (client?.end) await client.end()
}

const spawnInstance = (url: string, log: TelemetryEvent[]): Instance => {
    const db = createDb(url, { max: 2 })
    const telemetry = {
        event: (name: string, attrs: Record<string, unknown> = {}): void => {
            log.push({ name, attrs })
        }
    } as unknown as TelemetryService
    return { db, health: new SpriteExecHealthService(db, telemetry) }
}

const withHarness = async (
    body: (harness: Harness) => Promise<void>,
    fleetSize = 3
): Promise<void> =>
    withScratchDatabase('execheal', async ({ url }) => {
        const log: TelemetryEvent[] = []
        const fleet = Array.from({ length: fleetSize }, () =>
            spawnInstance(url, log)
        )
        const db = fleet[0].db
        const sfx = randomBytes(6).toString('hex')
        const ids = {
            plan: `plan_pgtest_${sfx}`,
            user: `user_pgtest_${sfx}`,
            sick: `rh_pgtest_sick_${sfx}`,
            healthy: `rh_pgtest_ok_${sfx}`,
            daemon: `rh_pgtest_dmn_${sfx}`
        }
        try {
            await db.insert(plans).values({
                id: ids.plan,
                name: `pgtest-${sfx}`,
                maxAgentsProvisioned: 3,
                maxConcurrentActive: 1,
                maxStorageGb: 3
            })
            await db.insert(users).values({
                id: ids.user,
                email: `${sfx}@pgtest.local`,
                planId: ids.plan
            })
            await db.insert(runtimeHosts).values([
                {
                    id: ids.sick,
                    userId: ids.user,
                    kind: 'sandbox',
                    name: `pgtest-sick-${sfx}`,
                    spriteName: `art-sick-${sfx}`
                },
                {
                    id: ids.healthy,
                    userId: ids.user,
                    kind: 'sandbox',
                    name: `pgtest-ok-${sfx}`,
                    spriteName: `art-ok-${sfx}`
                },
                {
                    id: ids.daemon,
                    userId: ids.user,
                    kind: 'daemon',
                    name: `pgtest-daemon-${sfx}`,
                    daemonUuid: `uuid-${sfx}`
                }
            ])
            await body({
                fleet,
                first: fleet[0],
                sick: ids.sick,
                healthy: ids.healthy,
                daemon: ids.daemon,
                events: () => log,
                named: (name) => log.filter((event) => event.name === name),
                cooldownUntil: async (hostId) => {
                    const [row] = await db
                        .select({ at: runtimeHosts.execCooldownUntil })
                        .from(runtimeHosts)
                        .where(eq(runtimeHosts.id, hostId))
                        .limit(1)
                    return row?.at ?? null
                },
                setCooldown: async (hostId, at) => {
                    await db
                        .update(runtimeHosts)
                        .set({ execCooldownUntil: at })
                        .where(eq(runtimeHosts.id, hostId))
                }
            })
        } finally {
            for (const instance of fleet) await closeDb(instance.db)
        }
    })

const markSick = async (instance: Instance, hostId: string): Promise<void> => {
    await instance.health.markUnavailable({
        hostId,
        failureClass: 'handshake_5xx',
        upstreamStatus: 502
    })
}

// What the clock does a minute later, without spending a minute on it.
const elapseCooldown = (h: Harness, hostId: string): Promise<void> =>
    h.setCooldown(hostId, new Date(Date.now() - 1_000))

// The token a probe must hand back. Reading it through here keeps every
// recordProbe call honest about which lease it is reporting against.
const leaseOf = (admission: SpriteExecAdmission | null): Date => {
    const lease = admission?.lease
    if (admission?.decision !== 'probe' || !lease)
        throw new Error(
            `expected a probe admission, got ${admission?.decision ?? 'null'}`
        )
    return lease
}

test(
    'an unhealthy exec endpoint is shared by every API instance',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const [a, b, c] = h.fleet

            await markSick(a, h.sick)

            // B and C never saw the failure. The row is the only thing that can
            // tell them, and without it they each walk the next turn into the
            // same dead endpoint.
            for (const instance of [b, c]) {
                const admission = await instance.health.admit(h.sick)
                assert.equal(admission?.decision, 'blocked')
                assert.ok(
                    (admission?.retryAt?.getTime() ?? 0) > Date.now(),
                    'a blocked turn is told when to come back'
                )
            }
            // A sibling VM on the same user and the same account is a different
            // machine: quarantining it too would take healthy capacity out of
            // the turn path over someone else's failure.
            assert.equal((await c.health.admit(h.healthy))?.decision, 'pass')
        })
)

test(
    'a cooled-down host admits exactly one probe across the fleet',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            await markSick(h.first, h.sick)
            await elapseCooldown(h, h.sick)

            const admissions = await Promise.all(
                h.fleet.map((instance) => instance.health.admit(h.sick))
            )

            const probes = admissions.filter((a) => a?.decision === 'probe')
            assert.equal(probes.length, 1, 'one prober, fleet-wide')
            // Everyone else is refused rather than passed: a lapsed cooldown is
            // permission to CHECK, never proof the endpoint came back.
            assert.equal(
                admissions.filter((a) => a?.decision === 'blocked').length,
                h.fleet.length - 1
            )
            assert.equal(
                admissions.filter((a) => a?.decision === 'pass').length,
                0
            )
            // The winner holds a lease, so the losers see a future deadline
            // rather than an expired one they could claim in turn.
            const lease = await h.cooldownUntil(h.sick)
            assert.ok((lease?.getTime() ?? 0) > Date.now())
        }, 4)
)

test(
    'only a successful safe probe returns a host to the turn path',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const [a, b] = h.fleet
            await markSick(a, h.sick)
            await elapseCooldown(h, h.sick)
            const probe = await a.health.admit(h.sick)
            assert.equal(probe?.decision, 'probe')

            await a.health.recordProbe({
                hostId: h.sick,
                ok: true,
                lease: leaseOf(probe)
            })

            // Cleared, not merely lapsed: the next turn on any instance costs
            // nothing at all.
            assert.equal(await h.cooldownUntil(h.sick), null)
            assert.equal((await b.health.admit(h.sick))?.decision, 'pass')
            assert.equal((await a.health.admit(h.sick))?.decision, 'pass')
        })
)

test(
    'a failed probe re-arms the cooldown instead of releasing the host',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const [a, b] = h.fleet
            await markSick(a, h.sick)
            await elapseCooldown(h, h.sick)
            const probe = await a.health.admit(h.sick)
            assert.equal(probe?.decision, 'probe')

            await a.health.recordProbe({
                hostId: h.sick,
                ok: false,
                lease: leaseOf(probe)
            })

            const at = await h.cooldownUntil(h.sick)
            assert.ok((at?.getTime() ?? 0) > Date.now(), 're-armed')
            assert.equal((await b.health.admit(h.sick))?.decision, 'blocked')
        })
)

test(
    'a prober that dies mid-probe delays recovery by one lease, not forever',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const [a, b] = h.fleet
            await markSick(a, h.sick)
            await elapseCooldown(h, h.sick)
            assert.equal((await a.health.admit(h.sick))?.decision, 'probe')
            // A never reports: its instance was deployed over mid-turn.
            assert.equal((await b.health.admit(h.sick))?.decision, 'blocked')

            await elapseCooldown(h, h.sick)

            // The lease is a deadline, not a lock: whoever comes next takes it.
            assert.equal((await b.health.admit(h.sick))?.decision, 'probe')
        })
)

test(
    'a lapsed prober cannot overwrite the lease that replaced it',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const [a, b] = h.fleet
            await markSick(a, h.sick)
            await elapseCooldown(h, h.sick)
            // A takes the probe and then stalls — a hung handshake against the
            // very endpoint being measured is the expected way for this to go.
            const stale = leaseOf(await a.health.admit(h.sick))
            await elapseCooldown(h, h.sick)
            const live = leaseOf(await b.health.admit(h.sick))
            assert.notEqual(
                stale.getTime(),
                live.getTime(),
                'the second prober holds a lease of its own'
            )

            // A's handshake finally returns, describing an endpoint state B has
            // already moved past. Without the token this would release a host
            // nobody has proven healthy...
            const staleSuccess = await a.health.recordProbe({
                hostId: h.sick,
                ok: true,
                lease: stale
            })
            assert.equal(staleSuccess.outcome, 'not_owner')
            assert.equal(
                (await h.cooldownUntil(h.sick))?.getTime(),
                live.getTime(),
                'a lapsed lease cannot clear the lease that replaced it'
            )

            // ...and the mirror image: re-arming would push B's deadline out on
            // evidence a minute old, hiding a recovery that already happened.
            const staleFailure = await a.health.recordProbe({
                hostId: h.sick,
                ok: false,
                lease: stale
            })
            assert.equal(staleFailure.outcome, 'not_owner')
            assert.equal(
                (await h.cooldownUntil(h.sick))?.getTime(),
                live.getTime(),
                'a lapsed lease cannot re-arm the lease that replaced it'
            )

            // The live holder still decides, and B is who the fleet is waiting on.
            await b.health.recordProbe({
                hostId: h.sick,
                ok: true,
                lease: live
            })
            assert.equal(await h.cooldownUntil(h.sick), null)
        })
)

test(
    'choosing a host is not the one turn that gets to check it',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            await markSick(h.first, h.sick)
            await elapseCooldown(h, h.sick)
            const lapsed = await h.cooldownUntil(h.sick)

            // Placement reads a lapsed window as unavailable: it is permission
            // for one turn to go look, and nothing here is that look.
            assert.equal(await h.first.health.isKnownUnavailable(h.sick), true)
            assert.equal(
                (await h.cooldownUntil(h.sick))?.getTime(),
                lapsed?.getTime(),
                'a read-only check leaves the probe for the turn that follows'
            )
            assert.equal(
                (await h.first.health.admit(h.sick))?.decision,
                'probe'
            )

            assert.equal(
                await h.first.health.isKnownUnavailable(h.healthy),
                false
            )
            assert.equal(
                await h.first.health.isKnownUnavailable(h.daemon),
                false
            )
            assert.equal(await h.first.health.isKnownUnavailable(null), false)
        })
)

test(
    'a chat cooldown never shortens a longer provisioning quarantine',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            // What SpritesProvisioner writes when a placement readiness probe
            // fails: a 10-minute quarantine on the same column.
            const quarantine = new Date(Date.now() + 10 * 60_000)
            await h.setCooldown(h.sick, quarantine)

            await markSick(h.first, h.sick)

            const at = await h.cooldownUntil(h.sick)
            assert.equal(
                at?.getTime(),
                quarantine.getTime(),
                'the shorter chat window must not release a quarantined host early'
            )
        })
)

test(
    'a delayed provisioning quarantine never shortens a newer deadline',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            const service = new AgentRuntimesService(h.first.db, {
                event: () => {}
            } as never)
            const newer = new Date(Date.now() + 10 * 60_000)
            const stale = new Date(Date.now() + 60_000)
            await h.setCooldown(h.sick, newer)

            await service.markSandboxHostExecCooldown(h.sick, stale)

            assert.equal(
                (await h.cooldownUntil(h.sick))?.getTime(),
                newer.getTime()
            )
        })
)

test(
    'a host that is not a sandbox is not this breaker to hold',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            // A daemon runtime reaches its machine over the reverse websocket,
            // not over a sprite exec: nothing here describes it.
            assert.equal(await h.first.health.admit(h.daemon), null)
            assert.equal(await h.first.health.admit(null), null)
            assert.equal(await h.first.health.admit('rh_missing'), null)

            await markSick(h.first, h.daemon)
            assert.equal(await h.cooldownUntil(h.daemon), null)
        })
)

test(
    'the shared verdict is reported without leaking turn content',
    { skip: !RUN },
    async () =>
        withHarness(async (h) => {
            await markSick(h.first, h.sick)
            await h.first.health.admit(h.sick)
            await elapseCooldown(h, h.sick)
            const probe = await h.first.health.admit(h.sick)
            await h.first.health.recordProbe({
                hostId: h.sick,
                ok: true,
                lease: leaseOf(probe)
            })

            assert.equal(h.named(SPRITE_EXEC_UNAVAILABLE_EVENT).length, 1)
            assert.equal(h.named(SPRITE_EXEC_BLOCKED_EVENT).length, 1)
            assert.equal(h.named(SPRITE_EXEC_PROBE_EVENT).length, 1)
            const shipped = JSON.stringify(h.events())
            // Host and sprite identifiers are operational; a prompt, a token or
            // an endpoint URL is not, and none of them are in scope here.
            assert.doesNotMatch(shipped, /ldt_|sk-|wss?:\/\/|authorization/i)
        })
)
