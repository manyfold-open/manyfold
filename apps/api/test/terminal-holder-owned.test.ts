import test from 'node:test'
import assert from 'node:assert/strict'
import { TerminalHolderService } from '../src/modules/terminal/terminal-holder.service'

// Holds under daemon-owned terminals (ADR-0029 §6): which terminal a tab may
// attach to instead of opening another, a detach that keeps the hold, and
// the row ending on the daemon's word.

const OWNED = {
    id: 'tms_prev',
    userId: 'u1',
    agentId: 'agt-1',
    runtime: 'daemon',
    processHandle: 'tms_prev',
    heldSessionId: 'cs-1',
    tokenId: 'tok-old',
    endedAt: null,
    endedReason: null
}

const harness = (
    rows: Record<string, Record<string, unknown>>,
    holder?: string
) => {
    const ended: Array<[string, string]> = []
    const released: string[] = []
    const dropped: string[] = []
    const imports: string[] = []
    const service = new TerminalHolderService(
        {} as never,
        {
            findById: async (id: string) => rows[id] ?? null,
            end: async (id: string, reason: string) => {
                const row = rows[id]
                if (!row || row.endedAt) return null
                ended.push([id, reason])
                rows[id] = { ...row, endedAt: new Date(), endedReason: reason }
                return rows[id]
            },
            markHeld: async () => {}
        } as never,
        {
            sessionHolderState: async () => ({
                holderTerminalId: holder ?? null,
                inflightMessageId: null
            }),
            releaseSessionHolder: async (sessionId: string) => {
                released.push(sessionId)
                return { released: true }
            }
        } as never,
        {
            settlePendingImport: async (_u: string, _a: string, s: string) => {
                imports.push(s)
            }
        } as never,
        {} as never,
        {} as never,
        undefined,
        undefined,
        {
            hardDelete: async (args: { tokenId: string }) => {
                dropped.push(args.tokenId)
            }
        } as never
    )
    return { service, ended, released, dropped, imports }
}

test('the terminal a tab names comes first, then the one holding its session', async () => {
    const other = { ...OWNED, id: 'tms_holder', processHandle: 'tms_holder' }
    const h = harness({ tms_prev: OWNED, tms_holder: other }, 'tms_holder')
    const byName = await h.service.reusableTerminal({
        userId: 'u1',
        agentId: 'agt-1',
        sessionId: 'cs-1',
        prevTerminalId: 'tms_prev'
    })
    assert.equal(byName?.id, 'tms_prev')
    const byHold = await h.service.reusableTerminal({
        userId: 'u1',
        agentId: 'agt-1',
        sessionId: 'cs-1',
        prevTerminalId: 'tms_missing'
    })
    assert.equal(byHold?.id, 'tms_holder')
})

test('only a live, owned, daemon terminal of the same user and agent holding the same session is reused', async () => {
    const cases: Array<[string, Record<string, unknown>, string | null]> = [
        ['ended', { ...OWNED, endedAt: new Date() }, 'cs-1'],
        ['another user', { ...OWNED, userId: 'u2' }, 'cs-1'],
        ['another agent', { ...OWNED, agentId: 'agt-2' }, 'cs-1'],
        ['a sprites terminal', { ...OWNED, runtime: 'sprites' }, 'cs-1'],
        ['a stream-bound pty', { ...OWNED, processHandle: 'ref-1' }, 'cs-1'],
        ['a hold on another session', OWNED, 'cs-2'],
        [
            'a plain shell asked to resume',
            { ...OWNED, heldSessionId: null },
            'cs-1'
        ]
    ]
    for (const [label, row, sessionId] of cases) {
        const h = harness({ tms_prev: row })
        assert.equal(
            await h.service.reusableTerminal({
                userId: 'u1',
                agentId: 'agt-1',
                sessionId,
                prevTerminalId: 'tms_prev'
            }),
            null,
            label
        )
    }
    const plain = harness({ tms_prev: { ...OWNED, heldSessionId: null } })
    assert.equal(
        (
            await plain.service.reusableTerminal({
                userId: 'u1',
                agentId: 'agt-1',
                sessionId: null,
                prevTerminalId: 'tms_prev'
            })
        )?.id,
        'tms_prev',
        'a plain shell is reused for a plain shell'
    )
})

test('a detach keeps the row and its hold; the daemon saying the terminal is gone ends both', async () => {
    const h = harness({ tms_prev: OWNED })
    await h.service.finish('tms_prev', 'detached')
    assert.deepEqual(h.ended, [])
    assert.deepEqual(h.released, [])

    assert.equal(await h.service.endGone(OWNED as never), true)
    assert.deepEqual(h.ended, [['tms_prev', 'closed']])
    assert.deepEqual(h.dropped, ['tok-old'], 'the shell token goes with it')
    assert.deepEqual(h.released, ['cs-1'])
    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(h.imports, ['cs-1'])
    assert.equal(
        await h.service.endGone(OWNED as never),
        false,
        'ending is a compare-and-set'
    )
})
