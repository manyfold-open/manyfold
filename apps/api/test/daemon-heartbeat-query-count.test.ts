import type { DetectedFramework } from '@manyfold/shared'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
    agents,
    agentRuntimes,
    type AgentRuntimeRow,
    type Database,
    type HostDaemonRow,
    type RuntimeHostRow
} from '@manyfold/db'
import { DaemonController } from '../src/modules/daemon/daemon.controller'
import { DaemonHostService } from '../src/modules/daemon/daemon-host.service'
import { DaemonRuntimeSyncService } from '../src/modules/daemon/daemon-runtime-sync.service'
import { CLI_ABOVE_FLOOR, CLI_AT_FLOOR } from './helpers/cli-floor'

// #629: the 15s daemon heartbeat drove syncForDaemon, which rewrote EVERY
// matched runtime row — production/staging measured 47,711 runtime UPDATEs
// over 13,834 heartbeats. The reconcile must diff before writing and batch
// what is left, so a same-value heartbeat costs zero runtime UPDATEs and the
// cost stops scaling with the detected framework count. ADR-0036 also took
// the agents statements away: nothing about an agent follows a heartbeat.

const HOST_HOME = '/Users/me'
const HOST_WORKSPACES = '/Users/me/.manyfold/workspaces'

const FRAMEWORKS = [
    'claude-code',
    'codex',
    'gemini-cli',
    'openclaw',
    'hermes'
] as const

type Statement = {
    op: 'select' | 'update' | 'insert'
    table: 'agent_runtimes' | 'agents' | 'other'
    set?: Record<string, unknown>
}

const tableOf = (tbl: unknown): Statement['table'] => {
    if (tbl === agentRuntimes) return 'agent_runtimes'
    if (tbl === agents) return 'agents'
    return 'other'
}

// Every builder method returns the same thenable, so both `await
// db.update(x).set(y).where(z)` and `.where(z).returning()` resolve to `rows`.
const chain = (rows: unknown[]) => {
    const b = Object.assign(Promise.resolve(rows), {}) as unknown as Record<
        string,
        unknown
    >
    for (const method of ['from', 'where', 'limit', 'orderBy', 'returning', 'onConflictDoUpdate'])
        b[method] = () => b
    return b
}

class CountingDb {
    readonly statements: Statement[] = []

    constructor(private readonly rows: AgentRuntimeRow[]) {}

    select() {
        this.statements.push({ op: 'select', table: 'agent_runtimes' })
        return chain(this.rows.slice())
    }

    update(tbl: unknown) {
        return {
            set: (set: Record<string, unknown>) => {
                this.statements.push({ op: 'update', table: tableOf(tbl), set })
                return chain(this.rows.map((r) => ({ ...r, ...set })))
            }
        }
    }

    insert(tbl: unknown) {
        return {
            values: (values: Record<string, unknown>) => {
                this.statements.push({
                    op: 'insert',
                    table: tableOf(tbl),
                    set: values
                })
                return chain([values])
            }
        }
    }

    of(op: Statement['op'], table: Statement['table']): Statement[] {
        return this.statements.filter((s) => s.op === op && s.table === table)
    }
}

const host = (overrides: Partial<RuntimeHostRow> = {}): RuntimeHostRow =>
    ({
        id: 'dh-1',
        userId: 'u1',
        kind: 'local',
        providerId: null,
        providerRef: null,
        name: 'mac-laptop',
        status: 'ready',
        failureReason: null,
        generation: 0,
        homeDir: HOST_HOME,
        workspaceBaseDir: HOST_WORKSPACES,
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
        hostname: 'mac.local',
        os: 'darwin',
        arch: 'arm64',
        cliVersion: CLI_AT_FLOOR,
        herdrVersion: null,
        startupMethod: 'launchd-user',
        clientFeatures: [],
        terminalPty: null,
        detectedFrameworks: [],
        registeredAt: new Date(),
        lastSeenAt: new Date(),
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

const mountPathFor = (framework: string): string => {
    if (framework === 'openclaw') return `${HOST_HOME}/.openclaw`
    if (framework === 'hermes') return `${HOST_HOME}/.hermes`
    return HOST_WORKSPACES
}

const detected = (count: number): DetectedFramework[] =>
    FRAMEWORKS.slice(0, count).map((framework) => ({
        framework,
        version: '1.2.3',
        path: `/usr/local/bin/${framework}`
    }))

// A row already carrying exactly what this heartbeat reports: same mount
// path, same parsed version, same detection payload, and a probe timestamp
// fresh enough that no freshness touch is due.
const convergedRow = (
    framework: string,
    overrides: Partial<AgentRuntimeRow> = {}
): AgentRuntimeRow =>
    ({
        id: `art-${framework}`,
        userId: 'u1',
        name: `mac-laptop-${framework}`,
        framework,
        status: 'ready',
        hostId: 'dh-1',
        mountPath: mountPathFor(framework),
        capabilitiesJson: { detectedVersion: '1.2.3' },
        frameworkVersion: '1.2.3',
        frameworkVersionCheckedAt: new Date(),
        failureReason: null,
        serviceStatus: 'unknown',
        serviceStatusAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides
    }) as AgentRuntimeRow

const convergedRows = (count: number): AgentRuntimeRow[] =>
    FRAMEWORKS.slice(0, count).map((f) => convergedRow(f))

const syncWith = async (
    rows: AgentRuntimeRow[],
    frameworks: DetectedFramework[],
    hostRow: RuntimeHostRow = host()
): Promise<CountingDb> => {
    const db = new CountingDb(rows)
    const svc = new DaemonRuntimeSyncService(db as unknown as Database)
    await svc.syncForDaemon({ host: hostRow, detectedFrameworks: frameworks })
    return db
}

test('a same-value heartbeat writes no runtime row and never touches agents', async () => {
    const db = await syncWith(convergedRows(4), detected(4))

    assert.deepEqual(
        db.of('update', 'agent_runtimes').filter((s) => s.set?.status !== 'failed'),
        [],
        'unchanged runtimes must not be rewritten every 15s'
    )
    assert.deepEqual(db.of('insert', 'agent_runtimes'), [])
    assert.deepEqual(
        db.of('update', 'agents'),
        [],
        'presence never flips an agent (ADR-0036)'
    )
})

test('heartbeat write cost does not grow with the framework count', async () => {
    const one = await syncWith(convergedRows(1), detected(1))
    const five = await syncWith(convergedRows(5), detected(5))

    const writes = (db: CountingDb) =>
        db.statements.filter((s) => s.op !== 'select').length
    assert.equal(
        writes(five),
        writes(one),
        'statements per heartbeat must not scale with detected frameworks'
    )
})

test('a hosted host\'s heartbeat costs no runtime statement at all', async () => {
    const db = await syncWith(
        convergedRows(3),
        detected(3),
        host({ kind: 'hosted', providerId: 'rtp-1' })
    )
    assert.deepEqual(db.statements, [])
})

test('one changed runtime costs exactly one batched runtime UPDATE', async () => {
    const rows = convergedRows(4)
    rows[2] = convergedRow(rows[2].framework, { frameworkVersion: '1.0.0' })

    const db = await syncWith(rows, detected(4))

    const updates = db
        .of('update', 'agent_runtimes')
        .filter((s) => s.set?.status !== 'failed')
    assert.equal(updates.length, 1, 'only the diverging runtime is written')
    assert.equal(updates[0].set?.frameworkVersion, '1.2.3')
    assert.ok(
        updates[0].set?.frameworkVersionCheckedAt instanceof Date,
        'a genuinely new probed version restamps checkedAt'
    )
})

test('a cached detection payload does not restamp frameworkVersionCheckedAt', async () => {
    // The CLI re-probes `<bin> --version` every 5 minutes and replays the cached
    // result on the other 19 heartbeats; stamping checkedAt=now each time turned
    // a 5-minute probe into a 15-second freshness claim.
    const db = await syncWith(convergedRows(3), detected(3))

    const stamped = db.statements.filter(
        (s) => s.set && 'frameworkVersionCheckedAt' in s.set
    )
    assert.deepEqual(
        stamped,
        [],
        'a heartbeat carrying an already-known version claims no new probe'
    )
})

test('the version freshness touch is a single batched statement', async () => {
    const stale = new Date(Date.now() - 60 * 60_000)
    const rows = FRAMEWORKS.slice(0, 4).map((f) =>
        convergedRow(f, { frameworkVersionCheckedAt: stale })
    )

    const db = await syncWith(rows, detected(4))

    const updates = db
        .of('update', 'agent_runtimes')
        .filter((s) => s.set?.status !== 'failed')
    assert.equal(
        updates.length,
        1,
        'freshness must be one statement for every runtime of the host'
    )
    assert.ok(updates[0].set?.frameworkVersionCheckedAt instanceof Date)
    assert.equal(
        updates[0].set?.status,
        undefined,
        'the cheap touch must not carry the full-row rewrite'
    )
    assert.equal(updates[0].set?.capabilitiesJson, undefined)
})

test('a newly missing framework fails its runtime in one statement, agents untouched', async () => {
    const db = await syncWith(convergedRows(3), detected(2))

    const failed = db
        .of('update', 'agent_runtimes')
        .filter((s) => s.set?.status === 'failed')
    assert.equal(failed.length, 1)
    assert.equal(failed[0].set?.failureReason, 'framework not detected')
    assert.deepEqual(db.of('update', 'agents'), [])
})

test('a failed inventory that is back again is revived in one batched statement', async () => {
    const rows = convergedRows(3).map((r) => ({ ...r, status: 'failed' }))

    const db = await syncWith(rows as AgentRuntimeRow[], detected(3))

    const updates = db
        .of('update', 'agent_runtimes')
        .filter((s) => s.set?.status === 'ready')
    assert.equal(updates.length, 1, 'one batched revive for the whole host')
    assert.deepEqual(db.of('update', 'agents'), [])
})

const heartbeatArgs = {
    daemonId: 'dh-1',
    detectedFrameworks: detected(3),
    cliVersion: CLI_AT_FLOOR,
    startupMethod: 'launchd-user' as const,
    clientFeatures: ['exec.resume']
}

// The heartbeat's own write goes to host_daemons through the daemons
// service, and the host row is read once and never written.
const hostService = (row: HostDaemonRow) => {
    const patches: Array<Partial<HostDaemonRow>> = []
    const hostReads = { count: 0 }
    const service = new DaemonHostService(
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { get: () => undefined } as never,
        {
            findById: async () => {
                hostReads.count += 1
                return host()
            }
        } as never,
        {
            findByHostId: async () => row,
            patch: async (_hostId: string, patch: Partial<HostDaemonRow>) => {
                patches.push(patch)
                Object.assign(row, patch)
                return row
            }
        } as never,
        {} as never
    )
    return { service, patches, hostReads }
}

test('a same-value daemon heartbeat writes only the presence column', async () => {
    const { service, patches } = hostService(
        daemon({
            detectedFrameworks: detected(3),
            startupMethod: 'launchd-user',
            clientFeatures: ['exec.resume'],
            terminalPty: null
        })
    )

    await service.heartbeat(heartbeatArgs)

    assert.deepEqual(
        Object.keys(patches[0]),
        ['lastSeenAt'],
        'unchanged metadata (including the detectedFrameworks JSONB) is not rewritten'
    )
})

test('changed daemon metadata is written alongside the presence column', async () => {
    const { service, patches, hostReads } = hostService(
        daemon({
            detectedFrameworks: detected(3),
            startupMethod: 'launchd-user',
            clientFeatures: ['exec.resume'],
            terminalPty: null
        })
    )

    await service.heartbeat({ ...heartbeatArgs, cliVersion: CLI_ABOVE_FLOOR })

    assert.equal(patches[0].cliVersion, CLI_ABOVE_FLOOR)
    assert.ok(patches[0].updatedAt instanceof Date)
    assert.ok(patches[0].lastSeenAt instanceof Date)
    assert.equal(hostReads.count, 1)
})

test('the heartbeat route resolves its host with a single read', async () => {
    const reads: string[] = []
    const hostRow = host()
    const controller = new DaemonController(
        undefined as never,
        undefined as never,
        {
            heartbeat: async () => {
                reads.push('heartbeat')
                return { host: hostRow, daemon: daemon() }
            },
            findById: async () => {
                reads.push('findById')
                return hostRow
            }
        } as never,
        undefined as never,
        { syncForDaemon: async () => [] } as never,
        { consume: () => {} } as never,
        undefined as never
    )

    await controller.heartbeat(
        { tokenId: 'ldt-1', userId: 'u1', hostId: 'dh-1' },
        {
            detectedFrameworks: detected(3),
            cliVersion: CLI_AT_FLOOR,
            startupMethod: 'launchd-user'
        }
    )

    assert.deepEqual(
        reads,
        ['heartbeat'],
        'the write already returns the row; re-reading it doubles the host reads'
    )
})
