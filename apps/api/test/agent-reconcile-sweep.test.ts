import test from 'node:test'
import assert from 'node:assert/strict'
import { AgentReconcileSweepService } from '../src/modules/agents/reconcile/agent-reconcile-sweep.service'

// #516: with list endpoints turned into pure reads, this leader-gated sweep
// is the convergence backstop — a bounded touch of awake service-framework
// runtimes (ADR-0037: presence is never written into agent rows).

const serviceRuntime = (id: string) => ({
    id,
    userId: 'u-1',
    name: 'main',
    framework: 'hermes',
    kind: 'sprites',
    status: 'ready'
})

const makeDb = (candidates: unknown[]) => {
    const updates: Array<{ set: Record<string, unknown> }> = []
    let awaitedSelects = 0
    const chain = () => {
        const b = Object.assign(
            Promise.resolve(candidates).then((rows) => {
                awaitedSelects += 1
                return rows.map((runtime) => ({ runtime }))
            }),
            {
                from: () => b,
                innerJoin: () => b,
                where: () => b,
                orderBy: () => b,
                limit: () => b
            }
        )
        return b
    }
    return {
        updates,
        awaited: () => awaitedSelects,
        select: () => chain(),
        update: () => ({
            set: (s: Record<string, unknown>) => ({
                where: async () => {
                    updates.push({ set: s })
                }
            })
        }),
        insert: () => {
            throw new Error('sweep must not insert')
        }
    }
}

const makeReconcile = () => {
    const touched: string[] = []
    return {
        touched,
        touchRuntime: (runtime: { id: string }) => {
            touched.push(runtime.id)
        }
    }
}

const makeLeases = (granted: boolean) => ({
    tryAcquireOrRenew: async () => granted,
    release: async () => {}
})

// Presence is never mirrored into agent rows (ADR-0037): the sweep writes
// nothing itself, it only touches the awake service runtimes.
test('runOnce writes nothing and touches every awake service runtime', async () => {
    const db = makeDb([serviceRuntime('rt-a'), serviceRuntime('rt-b')])
    const reconcile = makeReconcile()
    const svc = new AgentReconcileSweepService(db as never, reconcile as never)

    await svc.runOnce()

    assert.equal(db.updates.length, 0, 'the sweep has no set-based writes')
    assert.equal(db.awaited(), 1, 'one candidate read for the whole fleet')
    assert.deepEqual(
        reconcile.touched,
        ['rt-a', 'rt-b'],
        'every candidate service runtime gets a reconcile touch'
    )
})

test('tick without leadership does nothing', async () => {
    const db = makeDb([serviceRuntime('rt-a')])
    const reconcile = makeReconcile()
    const svc = new AgentReconcileSweepService(
        db as never,
        reconcile as never,
        makeLeases(false) as never
    )

    await svc.tick()

    assert.equal(db.updates.length, 0)
    assert.equal(reconcile.touched.length, 0)
})

test('tick with leadership sweeps, and again only after the interval', async () => {
    const db = makeDb([])
    const reconcile = makeReconcile()
    const svc = new AgentReconcileSweepService(
        db as never,
        reconcile as never,
        makeLeases(true) as never
    )

    await svc.tick()
    assert.equal(db.awaited(), 1, 'leader tick runs the sweep')

    await svc.tick()
    assert.equal(
        db.awaited(),
        1,
        'next tick inside the sweep interval only renews the lease'
    )
})
