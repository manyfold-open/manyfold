import assert from 'node:assert/strict'
import test from 'node:test'
import { holdForDelivery } from '../src/modules/daemon/daemon-config-delivery.service'
import { NOOP_HOLD } from '../src/modules/hosts/host-awake.service'

// MCP and context-doc delivery reads and writes files through the daemon.
// Those RPCs are not activity a sprite counts, so it could suspend mid-write.

const recorder = () => {
    const holds: string[] = []
    return {
        holds,
        awake: {
            hold: (host: { id: string }, reason: string) => {
                holds.push(`${host.id}:${reason}`)
                return NOOP_HOLD
            }
        } as never
    }
}

test('a delivery holds a running sandbox while it writes', () => {
    const { holds, awake } = recorder()
    holdForDelivery(awake, { id: 'sbx_1', kind: 'hosted', powerState: 'running' } as never)
    assert.deepEqual(holds, ['sbx_1:config-delivery'])
})

// WHY: taking the hold is an exec into the VM, and an exec wakes a sleeping
// sprite; a delivery waits for the machine to be up instead.
test('a delivery never wakes a sleeping sandbox to take its hold', () => {
    const { holds, awake } = recorder()
    for (const powerState of ['suspended', 'stopped', 'unknown', null])
        assert.equal(
            holdForDelivery(awake, { id: 'sbx_1', kind: 'hosted', powerState } as never),
            NOOP_HOLD
        )
    assert.deepEqual(holds, [])
})
