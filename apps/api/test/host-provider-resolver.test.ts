import assert from 'node:assert/strict'
import test from 'node:test'
import { NotFoundException } from '@nestjs/common'
import { HostProviderResolver } from '../src/modules/hosts/providers/host-provider-resolver.service'

// The provider row behind a host is read once a minute: the turn path asks on
// every bring-up. An admin change invalidates it, and every client built from
// the old row with it.

const host = (over: Record<string, unknown> = {}) =>
    ({ id: 'sbx_1', kind: 'hosted', providerId: 'rtp_1', ...over }) as never

const build = () => {
    const reads: string[] = []
    const forgotten: string[] = []
    const invalidated: string[] = []
    const adapter = {
        kind: 'sprites',
        forget: (id: string) => forgotten.push(id)
    }
    const resolver = new HostProviderResolver(
        {
            findById: async (id: string) => {
                reads.push(id)
                return { id, kind: 'sprites', name: 'org' }
            }
        } as never,
        {
            for: () => adapter,
            has: () => true,
            kinds: () => ['sprites']
        } as never,
        {
            invalidateProvider: (id: string) => invalidated.push(id)
        } as never
    )
    return { resolver, adapter, reads, forgotten, invalidated }
}

test('a host resolves to its provider row and that kind\'s adapter, the row cached', async () => {
    const { resolver, adapter, reads } = build()

    const first = await resolver.resolve(host())
    const second = await resolver.resolve(host())

    assert.equal(first.provider.id, 'rtp_1')
    assert.equal(first.adapter, adapter)
    assert.equal(second.provider, first.provider)
    assert.deepEqual(reads, ['rtp_1'])
})

test('invalidating reads the row again and forgets what was built from it', async () => {
    const { resolver, reads, forgotten, invalidated } = build()
    await resolver.resolve(host())

    resolver.invalidate({ id: 'rtp_1', kind: 'sprites' })
    await resolver.resolve(host())

    assert.deepEqual(reads, ['rtp_1', 'rtp_1'])
    assert.deepEqual(forgotten, ['rtp_1'])
    assert.deepEqual(invalidated, ['rtp_1'])
})

test('a self-owned computer has no provider', async () => {
    const { resolver } = build()
    await assert.rejects(
        resolver.resolve(host({ kind: 'local', providerId: null })),
        NotFoundException
    )
})
