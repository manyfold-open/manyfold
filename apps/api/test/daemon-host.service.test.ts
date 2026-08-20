import test from 'node:test'
import assert from 'node:assert/strict'
import {
    agentRuntimes,
    daemonTokens,
    runtimeHosts,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
import {
    ConflictException,
    ForbiddenException,
    NotFoundException
} from '@nestjs/common'
import { DaemonController } from '../src/modules/daemon/daemon.controller'
import { DaemonGateway } from '../src/modules/daemon/daemon.gateway'
import { DaemonHostService } from '../src/modules/daemon/daemon-host.service'

class HostDb {
    rows: RuntimeHostRow[] = []
    tokens = [
        {
            id: 'ldt-1',
            userId: 'u1',
            daemonId: null as string | null,
            purpose: 'user' as 'user' | 'sprite_runner',
            revokedAt: null as Date | null,
            expiresAt: null as Date | null
        }
    ]
    runtimeIds: string[] = []
    updates: Array<Partial<RuntimeHostRow>> = []
    hostDeletes = 0
    runtimeDeletes = 0
    deleteOrder: string[] = []

    async transaction<T>(fn: (tx: HostDb) => Promise<T>): Promise<T> {
        return fn(this)
    }

    async execute(): Promise<void> {}

    select() {
        return {
            from: (table: unknown) => ({
                where: () => {
                    const selected =
                        table === daemonTokens ? this.tokens : this.rows
                    return {
                        for: () => ({
                            limit: async () => selected.slice(0, 1)
                        }),
                        limit: async () => selected.slice(0, 1)
                    }
                }
            })
        }
    }

    update(table: unknown) {
        return {
            set: (patch: Partial<RuntimeHostRow> & { daemonId?: string }) => ({
                where: () => {
                    if (table === daemonTokens) {
                        Object.assign(this.tokens[0], patch)
                        return Promise.resolve()
                    }
                    this.updates.push(patch)
                    if (this.rows[0]) Object.assign(this.rows[0], patch)
                    return {
                        returning: async () => this.rows.slice(0, 1)
                    }
                }
            })
        }
    }

    insert(_tbl: unknown) {
        return {
            values: (values: Partial<RuntimeHostRow>) => {
                const returning = async () => {
                    const row = host(values)
                    this.rows.push(row)
                    return [row]
                }
                return {
                    returning,
                    onConflictDoUpdate: () => ({ returning })
                }
            }
        }
    }

    delete(table: unknown) {
        return {
            where: () => ({
                returning: async () => {
                    if (table === agentRuntimes) {
                        const deleted = this.runtimeIds.splice(0)
                        this.runtimeDeletes += deleted.length
                        this.deleteOrder.push('runtimes')
                        return deleted.map((id) => ({ id }))
                    }
                    if (table !== runtimeHosts)
                        throw new Error('unexpected delete table')
                    const deleted = this.rows.splice(0)
                    this.hostDeletes += deleted.length
                    this.deleteOrder.push('host')
                    return deleted.map((row) => ({ id: row.id }))
                }
            })
        }
    }
}

const host = (overrides: Partial<RuntimeHostRow> = {}): RuntimeHostRow =>
    ({
        id: 'dh-1',
        userId: 'u1',
        kind: 'daemon',
        daemonUuid: 'uuid-1',
        name: 'laptop',
        hostname: 'laptop.local',
        os: 'darwin',
        arch: 'arm64',
        cliVersion: '0.0.1',
        homeDir: '/Users/me',
        workspaceBaseDir: '/Users/me/.nca/workspaces',
        detectedFrameworks: [],
        lastSeenAt: new Date(Date.now() - 10_000),
        lastIp: null,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides
    }) as RuntimeHostRow

const hostService = (
    db: Database,
    runtimeAccess: unknown = {
        lockDaemonHostRegistrationInTx: async () => {},
        assertDaemonHostSlotAvailableInTx: async () => {}
    }
): DaemonHostService =>
    new DaemonHostService(
        db,
        runtimeAccess as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { get: () => undefined } as never
    )

test('revoked daemon heartbeat is rejected and does not reactivate host', async () => {
    const db = new HostDb()
    db.rows = [host({ status: 'revoked' })]
    const service = hostService(db as unknown as Database)

    await assert.rejects(
        () =>
            service.heartbeat({
                daemonId: 'dh-1',
                detectedFrameworks: [],
                cliVersion: '0.0.1',
                startupMethod: 'manual'
            }),
        ForbiddenException
    )

    assert.equal(db.rows[0].status, 'revoked')
    assert.equal(db.updates.length, 0)
})

test('revoked daemon re-register reactivates the host', async () => {
    const db = new HostDb()
    db.rows = [host({ status: 'revoked' })]
    const service = hostService(
        db as unknown as Database,
        {
            lockDaemonHostRegistrationInTx: async () => {},
            assertDaemonHostSlotAvailableInTx: async () => {}
        } as never
    )

    const updated = await service.upsertOnRegister({
        tokenId: 'ldt-1',
        request: {
            daemonUuid: 'uuid-1',
            name: 'laptop',
            hostname: 'laptop.local',
            os: 'darwin',
            arch: 'arm64',
            cliVersion: '0.0.1',
            homeDir: '/Users/me',
            workspaceBaseDir: '/Users/me/.nca/workspaces',
            detectedFrameworks: []
        },
        lastIp: null
    })

    assert.equal(updated.status, 'active')
    assert.equal(db.rows[0].status, 'active')
})

test('heartbeat persists terminalPty and resets it when absent', async () => {
    const db = new HostDb()
    db.rows = [host()]
    const service = hostService(db as unknown as Database)

    await service.heartbeat({
        daemonId: 'dh-1',
        detectedFrameworks: [],
        cliVersion: '0.0.2',
        startupMethod: 'manual',
        terminalPty: true
    })
    assert.equal(db.updates[0].terminalPty, true)

    await service.heartbeat({
        daemonId: 'dh-1',
        detectedFrameworks: [],
        cliVersion: '0.0.1',
        startupMethod: 'manual'
    })
    assert.equal(db.updates[1].terminalPty, null)
})

test('register persists terminalPty from the request', async () => {
    const db = new HostDb()
    db.rows = [host()]
    const service = hostService(
        db as unknown as Database,
        {
            lockDaemonHostRegistrationInTx: async () => {},
            assertDaemonHostSlotAvailableInTx: async () => {}
        } as never
    )

    await service.upsertOnRegister({
        tokenId: 'ldt-1',
        request: {
            daemonUuid: 'uuid-1',
            name: 'laptop',
            hostname: 'laptop.local',
            os: 'darwin',
            arch: 'arm64',
            cliVersion: '0.0.2',
            homeDir: '/Users/me',
            workspaceBaseDir: '/Users/me/.nca/workspaces',
            detectedFrameworks: [],
            terminalPty: true
        },
        lastIp: null
    })

    assert.equal(db.updates[0].terminalPty, true)
})

test('only a managed token skips the always-online reservation', async () => {
    const registerArgs = () => ({
        tokenId: 'ldt-1',
        request: {
            daemonUuid: 'uuid-1',
            name: 'sprite-runner:art-abc',
            hostname: 'sprite',
            os: 'linux',
            arch: 'x86_64',
            cliVersion: '0.22.3',
            homeDir: '/home/sprite',
            workspaceBaseDir: '/home/sprite/.manyfold/workspaces',
            detectedFrameworks: []
        },
        lastIp: null
    })
    let reserved = 0
    const runtimeAccess = {
        lockDaemonHostRegistrationInTx: async () => {},
        assertDaemonHostSlotAvailableInTx: async () => {
            reserved++
        }
    }

    // The deadlock in #804: the user's one Free slot is already theirs, so
    // charging the platform's own runner to it can never succeed.
    const managedDb = new HostDb()
    managedDb.tokens[0].purpose = 'sprite_runner'
    const managed = await hostService(
        managedDb as unknown as Database,
        runtimeAccess
    ).upsertOnRegister(registerArgs())
    assert.equal(reserved, 0)
    assert.equal(managed.managed, true)

    // Same name, same body — a register that is not vouched for by its token
    // still pays.
    const ordinaryDb = new HostDb()
    const ordinary = await hostService(
        ordinaryDb as unknown as Database,
        runtimeAccess
    ).upsertOnRegister(registerArgs())
    assert.equal(reserved, 1)
    assert.equal(ordinary.managed, false)
})

test('revoked daemon touchLastSeen is ignored', async () => {
    const db = new HostDb()
    db.rows = [host({ status: 'revoked' })]
    const service = hostService(db as unknown as Database)

    await service.touchLastSeen('dh-1')

    assert.equal(db.rows[0].status, 'revoked')
    assert.equal(db.updates.length, 0)
})

test('daemon deletion requires revoke before removing the registration', async () => {
    const db = new HostDb()
    db.rows = [host()]
    const service = hostService(db as unknown as Database)

    await assert.rejects(
        () =>
            service.deleteRevoked({
                id: 'dh-1',
                actorId: 'u1',
                userId: 'u1'
            }),
        ConflictException
    )

    assert.equal(db.hostDeletes, 0)
    assert.equal(db.runtimeDeletes, 0)
    assert.equal(db.rows.length, 1)
})

test('daemon deletion is owner-scoped and removes its runtimes before the revoked machine', async () => {
    const db = new HostDb()
    const service = hostService(db as unknown as Database)

    db.rows = [host({ kind: 'sandbox', status: 'revoked' })]
    await assert.rejects(
        () =>
            service.deleteRevoked({
                id: 'dh-1',
                actorId: 'u1',
                userId: 'u1'
            }),
        NotFoundException
    )
    assert.equal(db.hostDeletes, 0)
    assert.equal(db.runtimeDeletes, 0)

    db.rows = [host({ status: 'revoked' })]
    await assert.rejects(
        () =>
            service.deleteRevoked({
                id: 'dh-1',
                actorId: 'u2',
                userId: 'u2'
            }),
        NotFoundException
    )
    assert.equal(db.hostDeletes, 0)
    assert.equal(db.runtimeDeletes, 0)

    db.runtimeIds = ['rt-1', 'rt-2']
    await service.deleteRevoked({
        id: 'dh-1',
        actorId: 'u1',
        userId: 'u1'
    })

    assert.equal(db.runtimeDeletes, 2)
    assert.equal(db.hostDeletes, 1)
    assert.deepEqual(db.deleteOrder, ['runtimes', 'host'])
    assert.equal(db.rows.length, 0)
})

test('daemon gateway rejects websocket connections for revoked hosts', async () => {
    const socket = {
        code: 0,
        reason: '',
        close(code: number, reason: string) {
            this.code = code
            this.reason = reason
        },
        on: () => {},
        send: () => {}
    }
    const gateway = new DaemonGateway(
        {} as never,
        {} as never,
        {
            verify: async () => ({
                tokenId: 'ldt-1',
                userId: 'u1',
                daemonId: 'dh-1'
            })
        } as never,
        {
            findById: async () => host({ status: 'revoked' })
        } as never,
        {} as never,
        {} as never
    )

    await (
        gateway as unknown as {
            handleConnection(socket: unknown, req: unknown): Promise<void>
        }
    ).handleConnection(socket, { query: { token: 'ldt_token' } })

    assert.equal(socket.code, 4403)
    assert.equal(socket.reason, 'daemon revoked')
})

test('revoking host or token disconnects active daemon connection', async () => {
    const disconnected: Array<{ daemonId: string; reason: string }> = []
    const registry = {
        disconnect: (daemonId: string, reason: string) => {
            disconnected.push({ daemonId, reason })
        }
    }
    const controller = new DaemonController(
        { insert: () => ({ values: async () => undefined }) } as never,
        { revoke: async () => 'dh-1' } as never,
        { revoke: async () => undefined } as never,
        {} as never,
        {} as never,
        registry as never
    )

    await controller.revokeToken({ userId: 'u1' } as never, 'ldt-1')
    await controller.revokeHost({ userId: 'u1' } as never, 'dh-1')

    assert.deepEqual(disconnected, [
        { daemonId: 'dh-1', reason: 'daemon token revoked' },
        { daemonId: 'dh-1', reason: 'daemon host revoked' }
    ])
})
