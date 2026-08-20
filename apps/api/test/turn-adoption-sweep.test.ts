import assert from 'node:assert/strict'
import test from 'node:test'
import type { TurnExecutionRow } from '@manyfold/db'
import { TurnAdoptionService } from '../src/modules/chat/turn-adoption.service'

// One adoption legitimately re-polls a still-generating turn for MINUTES, so
// the sweep must claim-and-spawn instead of awaiting each adopt inline: an
// inline await would head-of-line-block every other orphan's recovery (and the
// session turn locks with them) behind the longest turn. These tests pin the
// concurrency contract; per-turn single ownership stays with the DB CAS claim.

const candidate = (messageId: string, adoptCount = 0): TurnExecutionRow => ({
    messageId,
    sessionId: `session-${messageId}`,
    agentId: 'agent-1',
    runtime: 'sprites',
    spriteName: 'sprite-1',
    execSessionId: null,
    upstreamTaskId: null,
    upstreamMessageId: null,
    ownerId: 'dead-owner',
    generation: 1,
    leaseExpiresAt: new Date(0),
    state: 'running',
    adoptCount,
    createdAt: new Date(0),
    updatedAt: new Date(0)
})

interface Harness {
    service: TurnAdoptionService
    sweep: () => Promise<void>
    claims: string[]
    adopts: string[]
    giveUps: string[]
    resolveAdopt: (messageId: string) => void
}

const makeHarness = (candidates: TurnExecutionRow[]): Harness => {
    process.env.MF_TURN_ADOPTION = '1'
    const claims: string[] = []
    const adopts: string[] = []
    const giveUps: string[] = []
    const pending = new Map<string, () => void>()
    const repo = {
        listAdoptableTurnExecutions: async () => candidates,
        claimTurnForAdoption: async (messageId: string) => {
            claims.push(messageId)
            const row = candidates.find((c) => c.messageId === messageId)
            if (!row) return null
            return { ...row, ownerId: 'me', state: 'adopting' as const }
        }
    }
    const service = new TurnAdoptionService(repo as never)
    service.registerHandler({
        adopt: (row) => {
            adopts.push(row.messageId)
            // Resolves only when the test releases it — models a long re-poll.
            return new Promise<void>((resolve) => {
                pending.set(row.messageId, resolve)
            })
        },
        giveUp: async (row) => {
            giveUps.push(row.messageId)
        }
    })
    delete process.env.MF_TURN_ADOPTION
    return {
        service,
        sweep: () =>
            (
                service as unknown as {
                    sweep: (source: string) => Promise<void>
                }
            ).sweep('test'),
        claims,
        adopts,
        giveUps,
        resolveAdopt: (messageId: string) => {
            pending.get(messageId)?.()
            pending.delete(messageId)
        }
    }
}

const settle = (): Promise<void> =>
    new Promise((resolve) => setImmediate(resolve))

test('sweep starts adoptions concurrently instead of awaiting each inline', async () => {
    const h = makeHarness([candidate('m1'), candidate('m2'), candidate('m3')])

    // The sweep must RETURN while every adopt is still unresolved: if it
    // awaited them inline, m2/m3 would be blocked behind m1's long re-poll.
    await h.sweep()

    assert.deepEqual(h.adopts, ['m1', 'm2', 'm3'])
    h.resolveAdopt('m1')
    h.resolveAdopt('m2')
    h.resolveAdopt('m3')
})

test('sweep caps in-flight adoptions and leaves overflow for the next tick', async () => {
    const rows = Array.from({ length: 12 }, (_, i) => candidate(`m${i}`))
    const h = makeHarness(rows)

    await h.sweep()

    assert.equal(h.adopts.length, 10, 'cap is 10 concurrent adoptions')
    // Overflow candidates were not claimed either — their lease stays lapsed
    // so a peer instance (or the next tick here) can pick them up.
    assert.equal(h.claims.length, 10)

    // A finished adoption (its turn went terminal and left the adoptable list)
    // frees a slot; the next sweep claims an overflow candidate.
    h.resolveAdopt('m0')
    rows.splice(
        rows.findIndex((r) => r.messageId === 'm0'),
        1
    )
    await settle()
    await h.sweep()
    assert.equal(h.adopts.length, 11)
    assert.equal(h.adopts[10], 'm10')
    for (const id of h.adopts) h.resolveAdopt(id)
})

test('sweep never re-claims a turn this instance is already adopting', async () => {
    const h = makeHarness([candidate('m1')])

    await h.sweep()
    await h.sweep()

    assert.deepEqual(
        h.adopts,
        ['m1'],
        'second sweep must skip the in-flight turn'
    )
    assert.deepEqual(h.claims, ['m1'])
    h.resolveAdopt('m1')
})

test('give-up on an exhausted turn is not starved by full adoption slots', async () => {
    const rows = Array.from({ length: 10 }, (_, i) => candidate(`m${i}`))
    // Listed LAST, after every slot is taken.
    rows.push(candidate('exhausted', 5))
    const h = makeHarness(rows)

    await h.sweep()

    assert.equal(h.adopts.length, 10)
    assert.deepEqual(h.giveUps, ['exhausted'])
    for (const id of h.adopts) h.resolveAdopt(id)
})

test('a claim won during shutdown is handed back instead of starting adoption', async () => {
    process.env.MF_TURN_ADOPTION = '1'
    const row = candidate('late')
    let resolveClaim: ((value: TurnExecutionRow) => void) | null = null
    let handoffs = 0
    let handedOffMessageId: string | null = null
    const adopted: string[] = []
    const repo = {
        listAdoptableTurnExecutions: async () => [row],
        claimTurnForAdoption: () =>
            new Promise<TurnExecutionRow>((resolve) => {
                resolveClaim = resolve
            }),
        handoffOwnedTurn: async (messageId: string) => {
            handoffs += 1
            handedOffMessageId = messageId
            return true
        }
    }
    const service = new TurnAdoptionService(repo as never)
    service.registerHandler({
        adopt: async (claimed) => {
            adopted.push(claimed.messageId)
        },
        giveUp: async () => undefined
    })
    delete process.env.MF_TURN_ADOPTION

    const startSweep = (
        service as unknown as {
            startSweep: (source: string) => void
        }
    ).startSweep
    startSweep.call(service, 'test')
    await settle()
    assert.ok(resolveClaim)
    const stopping = service.stopClaiming()
    const completeClaim = resolveClaim as
        | ((value: TurnExecutionRow) => void)
        | null
    completeClaim?.({ ...row, ownerId: 'me', state: 'adopting' })
    await stopping

    assert.equal(handoffs, 1)
    assert.equal(handedOffMessageId, 'late')
    assert.deepEqual(adopted, [])
})
