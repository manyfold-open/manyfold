import assert from 'node:assert/strict'
import test from 'node:test'
import { SandboxesService } from '../src/modules/sandboxes/sandboxes.service'

// The keep-awake switch commits the flag first; the sprite-side lease op after
// it is an exec, and an exec resumes a sleeping sprite.

const host = (over: Record<string, unknown> = {}) => ({
    id: 'sbx_1',
    userId: 'u1',
    kind: 'hosted',
    providerId: 'rtp_1',
    providerRef: { kind: 'sprites', spriteName: 'sbx-sprite', spriteId: 'spr_1' },
    status: 'ready',
    powerState: 'running',
    keepAwake: true,
    ...over
})

class TestSandboxes extends SandboxesService {
    async get(): Promise<never> {
        return {} as never
    }
}

const build = (row: Record<string, unknown>) => {
    const leaseCalls: string[] = []
    const view = { host: row, provider: null, daemon: null, agentsCount: 0 }
    const svc = new TestSandboxes(
        {
            getSandboxForUser: async () => view,
            getSandboxById: async () => view,
            setHostKeepAwake: async () => true
        } as never,
        {} as never,
        {} as never,
        {} as never,
        { findById: async () => ({ ...row, keepAwake: false }) } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {
            ensureLease: async () => {
                leaseCalls.push('ensure')
            },
            releaseLease: async () => {
                leaseCalls.push('release')
            }
        } as never,
        {} as never,
        {} as never,
        {} as never
    )
    return { svc, leaseCalls }
}

// WHY: turning keep-awake off exists to let the sandbox sleep. Releasing the
// lease on a sleeping sprite would wake it to do that, and bill the wake.
test('turning keep-awake off on a sleeping sandbox never execs into it', async () => {
    const { svc, leaseCalls } = build(host({ powerState: 'suspended' }))
    await svc.setKeepAwake('u1', 'sbx_1', false)
    assert.deepEqual(leaseCalls, [])
})

test('turning keep-awake off on a running sandbox releases its lease', async () => {
    const { svc, leaseCalls } = build(host())
    await svc.setKeepAwake('u1', 'sbx_1', false)
    assert.deepEqual(leaseCalls, ['release'])
})
