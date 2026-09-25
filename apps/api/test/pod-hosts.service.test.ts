import assert from 'node:assert/strict'
import test from 'node:test'
import 'reflect-metadata'
import { ConflictException, ForbiddenException } from '@nestjs/common'
import { podRunnerHostName } from '@manyfold/shared'
import { PodHostsService } from '../src/modules/pod-hosts/pod-hosts.service'
import { openCloudComputerPort } from '../src/common/ports/cloud-computer.ports'

// Cloud computers (ADR-0035) from the user's side: the gates on creating
// one, the refusal to delete one still being created, and how its daemon's
// CLI is updated.

const host = (over: Record<string, unknown> = {}) => ({
    id: 'pdh_1',
    userId: 'usr_1',
    kind: 'pod',
    name: 'computer-001',
    podStatus: 'ready',
    podPhase: 'Running',
    podFailureReason: null,
    clusterId: 'clus_1',
    namespace: 'nca-user-1',
    region: null,
    cpuMillicores: 1000,
    memoryMb: 2048,
    diskGb: 10,
    createdAt: new Date('2026-09-25T00:00:00Z'),
    updatedAt: new Date('2026-09-25T00:00:00Z'),
    ...over
})

const runner = (over: Record<string, unknown> = {}) => ({
    id: 'dh_runner',
    userId: 'usr_1',
    kind: 'daemon',
    managed: true,
    name: podRunnerHostName('pdh_1'),
    cliVersion: '3.0.1',
    startupMethod: 'container',
    ...over
})

// Every select answers from `rows` in call order: the host lookup first, then
// whatever the operation reads next.
const fakeDb = (rows: unknown[][]) => {
    let call = 0
    const next = () => rows[call++] ?? []
    const chain: Record<string, unknown> = {}
    for (const method of ['from', 'where', 'orderBy', 'groupBy'])
        chain[method] = () => chain
    chain.limit = async () => next()
    chain.then = (resolve: (v: unknown) => void) => resolve(next())
    return { select: () => chain }
}

const build = (over: {
    db?: unknown
    toggle?: boolean
    port?: unknown
    provisioner?: unknown
    k8sProvisioner?: unknown
    cli?: unknown
}) =>
    new PodHostsService(
        (over.db ?? fakeDb([])) as never,
        { toSummaries: async () => [], toSummary: async (r: unknown) => r } as never,
        (over.provisioner ?? {}) as never,
        (over.k8sProvisioner ?? {}) as never,
        { isFeatureEnabled: async () => over.toggle !== false } as never,
        {
            getCachedLatest: async () => ({ version: '3.1.0', channel: 'stable' })
        } as never,
        (over.cli ?? {}) as never,
        over.port as never
    )

test('creating a cloud computer needs the master switch and a self-serve envelope', async () => {
    await assert.rejects(
        build({ toggle: false }).create('usr_1', {}),
        (err: unknown) => err instanceof ForbiddenException
    )
    await assert.rejects(
        build({
            port: { ...openCloudComputerPort, selfServeContainerSpec: () => null }
        }).create('usr_1', {}),
        (err: unknown) =>
            err instanceof ConflictException &&
            (err.getResponse() as { code?: string }).code ===
                'CONTAINER_REQUIRED'
    )
})

test('a cloud computer still being created is not deleted under its bring-up', async () => {
    let tornDown = false
    const service = build({
        db: fakeDb([[host({ podStatus: 'provisioning' })]]),
        k8sProvisioner: {
            teardownHost: async () => {
                tornDown = true
            }
        }
    })
    await assert.rejects(
        service.delete('usr_1', 'pdh_1'),
        (err: unknown) =>
            err instanceof ConflictException &&
            (err.getResponse() as { code?: string }).code ===
                'POD_HOST_PROVISIONING'
    )
    assert.equal(tornDown, false)
})

test('deleting a cloud computer ends what bought it', async () => {
    const calls: string[] = []
    const service = build({
        db: fakeDb([[host()]]),
        k8sProvisioner: {
            teardownHost: async () => {
                calls.push('teardown')
            }
        },
        port: {
            ...openCloudComputerPort,
            onPodHostTeardown: async (id: string) => {
                calls.push(`port:${id}`)
            }
        }
    })
    await service.delete('usr_1', 'pdh_1')
    assert.deepEqual(calls, ['teardown', 'port:pdh_1'])
})

test("a cloud computer's CLI is updated through its daemon", async () => {
    const updates: unknown[] = []
    const service = build({
        db: fakeDb([[host()], [runner()], [host()], [], [], [runner()]]),
        cli: {
            update: async (args: unknown) => {
                updates.push(args)
            }
        }
    })
    await service.upgradeCli('usr_1', 'pdh_1', '3.1.0')
    assert.deepEqual(updates, [
        {
            host: host(),
            runner: runner(),
            actorId: 'usr_1',
            targetVersion: '3.1.0'
        }
    ])
})

test('a cloud computer whose daemon has not registered has nothing to update', async () => {
    const service = build({
        db: fakeDb([[host()], []]),
        cli: {
            update: async () => {
                throw new Error('nothing to update')
            }
        }
    })
    await assert.rejects(
        service.upgradeCli('usr_1', 'pdh_1'),
        (err: unknown) =>
            err instanceof ConflictException &&
            (err.getResponse() as { code?: string }).code ===
                'POD_HOST_DAEMON_MISSING'
    )
})
