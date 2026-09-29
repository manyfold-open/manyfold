import assert from 'node:assert/strict'
import test from 'node:test'
import { SandboxesService } from '../src/modules/sandboxes/sandboxes.service'

// The keep-awake switch commits the flag first; the hold on the machine
// follows through HostKeepAwakeService, which never execs into a sleeping
// sprite to let go (host-keep-awake.service.test.ts).

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

const build = (row: Record<string, unknown>, outcome: unknown = { state: 'held' }) => {
    const flags: boolean[] = []
    const converged: Array<{ id: string; keepAwake: unknown }> = []
    let current = row
    const view = { host: row, provider: null, daemon: null, agentsCount: 0 }
    const svc = new TestSandboxes(
        {
            getSandboxForUser: async () => view,
            getSandboxById: async () => view,
            setHostKeepAwake: async (_u: string, _h: string, on: boolean) => {
                flags.push(on)
                current = { ...current, keepAwake: on }
                return true
            }
        } as never,
        {} as never,
        {} as never,
        {} as never,
        { findById: async () => current } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {
            enableKeepAlive: async () => {
                flags.push(true)
                current = { ...current, keepAwake: true }
            }
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        {
            converge: async (h: { id: string; keepAwake: unknown }) => {
                converged.push({ id: h.id, keepAwake: h.keepAwake })
                return outcome
            }
        } as never
    )
    return { svc, flags, converged }
}

test('switching keep-awake on commits the flag, then holds the machine', async () => {
    const { svc, flags, converged } = build(host({ keepAwake: false }))
    await svc.setKeepAwake('u1', 'sbx_1', true)
    assert.deepEqual(flags, [true])
    assert.deepEqual(converged, [{ id: 'sbx_1', keepAwake: true }])
})

test('switching keep-awake off commits the flag, then lets the machine go', async () => {
    const { svc, flags, converged } = build(host())
    await svc.setKeepAwake('u1', 'sbx_1', false)
    assert.deepEqual(flags, [false])
    assert.deepEqual(converged, [{ id: 'sbx_1', keepAwake: false }])
})

// WHY: the flag is the commitment; a provider call that failed is converged
// by the reconcile, so the toggle still answers with the committed switch.
test('a hold that failed does not fail the toggle', async () => {
    const { svc, flags } = build(host({ keepAwake: false }), {
        state: 'failed',
        message: 'keep-awake hold failed: sprite unavailable'
    })
    await svc.setKeepAwake('u1', 'sbx_1', true)
    assert.deepEqual(flags, [true])
})
