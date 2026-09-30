import assert from 'node:assert/strict'
import test from 'node:test'
import { SandboxesService } from '../src/modules/sandboxes/sandboxes.service'
import { SpritesProvisioner } from '../src/modules/agent-runtimes/provisioning/sprites-provisioner'

// POST /sandboxes makes a VM the same way an agent create does, so it is
// refused the same way when the machine's runner could never call the API
// back: before a quota slot, a name or a `failed` row is spent on it.
test('a new sandbox is refused before it is reserved when sandboxes cannot reach the API', async (t) => {
    const prior = process.env.PUBLIC_API_BASE_URL
    process.env.PUBLIC_API_BASE_URL = 'http://192.168.1.20:2222'
    t.after(() => {
        if (prior === undefined) delete process.env.PUBLIC_API_BASE_URL
        else process.env.PUBLIC_API_BASE_URL = prior
    })
    const reserved: unknown[] = []
    const svc = new SandboxesService(
        {} as never,
        Object.create(SpritesProvisioner.prototype) as never,
        {
            selectProvider: async () => ({ id: 'rtp_1', kind: 'sprites' })
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {
            reserveStandaloneSandbox: async (input: unknown) => {
                reserved.push(input)
                return {}
            }
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )

    await assert.rejects(
        svc.create('user-1', { name: 'lab' } as never),
        (err: unknown) =>
            (err as { getResponse: () => { code?: string } }).getResponse()
                .code === 'SANDBOX_API_UNREACHABLE'
    )
    assert.deepEqual(reserved, [])
})
