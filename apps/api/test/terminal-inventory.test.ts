import test from 'node:test'
import assert from 'node:assert/strict'
import {
    INVENTORY_GRACE_MS,
    TerminalInventoryService
} from '../src/modules/terminal/terminal-inventory.service'

// The daemon's inventory as the proof of life for the terminals it owns
// (ADR-0029 §6): named live rows are renewed, unnamed ones end, unclaimed
// terminals are closed — each side under a grace period for the report that
// crosses a row or a spawn.

const NOW = Date.parse('2026-09-17T12:00:00Z')
const OLD = new Date(NOW - 2 * INVENTORY_GRACE_MS)
const YOUNG = new Date(NOW - INVENTORY_GRACE_MS / 2)

const row = (id: string, createdAt: Date) => ({
    id,
    createdAt,
    userId: 'u1',
    agentId: 'agt-1',
    tokenId: null,
    heldSessionId: null
})

const harness = (rows: Array<ReturnType<typeof row>>) => {
    const renewed: string[][] = []
    const ended: string[] = []
    const closed: Array<[string, string]> = []
    const listeners: Array<(daemonId: string, terminals: unknown[]) => void> =
        []
    const service = new TerminalInventoryService(
        {
            onTerminalInventory: (listener: (typeof listeners)[number]) => {
                listeners.push(listener)
                return () => {}
            }
        } as never,
        {
            listLiveOwnedByDaemon: async () => rows,
            renewLeases: async (ids: string[]) => {
                renewed.push(ids)
                return ids.length
            }
        } as never,
        {
            endGone: async (r: { id: string }) => {
                ended.push(r.id)
                return true
            }
        } as never,
        {
            closePty: async (daemonId: string, handle: string) => {
                closed.push([daemonId, handle])
            }
        } as never
    )
    return { service, renewed, ended, closed, listeners }
}

const entry = (terminalId: string, startedAt: Date) => ({
    terminalId,
    attached: false,
    startedAt: startedAt.toISOString()
})

test('named rows are renewed, unnamed old rows end, young ones wait', async () => {
    const h = harness([
        row('tms_named', OLD),
        row('tms_gone', OLD),
        row('tms_new', YOUNG)
    ])
    const outcome = await h.service.reconcile(
        'dh-1',
        [entry('tms_named', OLD)],
        NOW
    )
    assert.deepEqual(h.renewed, [['tms_named']])
    assert.deepEqual(h.ended, ['tms_gone'])
    assert.deepEqual(h.closed, [])
    assert.deepEqual(outcome, { renewed: 1, ended: 1, closed: 0 })
})

test('a terminal no live row claims is closed once it is past the grace', async () => {
    const h = harness([row('tms_named', OLD)])
    await h.service.reconcile(
        'dh-1',
        [
            entry('tms_named', OLD),
            entry('tms_orphan', OLD),
            entry('tms_fresh', YOUNG)
        ],
        NOW
    )
    assert.deepEqual(h.closed, [['dh-1', 'tms_orphan']])
    assert.deepEqual(h.ended, [])
})

test('an empty inventory is a statement: every old row ends', async () => {
    const h = harness([
        row('tms_a', OLD),
        row('tms_b', OLD),
        row('tms_c', YOUNG)
    ])
    await h.service.reconcile('dh-1', [], NOW)
    assert.deepEqual(h.ended, ['tms_a', 'tms_b'])
    assert.deepEqual(h.renewed, [[]])
})

test('the service reconciles every inventory the daemon module reports', async () => {
    const h = harness([row('tms_gone', OLD)])
    h.service.onModuleInit()
    assert.equal(h.listeners.length, 1)
    h.listeners[0]('dh-1', [])
    await new Promise((resolve) => setImmediate(resolve))
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(h.ended, ['tms_gone'])
    h.service.onModuleDestroy()
})
