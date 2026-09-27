import assert from 'node:assert/strict'
import test from 'node:test'
import 'reflect-metadata'
import { ConflictException, ForbiddenException } from '@nestjs/common'
import { PodHostsService } from '../src/modules/pod-hosts/pod-hosts.service'
import { openCloudComputerPort } from '../src/common/ports/cloud-computer.ports'

// Cloud computers (ADR-0035) from the user's side: the gates on creating
// one, the refusal to delete one still being created, deletion through the
// one host delete path (ADR-0037 R8), and how its daemon's CLI is updated —
// the pod's daemon IS host_daemons for the host, so nothing is looked up by
// name any more.

const host = (over: Record<string, unknown> = {}) => ({
    id: 'pdh_1',
    userId: 'usr_1',
    kind: 'hosted',
    providerId: 'clus_1',
    providerRef: {
        kind: 'k8s',
        namespace: 'nca-user-1',
        ingressHost: 'pdh-1.example.test',
        podPhase: 'Running'
    },
    name: 'computer-001',
    status: 'ready',
    failureReason: null,
    powerState: 'running',
    region: null,
    cpuMillicores: 1000,
    memoryMb: 2048,
    diskGb: 10,
    createdAt: new Date('2026-09-25T00:00:00Z'),
    updatedAt: new Date('2026-09-25T00:00:00Z'),
    ...over
})

const daemon = (over: Record<string, unknown> = {}) => ({
    hostId: 'pdh_1',
    userId: 'usr_1',
    cliVersion: '5.0.1',
    startupMethod: 'container',
    clientFeatures: [],
    lastSeenAt: new Date(),
    ...over
})

// Every select answers from `rows` in call order: the host lookup first, then
// whatever the operation reads next.
const fakeDb = (rows: unknown[][]) => {
    let call = 0
    const next = () => rows[call++] ?? []
    const chain: Record<string, unknown> = {}
    for (const method of ['from', 'where', 'orderBy', 'groupBy', 'innerJoin'])
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
    lifecycle?: unknown
    daemon?: unknown | null
    cli?: unknown
}) =>
    new PodHostsService(
        (over.db ?? fakeDb([])) as never,
        { toSummaries: async () => [], toSummary: async (r: unknown) => r } as never,
        (over.provisioner ?? {}) as never,
        (over.lifecycle ?? {}) as never,
        { isFeatureEnabled: async () => over.toggle !== false } as never,
        {
            getCachedLatest: async () => ({ version: '5.1.0', channel: 'stable' })
        } as never,
        {
            findByHostId: async () =>
                over.daemon === undefined ? daemon() : over.daemon,
            findByHostIds: async () => new Map()
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

test('a create hands the chosen provider to the provisioner', async () => {
    const calls: Array<Record<string, unknown>> = []
    const service = build({
        db: fakeDb([[host()], [], [], [], [], []]),
        provisioner: {
            createHost: async (input: Record<string, unknown>) => {
                calls.push(input)
                return host()
            }
        },
        port: {
            ...openCloudComputerPort,
            selfServeContainerSpec: () => ({ cpuMillicores: 1000, memoryMb: 2048, diskGb: 10 })
        }
    })
    await service.create('usr_1', { name: 'box', providerId: 'clus_2' })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].providerId, 'clus_2')
    assert.equal(calls[0].name, 'box')
})

test('a cloud computer still being created is not deleted under its bring-up', async () => {
    let tornDown = false
    const service = build({
        db: fakeDb([[host({ status: 'provisioning' })]]),
        lifecycle: {
            deleteHost: async () => {
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

test('deleting a cloud computer goes through the host delete path and ends what bought it', async () => {
    const calls: string[] = []
    const service = build({
        db: fakeDb([[host()]]),
        lifecycle: {
            deleteHost: async (id: string) => {
                calls.push(`delete:${id}`)
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
    assert.deepEqual(calls, ['delete:pdh_1', 'port:pdh_1'])
})

test('a host with agents is refused by the delete path before anything is bought back', async () => {
    const calls: string[] = []
    const service = build({
        db: fakeDb([[host()]]),
        lifecycle: {
            deleteHost: async () => {
                throw new ConflictException({ code: 'HOST_NOT_EMPTY' })
            }
        },
        port: {
            ...openCloudComputerPort,
            onPodHostTeardown: async (id: string) => {
                calls.push(`port:${id}`)
            }
        }
    })
    await assert.rejects(service.delete('usr_1', 'pdh_1'), ConflictException)
    assert.deepEqual(calls, [])
})

test("a cloud computer's CLI is updated through its own daemon", async () => {
    const updates: unknown[] = []
    const service = build({
        db: fakeDb([[host()], [host()], [], [], [], []]),
        cli: {
            update: async (args: unknown) => {
                updates.push(args)
            }
        }
    })
    await service.upgradeCli('usr_1', 'pdh_1', '5.1.0')
    assert.deepEqual(updates, [
        { host: host(), actorId: 'usr_1', targetVersion: '5.1.0' }
    ])
})

test('a cloud computer whose daemon has not registered has nothing to update', async () => {
    const service = build({
        db: fakeDb([[host()]]),
        daemon: null,
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
