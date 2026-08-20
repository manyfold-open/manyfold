import assert from 'node:assert/strict'
import test from 'node:test'
import { ConflictException, NotFoundException } from '@nestjs/common'
import type { AgentRuntimeRow, RuntimeHostRow } from '@manyfold/db'
import { SpritesProvisioner } from '../src/modules/agent-runtimes/provisioning/sprites-provisioner'

// Compact chainable fake for the transaction body used by teardownRuntime /
// deleteSandbox: a lock execute, count select, agent/runtime deletes, and a
// host update (with or without .returning()).
class FakeUpdate {
    constructor(private readonly db: FakeProvDb) {}
    set(patch: Record<string, unknown>): this {
        this.db.hostUpdates.push(patch)
        return this
    }
    where(): Promise<unknown[]> & { returning: () => Promise<unknown[]> } {
        const db = this.db
        const p = Promise.resolve([]) as unknown as Promise<unknown[]> & {
            returning: () => Promise<unknown[]>
        }
        p.returning = (): Promise<unknown[]> =>
            Promise.resolve(db.revokeReturns ? [{ id: 'host' }] : [])
        return p
    }
}

class FakeSelect {
    constructor(private readonly db: FakeProvDb) {}
    from(): this {
        return this
    }
    where(): Promise<Array<{ value: number }>> {
        return Promise.resolve([{ value: this.db.runtimeCount }])
    }
}

class FakeProvDb {
    runtimeCount = 0
    revokeReturns = true
    hostUpdates: Array<Record<string, unknown>> = []
    deleteCalls = 0

    async transaction<T>(fn: (tx: FakeProvDb) => Promise<T>): Promise<T> {
        return fn(this)
    }
    async execute(): Promise<unknown[]> {
        return []
    }
    select(): FakeSelect {
        return new FakeSelect(this)
    }
    delete(): { where: () => Promise<unknown[]> } {
        this.deleteCalls += 1
        return { where: () => Promise.resolve([]) }
    }
    update(): FakeUpdate {
        return new FakeUpdate(this)
    }
}

const account: {
    id: string
    slug: string
    tokenCiphertext: string
    tokenKeyVersion: number
} = {
    id: 'spa_test',
    slug: 'test-account',
    tokenCiphertext: 'enc',
    tokenKeyVersion: 1
}

const hostRow = (over: Partial<RuntimeHostRow> = {}): RuntimeHostRow =>
    ({
        id: 'sbx_1',
        userId: 'user-1',
        kind: 'sandbox',
        status: 'active',
        accountId: account.id,
        spriteName: 'sbx-1',
        spriteId: 'sprite-1',
        spriteStatus: null,
        terminalEnabled: false,
        emptiedAt: null,
        ...over
    }) as RuntimeHostRow

const runtimeRow = (over: Partial<AgentRuntimeRow> = {}): AgentRuntimeRow =>
    ({
        id: 'art_1',
        userId: 'user-1',
        kind: 'sprites',
        accountId: account.id,
        spriteName: 'sbx-1',
        hostId: 'sbx_1',
        ...over
    }) as AgentRuntimeRow

const teardownFetchRestores: Array<() => void> = []

const makeProvisioner = (
    db: FakeProvDb,
    runtimes: Record<string, unknown>,
    deleteSpriteCalls: string[]
): SpritesProvisioner => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (input, init) => {
        const url = String(input)
        const method = init?.method ?? 'GET'
        if (method === 'DELETE' && url.includes('/sprites/')) {
            deleteSpriteCalls.push(url)
            return new Response(null, { status: 204 })
        }
        return new Response('{}', { status: 200 })
    }) as typeof fetch
    teardownFetchRestores.push(() => {
        globalThis.fetch = originalFetch
    })
    const accounts = {
        getById: async () => account,
        decryptToken: () => 'token',
        selectForCreate: async () => account
    }
    return new SpritesProvisioner(
        db as never,
        accounts as never,
        runtimes as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { settleHostNotRunning: async () => {} } as never
    )
}

test.afterEach(() => {
    while (teardownFetchRestores.length) teardownFetchRestores.pop()?.()
})

test('provisionSandbox preserves a revoked host when create-failure cleanup cannot delete the VM', async () => {
    const deletedHosts: string[] = []
    const revokedHosts: string[] = []
    const deletedSprites: string[] = []
    const provisioner = new SpritesProvisioner(
        {} as never,
        {} as never,
        {
            deleteSandboxHost: async (id: string) => {
                deletedHosts.push(id)
            },
            revokeSandboxHost: async (id: string) => {
                revokedHosts.push(id)
            }
        } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { get: () => undefined } as never,
        {} as never,
        {} as never,
        { settleHostNotRunning: async () => {} } as never
    )

    await assert.rejects(
        () =>
            provisioner.provisionSandbox({
                hostId: 'sbx_retry',
                spriteName: 'sbx-retry',
                spritesClient: {
                    createSprite: async () => ({ id: 'sprite-1' }),
                    setNetworkPolicy: async () => {
                        throw new Error('policy failed')
                    },
                    deleteSprite: async (name: string) => {
                        deletedSprites.push(name)
                        throw new Error('sprites api unavailable')
                    }
                } as never
            }),
        /policy failed/
    )

    assert.deepEqual(deletedSprites, ['sbx-retry'])
    assert.deepEqual(deletedHosts, [])
    assert.deepEqual(
        revokedHosts,
        ['sbx_retry'],
        'host row stays as the retry record when remote cleanup fails'
    )
})

test('teardownRuntime preserves the now-empty sandbox VM and sets emptied_at', async () => {
    const db = new FakeProvDb()
    db.runtimeCount = 0 // host empty after this runtime is deleted
    const deleteSandboxHostCalls: string[] = []
    const deleteSpriteCalls: string[] = []
    const provisioner = makeProvisioner(
        db,
        {
            deleteSandboxHost: async (id: string) => {
                deleteSandboxHostCalls.push(id)
            }
        },
        deleteSpriteCalls
    )

    await provisioner.teardownRuntime(runtimeRow())

    const patch = db.hostUpdates.at(-1)
    assert.ok(patch, 'host row was updated')
    assert.ok(
        'emptiedAt' in patch,
        'emptied_at is set to start the reaper clock'
    )
    assert.equal(patch.spriteStatus, null, 'stale running status is cleared')
    assert.equal(
        deleteSpriteCalls.length,
        0,
        'the VM is NOT deleted on a normal agent delete'
    )
    assert.equal(deleteSandboxHostCalls.length, 0, 'the host row is kept')
})

test('teardownRuntime with reapImmediatelyIfEmpty deletes the VM + host row', async () => {
    const db = new FakeProvDb()
    db.runtimeCount = 0
    const deleteSandboxHostCalls: string[] = []
    const deleteSpriteCalls: string[] = []
    const provisioner = makeProvisioner(
        db,
        {
            deleteSandboxHost: async (id: string) => {
                deleteSandboxHostCalls.push(id)
            }
        },
        deleteSpriteCalls
    )

    await provisioner.teardownRuntime(runtimeRow(), {
        reapImmediatelyIfEmpty: true
    })

    assert.equal(deleteSpriteCalls.length, 1, 'the VM is deleted')
    assert.deepEqual(
        deleteSandboxHostCalls,
        ['sbx_1'],
        'the host row is removed'
    )
    assert.equal(
        db.hostUpdates.at(-1)?.status,
        'revoked',
        'host marked revoked before the external delete'
    )
})

test('teardownRuntime keeps the VM when other runtimes still share the host', async () => {
    const db = new FakeProvDb()
    db.runtimeCount = 1 // a co-resident runtime remains
    const deleteSpriteCalls: string[] = []
    const provisioner = makeProvisioner(
        db,
        { deleteSandboxHost: async () => {} },
        deleteSpriteCalls
    )

    await provisioner.teardownRuntime(runtimeRow())

    assert.equal(deleteSpriteCalls.length, 0, 'shared VM is untouched')
    assert.equal(db.hostUpdates.length, 0, 'host row is not modified')
})

test('deleteSandbox rejects while agents remain on the host', async () => {
    const db = new FakeProvDb()
    db.runtimeCount = 1 // a runtime/agent is still on the host
    const deleteSpriteCalls: string[] = []
    const provisioner = makeProvisioner(
        db,
        {
            findHostById: async () => hostRow(),
            deleteSandboxHost: async () => {}
        },
        deleteSpriteCalls
    )

    await assert.rejects(
        () => provisioner.deleteSandbox({ userId: 'user-1', hostId: 'sbx_1' }),
        (err) =>
            err instanceof ConflictException &&
            (err.getResponse() as { code?: string }).code ===
                'SANDBOX_NOT_EMPTY'
    )
    assert.equal(deleteSpriteCalls.length, 0, 'no VM delete when rejected')
})

test('deleteSandbox deletes the VM + host row when empty', async () => {
    const db = new FakeProvDb()
    db.runtimeCount = 0
    db.revokeReturns = true
    const deleteSandboxHostCalls: string[] = []
    const deleteSpriteCalls: string[] = []
    const provisioner = makeProvisioner(
        db,
        {
            findHostById: async () => hostRow(),
            deleteSandboxHost: async (id: string) => {
                deleteSandboxHostCalls.push(id)
            }
        },
        deleteSpriteCalls
    )

    await provisioner.deleteSandbox({ userId: 'user-1', hostId: 'sbx_1' })

    assert.equal(deleteSpriteCalls.length, 1, 'the VM is deleted')
    assert.deepEqual(
        deleteSandboxHostCalls,
        ['sbx_1'],
        'the host row is removed'
    )
})

test('deleteSandbox 404s a missing or foreign host', async () => {
    const db = new FakeProvDb()
    const provisioner = makeProvisioner(
        db,
        { findHostById: async () => null, deleteSandboxHost: async () => {} },
        []
    )

    await assert.rejects(
        () => provisioner.deleteSandbox({ userId: 'user-1', hostId: 'sbx_x' }),
        (err) =>
            err instanceof NotFoundException &&
            (err.getResponse() as { code?: string }).code ===
                'SANDBOX_NOT_FOUND'
    )
})
