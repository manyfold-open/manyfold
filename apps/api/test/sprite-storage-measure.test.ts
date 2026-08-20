import 'tsconfig-paths/register'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    agents,
    runtimeHosts,
    type Agent,
    type RuntimeHostRow,
    type SandboxStorageBreakdown
} from '@manyfold/db'
import { SpriteStorageService } from '@/modules/agents/sprite-storage/sprite-storage.service'

const MEASURED_AT = new Date(Date.UTC(2026, 7, 1, 12, 0, 0))

const hostRow = (over: Record<string, unknown> = {}): RuntimeHostRow =>
    ({
        id: 'sbx-1',
        userId: 'u-1',
        kind: 'sandbox',
        accountId: 'acc-1',
        spriteName: 'nca-user-abc-main',
        spriteStatus: 'running',
        storageBytes: null,
        storageMeasuredAt: null,
        storageBreakdown: null,
        ...over
    }) as RuntimeHostRow

const agentRow = (over: Record<string, unknown> = {}): Agent =>
    ({
        id: 'agt-1',
        framework: 'claude-code',
        workspacePath: '/home/sprite/.manyfold/workspaces/agt-1',
        mountPath: '/home/sprite/.manyfold/workspaces/agt-1',
        ...over
    }) as Agent

const makeDb = (host: RuntimeHostRow | null, hostAgents: Agent[] = []) => {
    const updates: Array<{ table: unknown; set: Record<string, unknown> }> = []
    return {
        updates,
        select: () => ({
            from: (table: unknown) => ({
                where: () => {
                    const rows =
                        table === runtimeHosts ? (host ? [host] : []) : hostAgents
                    return Object.assign(Promise.resolve(rows), {
                        limit: async () => rows
                    })
                }
            })
        }),
        update: (table: unknown) => ({
            set: (s: Record<string, unknown>) => ({
                where: () => {
                    updates.push({ table, set: s })
                    return Promise.resolve(undefined)
                }
            })
        })
    }
}

const makeService = (
    db: ReturnType<typeof makeDb>,
    breakdown: SandboxStorageBreakdown
) => {
    const events: Array<{ name: string; attrs: Record<string, unknown> }> = []
    const errors: Array<{ name: string; message: string }> = []
    const svc = new SpriteStorageService(
        db as never,
        {} as never,
        {
            event: (name: string, attrs: Record<string, unknown>) => {
                events.push({ name, attrs })
            },
            error: (name: string, err: Error) => {
                errors.push({ name, message: err.message })
            }
        } as never
    )
    ;(
        svc as unknown as {
            measureNow: () => Promise<SandboxStorageBreakdown>
        }
    ).measureNow = async () => breakdown
    return { svc, events, errors }
}

const STALE: SandboxStorageBreakdown = {
    vmUsedBytes: 0,
    homes: [],
    workspaces: [],
    measuredVia: 'stale'
}

const hostUpdates = (db: ReturnType<typeof makeDb>) =>
    db.updates.filter((u) => u.table === runtimeHosts)
const agentUpdates = (db: ReturnType<typeof makeDb>) =>
    db.updates.filter((u) => u.table === agents)

// WHY: this is the defect. A measurement that read nothing used to be written
// as storage_bytes = 0 with a fresh storage_measured_at, which the meter, the
// quota check and the drill-down all read as a confidently empty sandbox.
test('a stale measurement writes nothing and is reported as a failure', async () => {
    const db = makeDb(hostRow(), [agentRow()])
    const { svc, events, errors } = makeService(db, STALE)

    await svc.measureHostIfDue('sbx-1')

    assert.equal(db.updates.length, 0, 'no row may be written')
    assert.deepEqual(
        events.map((e) => e.name),
        [],
        'must not report itself as a successful measurement'
    )
    assert.equal(errors.length, 1)
    assert.equal(errors[0].name, 'sprite_storage_measure_failed')
})

// WHY: the meter regression users actually saw — a host holding 5 GB dropping
// to 0 B (with a fresh timestamp) on one failed measurement.
test('a host that already measured non-zero keeps its reading when a measurement fails', async () => {
    const db = makeDb(
        hostRow({
            storageBytes: 5_000_000_000,
            storageMeasuredAt: MEASURED_AT,
            storageBreakdown: {
                vmUsedBytes: 5_000_000_000,
                homes: [],
                workspaces: [{ agentId: 'agt-1', bytes: 1_000_000_000 }],
                measuredVia: 'df'
            }
        }),
        [agentRow()]
    )
    const { svc, errors } = makeService(db, STALE)

    await svc.measureHostIfDue('sbx-1')

    assert.equal(hostUpdates(db).length, 0)
    assert.equal(agentUpdates(db).length, 0)
    assert.equal(errors.length, 1)
})

test('a real df measurement writes the host meter and the per-agent drill-down', async () => {
    const db = makeDb(hostRow(), [agentRow()])
    const { svc, events, errors } = makeService(db, {
        vmUsedBytes: 7_000_000_000,
        homes: [{ framework: 'claude-code', bytes: 400_000_000 }],
        workspaces: [{ agentId: 'agt-1', bytes: 1_200_000_000 }],
        measuredVia: 'df'
    })

    await svc.measureHostIfDue('sbx-1')

    assert.equal(errors.length, 0)
    assert.equal(hostUpdates(db).length, 1)
    assert.equal(hostUpdates(db)[0].set.storageBytes, 7_000_000_000)
    assert.ok(hostUpdates(db)[0].set.storageMeasuredAt instanceof Date)
    assert.equal(agentUpdates(db).length, 1)
    assert.equal(agentUpdates(db)[0].set.storageBytes, 1_200_000_000)
    assert.deepEqual(
        events.map((e) => e.name),
        ['sprite_storage_measured']
    )
})

// WHY: a bare standalone sandbox has no workspace to du. Its rootfs reading is
// still the billable figure and must reach the meter.
test('a bare sandbox persists its rootfs reading with no agent rows', async () => {
    const db = makeDb(hostRow(), [])
    const { svc, errors } = makeService(db, {
        vmUsedBytes: 4_200_000_000,
        homes: [],
        workspaces: [],
        measuredVia: 'df'
    })

    await svc.measureHostIfDue('sbx-1')

    assert.equal(errors.length, 0)
    assert.equal(hostUpdates(db).length, 1)
    assert.equal(hostUpdates(db)[0].set.storageBytes, 4_200_000_000)
    assert.equal(agentUpdates(db).length, 0)
})

// WHY: same fabricated-zero problem one grain down — an agent whose du produced
// nothing must keep its previous reading rather than be written to 0.
test('an agent whose workspace du produced nothing is left untouched', async () => {
    const db = makeDb(hostRow(), [agentRow(), agentRow({ id: 'agt-2' })])
    const { svc } = makeService(db, {
        vmUsedBytes: 7_000_000_000,
        homes: [],
        workspaces: [{ agentId: 'agt-2', bytes: 800_000_000 }],
        measuredVia: 'df'
    })

    await svc.measureHostIfDue('sbx-1')

    assert.equal(agentUpdates(db).length, 1)
    assert.equal(agentUpdates(db)[0].set.storageBytes, 800_000_000)
})
