import test from 'node:test'
import assert from 'node:assert/strict'
import {
    DaemonRuntimeSyncService,
    FRAMEWORK_NOT_DETECTED_REASON
} from '../src/modules/daemon/daemon-runtime-sync.service'
import type { Database, RuntimeHostRow, AgentRuntimeRow } from '@manyfold/db'

interface Mutation {
    op: 'select' | 'insert' | 'update'
    setVals?: Record<string, unknown>
    insertVals?: Partial<AgentRuntimeRow>
    // The ON CONFLICT (host_id, framework) DO UPDATE clause of an insert,
    // recorded so a test can tell an upsert that updated from one that made
    // a row.
    conflictSet?: Record<string, unknown>
    upserted?: boolean
}

// Predicates are opaque, so a select answers with every row it holds; the
// two selects the service runs are "this host's runtimes" and "this user's
// runtime names", which the fake answers from the same rows. The partial
// unique index is modelled: an insert on a (hostId, framework) already held
// applies the conflict SET to that row instead of adding one.
class FakeDb {
    rows: AgentRuntimeRow[] = []
    mutations: Mutation[] = []
    setRows(rows: Partial<AgentRuntimeRow>[]): void {
        this.rows = rows.map((r) => ({
            ...defaults(),
            ...r
        })) as AgentRuntimeRow[]
    }

    // The bare select is "this host's runtimes" (dh-1); the shaped one is
    // "every runtime name this user holds".
    select(shape?: Record<string, unknown>) {
        return {
            from: () => ({
                where: () =>
                    Promise.resolve(
                        shape
                            ? this.rows.slice()
                            : this.rows.filter((r) => r.hostId === 'dh-1')
                    )
            })
        }
    }

    insert(_tbl: unknown) {
        return {
            values: (v: Partial<AgentRuntimeRow>) => {
                const mutation: Mutation = { op: 'insert', insertVals: v }
                this.mutations.push(mutation)
                return {
                    onConflictDoUpdate: (conflict: {
                        set: Record<string, unknown>
                    }) => {
                        mutation.conflictSet = conflict.set
                        return {
                            returning: () => {
                                const existing = this.rows.find(
                                    (r) =>
                                        r.hostId === v.hostId &&
                                        r.framework === v.framework
                                )
                                if (existing) {
                                    mutation.upserted = true
                                    Object.assign(existing, conflict.set)
                                    return Promise.resolve([existing])
                                }
                                const row = {
                                    ...defaults(),
                                    ...v,
                                    createdAt: new Date(),
                                    updatedAt: new Date()
                                } as AgentRuntimeRow
                                this.rows.push(row)
                                return Promise.resolve([row])
                            }
                        }
                    }
                }
            }
        }
    }

    update(_tbl: unknown) {
        return {
            set: (v: Record<string, unknown>) => {
                this.mutations.push({ op: 'update', setVals: v })
                return {
                    where: (_cond: unknown) => Promise.resolve()
                }
            }
        }
    }
}

const defaults = (): Partial<AgentRuntimeRow> => ({
    status: 'ready',
    hostId: 'dh-1',
    capabilitiesJson: {},
    primaryAgentId: null,
    defaultAuthProfileId: null,
    mountPath: '/workspace',
    controlUiEnabled: true,
    dashboardEnabled: false,
    dashboardState: null,
    serviceStatus: 'unknown',
    serviceStatusAt: null,
    currentPhase: null,
    failureReason: null,
    frameworkVersion: null,
    frameworkVersionCheckedAt: null,
    lastBootstrappedAt: null
})

const wireDb = (db: FakeDb): Database => db as unknown as Database

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
        powerState: null,
        homeDir: '/Users/me',
        workspaceBaseDir: '/Users/me/.nca/workspaces',
        skillsDir: null,
        keepAwake: false,
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides
    }) as RuntimeHostRow

const inserts = (db: FakeDb) => db.mutations.filter((m) => m.op === 'insert')
const updates = (db: FakeDb) => db.mutations.filter((m) => m.op === 'update')

test('first sync inserts one runtime per detected framework on the host', async () => {
    const db = new FakeDb()
    db.setRows([])
    const svc = new DaemonRuntimeSyncService(wireDb(db))
    const result = await svc.syncForDaemon({
        host: host(),
        detectedFrameworks: [
            { framework: 'claude-code', version: '1.0', path: '/x/claude' },
            { framework: 'codex', version: '0.5', path: '/x/codex' }
        ]
    })
    assert.equal(result.length, 2)
    assert.equal(inserts(db).length, 2)
    assert.equal(inserts(db)[0].insertVals?.hostId, 'dh-1')
    assert.equal(inserts(db)[0].insertVals?.status, 'ready')
    assert.equal(
        inserts(db)[0].insertVals?.mountPath,
        '/Users/me/.nca/workspaces',
        'coding runtimes mount the declared workspace root'
    )
    assert.ok(
        !('kind' in (inserts(db)[0].insertVals ?? {})),
        'nothing about the host is copied onto the runtime'
    )
})

// R3: a hosted host's inventory lives on host_daemons and never becomes a
// runtime row — those are made by an explicit install.
test('a hosted host\'s inventory never creates or touches runtimes', async () => {
    const db = new FakeDb()
    db.setRows([
        { id: 'art-1', userId: 'u1', framework: 'openclaw', name: 'sandbox-001-openclaw', status: 'failed' }
    ])
    const svc = new DaemonRuntimeSyncService(wireDb(db))
    const result = await svc.syncForDaemon({
        host: host({ kind: 'hosted', providerId: 'rtp-1' }),
        detectedFrameworks: [
            { framework: 'openclaw', version: '2026.7.1', path: '/x/openclaw' },
            { framework: 'codex', version: '0.5', path: '/x/codex' }
        ]
    })
    assert.deepEqual(result, [])
    assert.deepEqual(db.mutations, [], 'not even a read')
    assert.equal(db.rows[0].status, 'failed')
})

test('a user\'s own machine materializes service frameworks too', async () => {
    const db = new FakeDb()
    db.setRows([])
    const svc = new DaemonRuntimeSyncService(wireDb(db))
    await svc.syncForDaemon({
        host: host(),
        detectedFrameworks: [
            { framework: 'openclaw', version: '2026.7.1', path: '/x/openclaw' },
            { framework: 'codex', version: '0.5', path: '/x/codex' }
        ]
    })
    assert.deepEqual(
        inserts(db).map((m) => m.insertVals?.framework),
        ['openclaw', 'codex']
    )
    assert.equal(inserts(db)[0].insertVals?.mountPath, '/Users/me/.openclaw')
})

test('a name held under another host gets a numeric suffix', async () => {
    // The machine re-registered under a new daemon uuid, so the old runtime
    // row (same user, other host) still holds `<host>-<framework>`.
    const db = new FakeDb()
    db.setRows([
        {
            id: 'art-old',
            userId: 'u1',
            framework: 'claude-code',
            hostId: 'dh-old',
            name: 'mac-laptop-claude-code'
        }
    ])
    const svc = new DaemonRuntimeSyncService(wireDb(db))
    const result = await svc.syncForDaemon({
        host: host(),
        detectedFrameworks: [
            { framework: 'claude-code', version: '1.0', path: '/x/claude' }
        ]
    })
    assert.equal(result.length, 1)
    const insert = inserts(db)[0]
    assert.equal(insert?.insertVals?.name, 'mac-laptop-claude-code-2')
    assert.equal(insert?.insertVals?.hostId, 'dh-1')
})

// The partial unique index on (host_id, framework): a second report of the
// same framework in one register updates the row the first one made.
test('the same framework reported twice is one row, upserted', async () => {
    const db = new FakeDb()
    db.setRows([])
    const svc = new DaemonRuntimeSyncService(wireDb(db))
    await svc.syncForDaemon({
        host: host(),
        detectedFrameworks: [
            { framework: 'claude-code', version: '1.0', path: '/usr/local/bin/claude' },
            { framework: 'claude-code', version: '1.0', path: '/opt/homebrew/bin/claude' }
        ]
    })
    assert.equal(inserts(db).length, 2)
    assert.equal(inserts(db)[1].upserted, true)
    assert.equal(inserts(db)[1].conflictSet?.status, 'ready')
    assert.equal(db.rows.length, 1)
})

test('a framework that left the inventory reads failed, and only once', async () => {
    const db = new FakeDb()
    db.setRows([
        { id: 'art-claude', userId: 'u1', framework: 'claude-code', name: 'mac-laptop-claude-code' },
        { id: 'art-codex', userId: 'u1', framework: 'codex', name: 'mac-laptop-codex' }
    ])
    const svc = new DaemonRuntimeSyncService(wireDb(db))
    await svc.syncForDaemon({
        host: host(),
        detectedFrameworks: [
            { framework: 'claude-code', version: '1.0', path: '/x/claude' }
        ]
    })
    const failed = updates(db).find((m) => m.setVals?.status === 'failed')
    assert.ok(failed, 'the missing framework\'s runtime is marked failed')
    assert.equal(failed?.setVals?.failureReason, FRAMEWORK_NOT_DETECTED_REASON)
    assert.equal(
        updates(db).filter((m) => m.setVals?.status === 'ready').length,
        0,
        'a converged runtime is not rewritten'
    )
    assert.ok(
        !db.mutations.some((m) => m.setVals && 'status' in m.setVals && m.setVals.status === 'stopped'),
        'no status other than the install states is ever written'
    )
})

test('a failed runtime whose framework is back reads ready again', async () => {
    const db = new FakeDb()
    db.setRows([
        {
            id: 'art-codex',
            userId: 'u1',
            framework: 'codex',
            name: 'mac-laptop-codex',
            status: 'failed',
            failureReason: FRAMEWORK_NOT_DETECTED_REASON,
            capabilitiesJson: { detectedVersion: '0.5' }
        }
    ])
    const svc = new DaemonRuntimeSyncService(wireDb(db))
    const result = await svc.syncForDaemon({
        host: host(),
        detectedFrameworks: [{ framework: 'codex', version: '0.5', path: '/x/codex' }]
    })
    assert.equal(result[0].status, 'ready')
    const revive = updates(db).find((m) => m.setVals?.status === 'ready')
    assert.ok(revive)
    assert.equal(revive?.setVals?.failureReason, null)
    assert.equal(inserts(db).length, 0)
})

// agent_runtimes.framework_version has more than one writer, and they must
// agree on the format: `2.1.220-rc.1` here and on an install.
test('a pre-release framework version is persisted in full, not truncated', async () => {
    const db = new FakeDb()
    db.setRows([])
    const svc = new DaemonRuntimeSyncService(wireDb(db))
    await svc.syncForDaemon({
        host: host(),
        detectedFrameworks: [
            { framework: 'claude-code', version: '2.1.220-rc.1 (Claude Code)', path: '/x/claude' }
        ]
    })
    assert.equal(inserts(db).length, 1)
    assert.equal(inserts(db)[0].insertVals?.frameworkVersion, '2.1.220-rc.1')
})

test('an unparseable reported version leaves the column untouched', async () => {
    const db = new FakeDb()
    db.setRows([])
    const svc = new DaemonRuntimeSyncService(wireDb(db))
    await svc.syncForDaemon({
        host: host(),
        detectedFrameworks: [
            { framework: 'claude-code', version: 'unknown', path: '/x/claude' }
        ]
    })
    assert.equal(inserts(db).length, 1)
    assert.equal(inserts(db)[0].insertVals?.frameworkVersion ?? null, null)
})
