import test from 'node:test'
import assert from 'node:assert/strict'
import {
    agentRuntimes,
    daemonTokens,
    hostDaemons,
    runtimeHosts,
    type Database,
    type HostDaemonRow,
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
import {
    CLI_ABOVE_FLOOR,
    CLI_AT_FLOOR,
    CLI_BELOW_FLOOR,
    FLOOR_REFUSAL
} from './helpers/cli-floor'

interface TokenRow {
    id: string
    userId: string
    hostId: string | null
    revokedAt: Date | null
    expiresAt: Date | null
}

// Predicates are opaque, so every select answers with the whole table and
// each test holds exactly the rows the call under test should see. The one
// join the register path runs — host_daemons by (user, daemon uuid) onto its
// host — is answered from the daemon rows the test planted.
class HostDb {
    hosts: RuntimeHostRow[] = []
    daemons: HostDaemonRow[] = []
    tokens: TokenRow[] = [
        { id: 'ldt-1', userId: 'u1', hostId: null, revokedAt: null, expiresAt: null }
    ]
    runtimeIds: string[] = []
    agentCount = 0
    hostUpdates: Array<Partial<RuntimeHostRow>> = []
    tokenUpdates: Array<Partial<TokenRow>> = []
    deleteOrder: string[] = []

    async transaction<T>(fn: (tx: HostDb) => Promise<T>): Promise<T> {
        return fn(this)
    }

    async execute(): Promise<void> {}

    select(shape?: Record<string, unknown>) {
        let table: unknown
        let joined = false
        const rows = (): unknown[] => {
            if (shape && 'value' in shape) return [{ value: this.agentCount }]
            if (table === daemonTokens) return this.tokens.slice()
            if (table === runtimeHosts) return this.hosts.slice()
            if (table === hostDaemons && joined)
                return this.daemons
                    .map((daemon) => ({
                        host: this.hosts.find((h) => h.id === daemon.hostId),
                        daemon
                    }))
                    .filter((r) => r.host)
            if (table === hostDaemons) return this.daemons.slice()
            return []
        }
        const builder = {
            from(tbl: unknown) {
                table = tbl
                return builder
            },
            innerJoin() {
                joined = true
                return builder
            },
            where() {
                return builder
            },
            for() {
                return builder
            },
            limit: async () => rows().slice(0, 1),
            then: (resolve: (rows: unknown[]) => unknown) =>
                Promise.resolve(rows()).then(resolve)
        }
        return builder
    }

    update(table: unknown) {
        return {
            set: (patch: Record<string, unknown>) => ({
                where: () => {
                    if (table === daemonTokens) {
                        this.tokenUpdates.push(patch)
                        for (const t of this.tokens) Object.assign(t, patch)
                        return Object.assign(Promise.resolve(), {
                            returning: async () =>
                                this.tokens.map((t) => ({ id: t.id, hostId: t.hostId }))
                        })
                    }
                    if (table === runtimeHosts) {
                        this.hostUpdates.push(patch)
                        for (const h of this.hosts) Object.assign(h, patch)
                        return {
                            returning: async () => this.hosts.slice(0, 1)
                        }
                    }
                    throw new Error('unexpected update table')
                }
            })
        }
    }

    insert(table: unknown) {
        return {
            values: (values: Partial<RuntimeHostRow>) => ({
                returning: async () => {
                    if (table !== runtimeHosts)
                        throw new Error('unexpected insert table')
                    const row = host({ ...values, id: values.id ?? 'dh-new' })
                    this.hosts.push(row)
                    return [row]
                }
            })
        }
    }

    delete(table: unknown) {
        return {
            where: () => {
                const run = async () => {
                    if (table === agentRuntimes) {
                        const deleted = this.runtimeIds.splice(0)
                        this.deleteOrder.push('runtimes')
                        return deleted.map((id) => ({ id }))
                    }
                    if (table === hostDaemons) {
                        const deleted = this.daemons.splice(0)
                        this.deleteOrder.push('daemon')
                        return deleted.map((d) => ({ hostId: d.hostId }))
                    }
                    if (table === runtimeHosts) {
                        const deleted = this.hosts.splice(0)
                        this.deleteOrder.push('host')
                        return deleted.map((row) => ({ id: row.id }))
                    }
                    this.deleteOrder.push('leases')
                    return []
                }
                const once = run()
                return Object.assign(once, { returning: () => once })
            }
        }
    }
}

const host = (overrides: Partial<RuntimeHostRow> = {}): RuntimeHostRow =>
    ({
        id: 'dh-1',
        userId: 'u1',
        kind: 'local',
        providerId: null,
        providerRef: null,
        name: 'laptop',
        status: 'ready',
        failureReason: null,
        generation: 0,
        powerState: null,
        homeDir: '/Users/me',
        workspaceBaseDir: '/Users/me/.manyfold/workspaces',
        skillsDir: null,
        keepAwake: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides
    }) as RuntimeHostRow

const daemon = (overrides: Partial<HostDaemonRow> = {}): HostDaemonRow =>
    ({
        hostId: 'dh-1',
        userId: 'u1',
        daemonUuid: 'uuid-1',
        tokenId: 'ldt-1',
        hostname: 'laptop.local',
        os: 'darwin',
        arch: 'arm64',
        cliVersion: CLI_AT_FLOOR,
        herdrVersion: null,
        startupMethod: 'launchd-user',
        clientFeatures: [],
        terminalPty: null,
        detectedFrameworks: [],
        registeredAt: new Date(),
        lastSeenAt: new Date(Date.now() - 10_000),
        lastIp: null,
        rpcInstanceId: null,
        rpcConnectionToken: null,
        rpcInbox: null,
        rpcConnectedAt: null,
        rpcLastSeenAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides
    }) as HostDaemonRow

const registerRequest = (overrides: Record<string, unknown> = {}) => ({
    daemonUuid: 'uuid-1',
    name: 'laptop',
    hostname: 'laptop.local',
    os: 'darwin',
    arch: 'arm64',
    cliVersion: CLI_AT_FLOOR,
    homeDir: '/Users/me',
    workspaceBaseDir: '/Users/me/.manyfold/workspaces',
    detectedFrameworks: [],
    ...overrides
})

// The hosts and host_daemons services over the same fake tables, plus what
// the fake records of them.
const wire = (db: HostDb) => {
    const upserts: Array<{ hostId: string; values: Record<string, unknown> }> = []
    const daemonPatches: Array<Partial<HostDaemonRow>> = []
    const hosts = {
        findById: async (id: string) => db.hosts.find((h) => h.id === id) ?? null,
        listForUser: async (userId: string, kind?: string) =>
            db.hosts.filter((h) => h.userId === userId && (!kind || h.kind === kind))
    }
    const hostDaemonsService = {
        findByHostId: async (hostId: string) =>
            db.daemons.find((d) => d.hostId === hostId) ?? null,
        upsert: async (hostId: string, values: Record<string, unknown>) => {
            upserts.push({ hostId, values })
            const existing = db.daemons.find((d) => d.hostId === hostId)
            if (existing) {
                Object.assign(existing, values)
                return existing
            }
            const row = daemon({ hostId, ...(values as Partial<HostDaemonRow>) })
            db.daemons.push(row)
            return row
        },
        patch: async (hostId: string, patch: Partial<HostDaemonRow>) => {
            daemonPatches.push(patch)
            const row = db.daemons.find((d) => d.hostId === hostId) ?? null
            if (row) Object.assign(row, patch)
            return row
        },
        deleteByHostId: async () => {
            db.daemons.splice(0)
            db.deleteOrder.push('daemon')
        }
    }
    const revokedForHosts: string[] = []
    const tokens = {
        revokeForHost: async (hostId: string) => {
            revokedForHosts.push(hostId)
            return 1
        }
    }
    const disconnected: Array<{ daemonId: string; reason: string }> = []
    const registry = {
        disconnect: (daemonId: string, reason: string) => {
            disconnected.push({ daemonId, reason })
        }
    }
    return {
        hosts,
        hostDaemonsService,
        tokens,
        registry,
        upserts,
        daemonPatches,
        revokedForHosts,
        disconnected
    }
}

const hostService = (
    db: HostDb,
    runtimeAccess: {
        lockDaemonHostRegistrationInTx: () => Promise<void>
        assertDaemonHostSlotAvailableInTx: () => Promise<void>
    } = {
        lockDaemonHostRegistrationInTx: async () => {},
        assertDaemonHostSlotAvailableInTx: async () => {}
    }
) => {
    const wired = wire(db)
    const service = new DaemonHostService(
        db as unknown as Database,
        runtimeAccess as never,
        { getCachedCliMinimumVersion: async () => ({ minVersion: null }) } as never,
        wired.registry as never,
        { consume: () => {} } as never,
        { getCachedLatest: async () => ({ version: null, channel: 'stable' }) } as never,
        { isInstallableVersion: async () => true } as never,
        { get: () => undefined } as never,
        wired.hosts as never,
        wired.hostDaemonsService as never,
        wired.tokens as never
    )
    return { service, ...wired }
}

test('retired daemon versions cannot register or update heartbeat metadata', async () => {
    for (const cliVersion of [CLI_BELOW_FLOOR, '0.33.9', '', 'unknown']) {
        const db = new HostDb()
        db.hosts = [host()]
        db.daemons = [daemon()]
        const { service, daemonPatches } = hostService(db)
        await assert.rejects(
            () =>
                service.upsertOnRegister({
                    tokenId: 'ldt-1',
                    request: { cliVersion } as never,
                    lastIp: null
                }),
            FLOOR_REFUSAL
        )
        await assert.rejects(
            () =>
                service.heartbeat({
                    daemonId: 'dh-1',
                    detectedFrameworks: [],
                    startupMethod: 'manual',
                    cliVersion
                }),
            FLOOR_REFUSAL
        )
        assert.equal(db.hostUpdates.length, 0)
        assert.equal(daemonPatches.length, 0)
    }
})

// R1/R5: a token nobody bound is the user's own; its first register makes
// the local host, takes the always-online slot and binds the token to it.
test('an unbound token creates a local host on first register and binds to it', async () => {
    const db = new HostDb()
    let reserved = 0
    const { service, upserts } = hostService(db, {
        lockDaemonHostRegistrationInTx: async () => {},
        assertDaemonHostSlotAvailableInTx: async () => {
            reserved++
        }
    })
    const { host: created, daemon: connection } = await service.upsertOnRegister({
        tokenId: 'ldt-1',
        request: registerRequest({ skillsDir: '/Users/me/.manyfold/skills' }),
        lastIp: '10.0.0.1'
    })
    assert.equal(reserved, 1)
    assert.equal(created.kind, 'local')
    assert.equal(created.status, 'ready')
    assert.equal(created.name, 'laptop')
    assert.equal(created.homeDir, '/Users/me')
    assert.equal(created.skillsDir, '/Users/me/.manyfold/skills')
    assert.equal(db.tokens[0].hostId, created.id, 'the token is bound in the same tx')
    assert.equal(upserts.length, 1)
    assert.equal(upserts[0].hostId, created.id)
    assert.equal(upserts[0].values.daemonUuid, 'uuid-1')
    assert.equal(upserts[0].values.tokenId, 'ldt-1')
    assert.equal(upserts[0].values.lastIp, '10.0.0.1')
    assert.equal(connection.hostId, created.id)
})

// A new token for a machine the user already connected finds the same host
// through the daemon uuid instead of making a second one.
test('an unbound token re-registers onto the local host that owns its daemon uuid', async () => {
    const db = new HostDb()
    db.hosts = [host({ name: 'renamed-by-user', homeDir: '/old' })]
    db.daemons = [daemon()]
    let reserved = 0
    const { service } = hostService(db, {
        lockDaemonHostRegistrationInTx: async () => {},
        assertDaemonHostSlotAvailableInTx: async () => {
            reserved++
        }
    })
    const { host: found } = await service.upsertOnRegister({
        tokenId: 'ldt-1',
        request: registerRequest(),
        lastIp: null
    })
    assert.equal(reserved, 0, 'the slot is already this host\'s')
    assert.equal(db.hosts.length, 1)
    assert.equal(found.id, 'dh-1')
    assert.equal(found.name, 'renamed-by-user', 'the display name is the user\'s')
    assert.equal(found.homeDir, '/Users/me', 'the declared filesystem contract is refreshed')
    assert.equal(db.tokens[0].hostId, 'dh-1')
})

test('an unbound token cannot register a hosted machine', async () => {
    const db = new HostDb()
    db.hosts = [host({ id: 'sbx-1', kind: 'hosted', providerId: 'rtp-1' })]
    db.daemons = [daemon({ hostId: 'sbx-1' })]
    const { service } = hostService(db)
    await assert.rejects(
        () =>
            service.upsertOnRegister({
                tokenId: 'ldt-1',
                request: registerRequest(),
                lastIp: null
            }),
        ForbiddenException
    )
    assert.equal(db.tokens[0].hostId, null)
})

// R5: the platform's token names the host; register can only land there,
// and the first one flips a provisioning host to ready.
test('a bound token registers onto its host and never creates one', async () => {
    const db = new HostDb()
    db.hosts = [
        host({
            id: 'sbx-1',
            kind: 'hosted',
            providerId: 'rtp-1',
            status: 'provisioning',
            name: 'sandbox-001'
        })
    ]
    db.tokens[0].hostId = 'sbx-1'
    let reserved = 0
    const { service, upserts } = hostService(db, {
        lockDaemonHostRegistrationInTx: async () => {},
        assertDaemonHostSlotAvailableInTx: async () => {
            reserved++
        }
    })
    const { host: bound } = await service.upsertOnRegister({
        tokenId: 'ldt-1',
        request: registerRequest({ daemonUuid: 'uuid-sprite', name: 'whatever' }),
        lastIp: null
    })
    assert.equal(reserved, 0, 'a hosted host takes no always-online slot')
    assert.equal(db.hosts.length, 1, 'nothing was created')
    assert.equal(bound.id, 'sbx-1')
    assert.equal(bound.status, 'ready')
    assert.equal(bound.name, 'sandbox-001', 'the reported name never renames a host')
    assert.equal(upserts[0].hostId, 'sbx-1')
    assert.equal(upserts[0].values.daemonUuid, 'uuid-sprite')
})

test('a bound token whose host is gone is refused', async () => {
    const db = new HostDb()
    db.tokens[0].hostId = 'sbx-gone'
    const { service } = hostService(db)
    await assert.rejects(
        () =>
            service.upsertOnRegister({
                tokenId: 'ldt-1',
                request: registerRequest(),
                lastIp: null
            }),
        ForbiddenException
    )
    assert.equal(db.hosts.length, 0)
})

test('a retired host refuses register and heartbeat, and is never reactivated', async () => {
    const db = new HostDb()
    db.hosts = [host({ status: 'retired' })]
    db.daemons = [daemon()]
    db.tokens[0].hostId = 'dh-1'
    const { service, daemonPatches } = hostService(db)
    await assert.rejects(
        () =>
            service.upsertOnRegister({
                tokenId: 'ldt-1',
                request: registerRequest(),
                lastIp: null
            }),
        ForbiddenException
    )
    await assert.rejects(
        () =>
            service.heartbeat({
                daemonId: 'dh-1',
                detectedFrameworks: [],
                cliVersion: CLI_AT_FLOOR,
                startupMethod: 'manual'
            }),
        ForbiddenException
    )
    assert.equal(db.hosts[0].status, 'retired')
    assert.equal(db.hostUpdates.length, 0)
    assert.equal(daemonPatches.length, 0)
})

// The same computer, registered again after its host was retired, is a NEW
// host: the retired one gives up the daemon uuid it can no longer use.
test('a retired local host is not found again by its daemon uuid', async () => {
    const db = new HostDb()
    db.hosts = [host({ id: 'dh-old', status: 'retired' })]
    db.daemons = [daemon({ hostId: 'dh-old' })]
    const { service } = hostService(db)
    const { host: fresh } = await service.upsertOnRegister({
        tokenId: 'ldt-1',
        request: registerRequest(),
        lastIp: null
    })
    assert.notEqual(fresh.id, 'dh-old')
    assert.equal(fresh.status, 'ready')
    assert.equal(db.hosts.find((h) => h.id === 'dh-old')?.status, 'retired')
    assert.ok(!db.daemons.some((d) => d.hostId === 'dh-old'))
})

// R2: the 15s heartbeat is host_daemons traffic only, trimmed to the presence
// column when nothing else changed.
test('heartbeat writes host_daemons only, and just the presence column when unchanged', async () => {
    const db = new HostDb()
    db.hosts = [host()]
    db.daemons = [
        daemon({
            startupMethod: 'manual',
            clientFeatures: ['exec.resume'],
            terminalPty: null
        })
    ]
    const { service, daemonPatches } = hostService(db)

    await service.heartbeat({
        daemonId: 'dh-1',
        detectedFrameworks: [],
        cliVersion: CLI_AT_FLOOR,
        startupMethod: 'manual',
        clientFeatures: ['exec.resume']
    })
    assert.deepEqual(Object.keys(daemonPatches[0]), ['lastSeenAt'])

    await service.heartbeat({
        daemonId: 'dh-1',
        detectedFrameworks: [],
        cliVersion: CLI_ABOVE_FLOOR,
        startupMethod: 'manual',
        terminalPty: true
    })
    assert.equal(daemonPatches[1].cliVersion, CLI_ABOVE_FLOOR)
    assert.equal(daemonPatches[1].terminalPty, true)
    assert.ok(daemonPatches[1].updatedAt instanceof Date)
    assert.equal(db.hostUpdates.length, 0, 'the host row never sees a heartbeat')
})

test('register persists terminalPty and the daemon identity on host_daemons', async () => {
    const db = new HostDb()
    db.hosts = [host()]
    db.daemons = [daemon()]
    const { service, upserts } = hostService(db)
    await service.upsertOnRegister({
        tokenId: 'ldt-1',
        request: registerRequest({ terminalPty: true, cliVersion: CLI_ABOVE_FLOOR }),
        lastIp: null
    })
    assert.equal(upserts[0].values.terminalPty, true)
    assert.equal(upserts[0].values.cliVersion, CLI_ABOVE_FLOOR)
})

test('revoke retires a local host, revokes its tokens and drops the connection', async () => {
    const db = new HostDb()
    db.hosts = [host()]
    const { service, revokedForHosts, disconnected } = hostService(db)
    await service.revoke({ id: 'dh-1', userId: 'u1' })
    assert.equal(db.hosts[0].status, 'retired')
    assert.deepEqual(revokedForHosts, ['dh-1'])
    assert.deepEqual(disconnected, [
        { daemonId: 'dh-1', reason: 'daemon host revoked' }
    ])
})

test('daemon deletion requires a retired host and refuses while agents remain', async () => {
    const db = new HostDb()
    db.hosts = [host()]
    const { service } = hostService(db)
    await assert.rejects(
        () => service.deleteRetired({ id: 'dh-1', actorId: 'u1', userId: 'u1' }),
        ConflictException
    )
    db.hosts[0].status = 'retired'
    db.agentCount = 2
    await assert.rejects(
        () => service.deleteRetired({ id: 'dh-1', actorId: 'u1', userId: 'u1' }),
        ConflictException
    )
    assert.equal(db.hosts.length, 1)
    assert.deepEqual(db.deleteOrder, [])
})

test('daemon deletion is owner-scoped, local only, and removes runtimes and the connection before the host', async () => {
    const db = new HostDb()
    const { service } = hostService(db)

    db.hosts = [host({ kind: 'hosted', providerId: 'rtp-1', status: 'retired' })]
    await assert.rejects(
        () => service.deleteRetired({ id: 'dh-1', actorId: 'u1', userId: 'u1' }),
        NotFoundException
    )

    db.hosts = [host({ status: 'retired' })]
    await assert.rejects(
        () => service.deleteRetired({ id: 'dh-1', actorId: 'u2', userId: 'u2' }),
        NotFoundException
    )
    assert.deepEqual(db.deleteOrder, [])

    db.runtimeIds = ['rt-1', 'rt-2']
    db.daemons = [daemon()]
    await service.deleteRetired({ id: 'dh-1', actorId: 'u1', userId: 'u1' })
    assert.deepEqual(db.deleteOrder, ['runtimes', 'daemon', 'host', 'leases'])
    assert.equal(db.hosts.length, 0)
})

test('rename is local only', async () => {
    const db = new HostDb()
    db.hosts = []
    const { service } = hostService(db)
    await assert.rejects(
        () => service.rename({ id: 'sbx-1', userId: 'u1', name: 'x' }),
        NotFoundException
    )
})

// Presence and availability are derived (ADR-0037): the summary reads the
// daemon row's heartbeat, the host's lifecycle and each runtime's install
// state, and stores none of it.
test('toSummary derives online and runtime availability from the daemon row', async () => {
    const db = new HostDb()
    db.hosts = [host()]
    const { service } = hostService(db)
    const online = await service.toSummary(
        host(),
        daemon({ lastSeenAt: new Date() }),
        [{ runtimeId: 'art-1', framework: 'codex', name: 'laptop-codex', status: 'ready' },
         { runtimeId: 'art-2', framework: 'pi', name: 'laptop-pi', status: 'failed' }],
        1
    )
    assert.equal(online.kind, 'local')
    assert.equal(online.registered, true)
    assert.equal(online.online, true)
    assert.equal(online.status, 'ready')
    assert.equal(online.runtimes[0].availability, 'available')
    assert.equal(online.runtimes[1].availability, 'unavailable')

    const offline = await service.toSummary(
        host(),
        daemon({ lastSeenAt: new Date(Date.now() - 120_000) }),
        [{ runtimeId: 'art-1', framework: 'codex', name: 'laptop-codex', status: 'ready' }],
        0
    )
    assert.equal(offline.online, false)
    assert.equal(offline.runtimes[0].availability, 'offline')

    const never = await service.toSummary(host(), null, [], 0)
    assert.equal(never.registered, false)
    assert.equal(never.online, false)
    assert.equal(never.daemonUuid, '')
})

test('daemon gateway rejects websocket connections for retired and deleting hosts', async () => {
    for (const status of ['retired', 'deleting'] as const) {
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
                    hostId: 'dh-1'
                })
            } as never,
            {
                findById: async () => host({ status }),
                findDaemon: async () => daemon()
            } as never,
            {} as never,
            {} as never
        )

        await (
            gateway as unknown as {
                handleConnection(socket: unknown, req: unknown): Promise<void>
            }
        ).handleConnection(socket, { headers: { authorization: 'Bearer ldt_token' } })

        assert.equal(socket.code, 4403)
        assert.equal(socket.reason, `daemon host ${status}`)
    }
})

test('daemon gateway checks the CLI floor against the registered daemon', async () => {
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
            verify: async () => ({ tokenId: 'ldt-1', userId: 'u1', hostId: 'dh-1' })
        } as never,
        {
            findById: async () => host(),
            findDaemon: async () => daemon({ cliVersion: CLI_BELOW_FLOOR })
        } as never,
        {} as never,
        {} as never
    )
    await (
        gateway as unknown as {
            handleConnection(socket: unknown, req: unknown): Promise<void>
        }
    ).handleConnection(socket, { headers: { authorization: 'Bearer ldt_token' } })
    assert.equal(socket.code, 4406)
})

test('revoking a token disconnects the daemon of the host it was bound to', async () => {
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
        {} as never,
        registry as never
    )

    await controller.revokeToken({ userId: 'u1' } as never, 'ldt-1')

    assert.deepEqual(disconnected, [
        { daemonId: 'dh-1', reason: 'daemon token revoked' }
    ])
})
