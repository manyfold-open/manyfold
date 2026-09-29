import assert from 'node:assert/strict'
import test from 'node:test'
import { RuntimeRemovalService } from '../src/modules/agent-runtimes/runtime-removal.service'
import { k8sHostRow, runtimeRow, spritesHostRow } from './helpers/runtime-context-fixture'

// A runtime's delete (ADR-0037 R8) removes its row and leaves its machine; a
// service framework's services and the machine's route to it go with the row.

const rig = (host: unknown, opts: { failing?: boolean } = {}) => {
    const calls: string[] = []
    const service = new RuntimeRemovalService(
        {
            delete: async (id: string) => {
                calls.push(`delete ${id}`)
            }
        } as never,
        { findById: async () => host } as never,
        {
            removeRuntime: async (runtime: { id: string }) => {
                calls.push(`services ${runtime.id}`)
                if (opts.failing) throw new Error('sandbox sbx_1 has no connected daemon')
            }
        } as never,
        {
            removeService: async (runtime: { id: string }) => {
                calls.push(`pod service ${runtime.id}`)
            }
        } as never
    )
    return { service, calls }
}

test('a sandbox service runtime takes its services and route with its row', async () => {
    const r = rig(spritesHostRow({ id: 'sbx_1' }))
    await r.service.remove(runtimeRow({ id: 'art_1', framework: 'openclaw', hostId: 'sbx_1' }))
    assert.deepEqual(r.calls, ['services art_1', 'delete art_1'])
})

test('a cloud computer service runtime takes its service and ingress with its row', async () => {
    const r = rig(k8sHostRow({ id: 'pdh_1' }))
    await r.service.remove(runtimeRow({ id: 'art_1', framework: 'hermes', hostId: 'pdh_1' }))
    assert.deepEqual(r.calls, ['pod service art_1', 'delete art_1'])
})

test('a coding runtime is only its row', async () => {
    const r = rig(spritesHostRow({ id: 'sbx_1' }))
    await r.service.remove(runtimeRow({ id: 'art_1', framework: 'codex', hostId: 'sbx_1' }))
    assert.deepEqual(r.calls, ['delete art_1'])
})

test('a machine that cannot be reached does not keep the row', async () => {
    const r = rig(spritesHostRow({ id: 'sbx_1' }), { failing: true })
    await r.service.remove(runtimeRow({ id: 'art_1', framework: 'openclaw', hostId: 'sbx_1' }))
    assert.deepEqual(r.calls, ['services art_1', 'delete art_1'])
})
