import type { DetectedFramework } from '@manyfold/shared'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
    agents,
    agentRuntimes,
    type AgentRuntimeRow,
    type Database,
    type RuntimeHostRow
} from '@manyfold/db'
import { DaemonController } from '../src/modules/daemon/daemon.controller'
import { DaemonHostService } from '../src/modules/daemon/daemon-host.service'
import { DaemonRuntimeSyncService } from '../src/modules/daemon/daemon-runtime-sync.service'

// #629: the 15s daemon heartbeat drove syncForDaemon, which rewrote EVERY
// matched runtime row and then issued one stopped->running agents UPDATE per
// runtime — 2F statements per heartbeat (production/staging measured 47,711
// runtime UPDATEs paired with 47,711 agents statements over 13,834 heartbeats,
// 3.45 pairs each). The reconcile must diff before writing and batch what is
// left, so a same-value heartbeat costs zero runtime UPDATEs and the cost stops
// scaling with the detected framework count.

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
    for (const method of ['from', 'where', 'limit', 'orderBy', 'returning'])
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
        kind: 'daemon',
        daemonUuid: 'uuid-1',
        name: 'mac-laptop',
        hostname: 'mac.local',
        os: 'darwin',
        arch: 'arm64',
        cliVersion: '0.0.1',
        homeDir: HOST_HOME,
        workspaceBaseDir: HOST_WORKSPACES,
        detectedFrameworks: [],
        clientFeatures: [],
        lastSeenAt: new Date(),
        lastIp: null,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides
    }) as RuntimeHostRow

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

// A row already carrying exactly what this heartbeat reports: same host dirs,
// same mount path, same parsed version, same detection payload, and timestamps
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
        kind: 'daemon',
        status: 'ready',
        daemonId: 'dh-1',
        homeDir: HOST_HOME,
        workspaceBaseDir: HOST_WORKSPACES,
        mountPath: mountPathFor(framework),
        capabilitiesJson: { detectedVersion: '1.2.3' },
        frameworkVersion: '1.2.3',
        frameworkVersionCheckedAt: new Date(),
        lastSeenAt: new Date(),
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

test('a same-value heartbeat writes no runtime row', async () => {
    const db = await syncWith(convergedRows(4), detected(4))

    assert.deepEqual(
        db.of('update', 'agent_runtimes'),
        [],
        'unchanged runtimes must not be rewritten every 15s'
    )
    assert.deepEqual(db.of('insert', 'agent_runtimes'), [])
    assert.equal(
        db.of('update', 'agents').length,
        1,
        'the stopped->running recovery must be one set-based statement'
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

test('one changed runtime costs exactly one batched runtime UPDATE', async () => {
    const rows = convergedRows(4)
    rows[2] = convergedRow(rows[2].framework, { frameworkVersion: '1.0.0' })

    const db = await syncWith(rows, detected(4))

    const updates = db.of('update', 'agent_runtimes')
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

test('the runtime freshness touch is a single batched statement', async () => {
    const stale = new Date(Date.now() - 60 * 60_000)
    const rows = FRAMEWORKS.slice(0, 4).map((f) =>
        convergedRow(f, {
            lastSeenAt: stale,
            frameworkVersionCheckedAt: stale
        })
    )

    const db = await syncWith(rows, detected(4))

    const updates = db.of('update', 'agent_runtimes')
    assert.equal(
        updates.length,
        1,
        'presence/freshness must be one statement for every runtime of the host'
    )
    assert.ok(updates[0].set?.lastSeenAt instanceof Date)
    assert.equal(
        updates[0].set?.status,
        undefined,
        'the cheap touch must not carry the full-row rewrite'
    )
    assert.equal(updates[0].set?.capabilitiesJson, undefined)
})

test('a stale runtime already stopped is not rewritten', async () => {
    const rows = [
        ...convergedRows(2),
        convergedRow('openclaw', { status: 'stopped' })
    ]

    const db = await syncWith(rows, detected(2))

    assert.deepEqual(
        db.of('update', 'agent_runtimes'),
        [],
        'an already-stopped stale runtime must not be re-stopped every 15s'
    )
})

test('a newly missing framework still stops its runtime and its agents', async () => {
    const db = await syncWith(convergedRows(3), detected(2))

    const runtimeUpdates = db.of('update', 'agent_runtimes')
    assert.equal(runtimeUpdates.length, 1)
    assert.equal(runtimeUpdates[0].set?.status, 'stopped')
    const stopAgents = db
        .of('update', 'agents')
        .find((s) => s.set?.status === 'stopped')
    assert.ok(stopAgents, 'agents on the missing framework are stopped')
    assert.equal(
        stopAgents?.set?.failureReason,
        'framework not detected by daemon'
    )
})

test('offline -> active with an identical inventory restores runtime and agents', async () => {
    const rows = convergedRows(3).map((r) => ({ ...r, status: 'stopped' }))

    const db = await syncWith(rows as AgentRuntimeRow[], detected(3))

    const updates = db.of('update', 'agent_runtimes')
    assert.equal(updates.length, 1, 'one batched revive for the whole host')
    assert.equal(updates[0].set?.status, 'ready')
    assert.equal(
        db.of('update', 'agents').filter((s) => s.set?.status === 'running')
            .length,
        1,
        'agents come back in one set-based statement'
    )
})

class HostDb {
    readonly patches: Array<Partial<RuntimeHostRow>> = []
    reads = 0

    constructor(private readonly row: RuntimeHostRow) {}

    select() {
        this.reads += 1
        return {
            from: () => ({
                where: () => ({ limit: async () => [this.row] })
            })
        }
    }

    update() {
        return {
            set: (patch: Partial<RuntimeHostRow>) => ({
                where: () => {
                    this.patches.push(patch)
                    Object.assign(this.row, patch)
                    return { returning: async () => [this.row] }
                }
            })
        }
    }
}

const heartbeatArgs = {
    daemonId: 'dh-1',
    detectedFrameworks: detected(3),
    cliVersion: '0.0.1',
    startupMethod: 'launchd-user' as const,
    clientFeatures: ['exec.resume']
}

const hostService = (db: Database): DaemonHostService =>
    new DaemonHostService(
        db,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        { get: () => undefined } as never
    )

test('a same-value host heartbeat writes only the presence column', async () => {
    const db = new HostDb(
        host({
            detectedFrameworks: detected(3),
            startupMethod: 'launchd-user',
            clientFeatures: ['exec.resume'],
            terminalPty: null
        })
    )
    const service = hostService(db as unknown as Database)

    await service.heartbeat(heartbeatArgs)

    assert.deepEqual(
        Object.keys(db.patches[0]),
        ['lastSeenAt'],
        'unchanged metadata (including the detectedFrameworks JSONB) is not rewritten'
    )
})

test('changed host metadata is written alongside the presence column', async () => {
    const db = new HostDb(
        host({
            detectedFrameworks: detected(3),
            startupMethod: 'launchd-user',
            clientFeatures: ['exec.resume'],
            terminalPty: null
        })
    )
    const service = hostService(db as unknown as Database)

    await service.heartbeat({ ...heartbeatArgs, cliVersion: '0.0.2' })

    assert.equal(db.patches[0].cliVersion, '0.0.2')
    assert.ok(db.patches[0].updatedAt instanceof Date)
    assert.ok(db.patches[0].lastSeenAt instanceof Date)
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
                return hostRow
            },
            findById: async () => {
                reads.push('findById')
                return hostRow
            }
        } as never,
        { syncForDaemon: async () => [] } as never,
        { consume: () => {} } as never,
        undefined as never
    )

    await controller.heartbeat(
        { tokenId: 'ldt-1', daemonId: 'dh-1' } as never,
        {
            detectedFrameworks: detected(3),
            cliVersion: '0.0.1',
            startupMethod: 'launchd'
        } as never
    )

    assert.deepEqual(
        reads,
        ['heartbeat'],
        'the write already returns the row; re-reading it doubles the host reads'
    )
})
