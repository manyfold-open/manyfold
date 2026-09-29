import assert from 'node:assert/strict'
import test from 'node:test'
import { BadRequestException } from '@nestjs/common'
import { RuntimeProvidersAdminService } from '../src/modules/runtime-providers/runtime-providers-admin.service'
import {
    SpritesProvider,
    parseSpritesVaultToken
} from '../src/modules/hosts/providers/sprites.provider'

// How a credential splits into secret and config, and whether it works, is the
// provider kind's adapter's; the admin service keeps the rows.

const row = (over: Record<string, unknown> = {}) => ({
    id: 'rtp_1',
    kind: 'sprites',
    name: 'org',
    status: 'enabled',
    priority: 0,
    region: null,
    config: { orgSlug: 'org', orgId: 'o1', tokenId: 't1', notes: 'old' },
    credentialCiphertext: 'c',
    credentialKeyVersion: 1,
    lastHealthStatus: 'ok',
    lastHealthMessage: null,
    lastHealthCheckedAt: null,
    createdAt: new Date('2026-09-01'),
    updatedAt: new Date('2026-09-01'),
    ...over
})

const makeDb = (existing = row()) => {
    const writes: Array<Record<string, unknown>> = []
    const chain = {
        from: () => chain,
        leftJoin: () => chain,
        groupBy: () => chain,
        orderBy: async () => [],
        where: () => ({
            limit: async () => [existing],
            then: (res: (v: unknown) => unknown) =>
                Promise.resolve([{ n: 0 }]).then(res)
        })
    }
    return {
        writes,
        select: () => chain,
        insert: () => ({
            values: (values: Record<string, unknown>) => {
                writes.push({ insert: values })
                return { returning: async () => [{ ...existing, ...values }] }
            }
        }),
        update: () => ({
            set: (set: Record<string, unknown>) => {
                writes.push({ update: set })
                return {
                    where: () => ({
                        returning: async () => [{ ...existing, ...set }],
                        then: (res: (v: unknown) => unknown) =>
                            Promise.resolve(undefined).then(res)
                    })
                }
            }
        })
    }
}

const build = (adapter: Record<string, unknown>, db = makeDb()) => {
    const invalidated: string[] = []
    const svc = new RuntimeProvidersAdminService(
        db as never,
        { encrypt: (plain: string) => ({ ciphertext: `enc:${plain}`, keyVersion: 1 }) } as never,
        { for: () => adapter } as never,
        {
            invalidate: (provider: { id: string }) => {
                invalidated.push(provider.id)
            }
        } as never
    )
    return { svc, db, invalidated }
}

test('a new provider stores what its adapter prepared from the credential', async () => {
    const { svc, db } = build({
        prepareCredential: async (credential: string) => ({
            secret: `secret:${credential}`,
            config: { orgSlug: 'org' },
            health: { ok: false, message: 'refused' }
        })
    })

    await svc.create({ kind: 'sprites', name: 'org', credential: 'raw' } as never)

    const inserted = db.writes[0].insert as Record<string, unknown>
    assert.equal(inserted.credentialCiphertext, 'enc:secret:raw')
    assert.deepEqual(inserted.config, { orgSlug: 'org' })
    assert.equal(inserted.lastHealthStatus, 'failed')
    assert.equal(inserted.lastHealthMessage, 'refused')
})

test('a config patch without a credential is merged by the adapter and forgets the old clients', async () => {
    const { svc, db, invalidated } = build({
        mergeConfig: (current: Record<string, unknown>, patch: Record<string, unknown>) => ({
            ...current,
            notes: patch.notes
        })
    })

    await svc.update('rtp_1', { config: { notes: 'new' } } as never)

    const update = db.writes[0].update as Record<string, unknown>
    assert.deepEqual(update.config, {
        orgSlug: 'org',
        orgId: 'o1',
        tokenId: 't1',
        notes: 'new'
    })
    assert.deepEqual(invalidated, ['rtp_1'])
})

test('a probe records what the adapter found', async () => {
    const { svc, db } = build({
        checkCredential: async () => ({ ok: true, message: 'reachable (listed 3 sprites)' })
    })

    const result = await svc.probe('rtp_1')

    assert.equal(result.ok, true)
    assert.equal(result.message, 'reachable (listed 3 sprites)')
    const update = db.writes[0].update as Record<string, unknown>
    assert.equal(update.lastHealthStatus, 'ok')
})

test('a sprites credential splits into its ids and the whole token', async () => {
    const adapter = new SpritesProvider(
        { register: () => {} } as never,
        {} as never,
        {} as never
    )

    const prepared = await adapter.prepareCredential('org/o1/t1/value', {
        notes: ' ops '
    })

    assert.equal(prepared.secret, 'org/o1/t1/value')
    assert.deepEqual(prepared.config, {
        orgSlug: 'org',
        orgId: 'o1',
        tokenId: 't1',
        notes: 'ops'
    })
    assert.throws(() => parseSpritesVaultToken('org/o1/value'), BadRequestException)
    assert.throws(() => parseSpritesVaultToken('org//t1/value'), BadRequestException)
})
