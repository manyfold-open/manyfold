import assert from 'node:assert/strict'
import test from 'node:test'
import {
    BadRequestException,
    ConflictException,
    ServiceUnavailableException
} from '@nestjs/common'
import { SandboxesService } from '../src/modules/sandboxes/sandboxes.service'
import {
    AwakeLeaseStillHeldError,
    type AwakeLease
} from '../src/modules/hosts/providers/sandbox-provider'

// The sandbox's activity leases live behind its provider's adapter (the
// sprites adapter's /v1/tasks); what the service owns is which ones a user may
// touch and when reading them would wake the machine.

const baseHost = (over: Record<string, unknown> = {}) => ({
    id: 'sbx_1',
    userId: 'u1',
    kind: 'hosted',
    providerId: 'rtp_1',
    providerRef: { kind: 'sprites', spriteName: 'sbx-sprite', spriteId: 'spr_1' },
    status: 'ready',
    powerState: 'running',
    ...over
})

const fakeAdapter = (
    opts: { leases?: AwakeLease[]; release?: 'held' | Error } = {}
) => {
    const calls: string[] = []
    return {
        calls,
        listAwake: async () => {
            calls.push('list')
            return opts.leases ?? []
        },
        releaseAwake: async (_call: unknown, lease: { name: string }) => {
            calls.push(`release:${lease.name}`)
            if (opts.release === 'held')
                throw new AwakeLeaseStillHeldError(lease.name)
            if (opts.release) throw opts.release
        }
    }
}

const makeService = (
    host: Record<string, unknown> = baseHost(),
    adapter = fakeAdapter()
) => {
    const runtimes = {
        getSandboxForUser: async () => ({ host, provider: null, daemon: null, agentsCount: 0 }),
        getSandboxById: async () => ({ host, provider: null, daemon: null, agentsCount: 0 })
    }
    const hostProviders = {
        resolve: async () => ({
            provider: { id: 'rtp_1', kind: 'sprites', name: 'org' },
            adapter
        })
    }
    return new SandboxesService(
        runtimes as never,
        {} as never,
        {} as never,
        hostProviders as never,
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
        {} as never
    )
}

const lease = (name: string): AwakeLease => ({
    name,
    startedAt: null,
    expiresAt: null
})

test('deleteTask refuses platform holds before touching the sandbox', async () => {
    const adapter = fakeAdapter()
    const svc = makeService(baseHost(), adapter)

    await assert.rejects(
        svc.deleteTask('u1', 'sbx_1', 'mf-keep'),
        BadRequestException
    )
    await assert.rejects(
        svc.deleteTask('u1', 'sbx_1', 'mf-hold-0123abcd'),
        BadRequestException
    )
    assert.deepEqual(adapter.calls, [])
})

test('deleteTask refuses when the sandbox is not running (never wakes it)', async () => {
    const adapter = fakeAdapter()
    const svc = makeService(baseHost({ powerState: 'suspended' }), adapter)

    await assert.rejects(
        svc.deleteTask('u1', 'sbx_1', 'my-task'),
        ConflictException
    )
    assert.deepEqual(adapter.calls, [])
})

test('deleteTask releases the lease through the adapter', async () => {
    const adapter = fakeAdapter()
    const svc = makeService(baseHost(), adapter)

    await svc.deleteTask('u1', 'sbx_1', 'web srv/№1')

    assert.deepEqual(adapter.calls, ['release:web srv/№1'])
})

test('deleteTask fails loud when the task survives the delete', async () => {
    const svc = makeService(baseHost(), fakeAdapter({ release: 'held' }))

    await assert.rejects(
        svc.deleteTask('u1', 'sbx_1', 'my-task'),
        (err: Error) =>
            err instanceof ConflictException &&
            /still registered/.test(err.message)
    )
})

test('deleteTask surfaces a release that could not be confirmed', async () => {
    const svc = makeService(
        baseHost(),
        fakeAdapter({ release: new Error('socket hangup') })
    )

    await assert.rejects(
        svc.deleteTask('u1', 'sbx_1', 'my-task'),
        ServiceUnavailableException
    )
})

test('listTasks flags platform holds as keepAlive', async () => {
    const svc = makeService(
        baseHost(),
        fakeAdapter({
            leases: [
                lease('mf-keep'),
                lease('mf-hold-0123abcd'),
                lease('my-http-server')
            ]
        })
    )

    const tasks = await svc.listTasks('u1', 'sbx_1')

    assert.deepEqual(
        tasks.map((t) => [t.name, t.keepAlive]),
        [
            ['mf-keep', true],
            ['mf-hold-0123abcd', true],
            ['my-http-server', false]
        ]
    )
})

test('listTasks reads nothing on a sandbox that is not running', async () => {
    const adapter = fakeAdapter({ leases: [lease('my-http-server')] })
    const svc = makeService(baseHost({ powerState: 'suspended' }), adapter)

    assert.deepEqual(await svc.listTasks('u1', 'sbx_1'), [])
    assert.deepEqual(adapter.calls, [])
})
