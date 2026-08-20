import test from 'node:test'
import assert from 'node:assert/strict'
import { DaemonRuntimeSyncService } from '../src/modules/daemon/daemon-runtime-sync.service'
import type { Database, RuntimeHostRow, AgentRuntimeRow } from '@manyfold/db'

interface Mutation {
    op: 'select' | 'insert' | 'update'
    setVals?: Record<string, unknown>
    insertVals?: Partial<AgentRuntimeRow>
}

class FakeDb {
    rows: AgentRuntimeRow[] = []
    mutations: Mutation[] = []
    setRows(rows: Partial<AgentRuntimeRow>[]): void {
        this.rows = rows.map((r) => ({
            ...defaults(),
            ...r
        })) as AgentRuntimeRow[]
    }

    insert(_tbl: unknown) {
        return {
            values: (v: Partial<AgentRuntimeRow>) => {
                const row = {
                    ...defaults(),
                    ...v,
                    createdAt: new Date(),
                    updatedAt: new Date()
                } as AgentRuntimeRow
                this.rows.push(row)
                this.mutations.push({ op: 'insert', insertVals: v })
                return {
                    returning: () => Promise.resolve([row])
                }
            }
        }
    }

    update(_tbl: unknown) {
        return {
            set: (v: Record<string, unknown>) => {
                this.mutations.push({ op: 'update', setVals: v })
                return {
                    where: (_cond: unknown) => ({
                        returning: () => {
                            const updated = this.rows.map((r) => ({
                                ...r,
                                ...v
                            }))
                            if (this.rows.length > 0)
                                Object.assign(this.rows[0], v)
                            return Promise.resolve(updated)
                        }
                    })
                }
            }
        }
    }
}

const fakeSelect = (db: FakeDb): Database['select'] => {
    return (() => ({
        from: () => ({
            where: () => Promise.resolve(db.rows.slice())
        })
    })) as unknown as Database['select']
}

const defaults = (): Partial<AgentRuntimeRow> => ({
    status: 'ready',
    namespace: null,
    ingressHost: null,
    accountId: null,
    spriteName: null,
    spriteId: null,
    clusterId: null,
    daemonId: null,
    homeDir: null,
    workspaceBaseDir: null,
    capabilitiesJson: {},
    lastSeenAt: null,
    primaryAgentId: null,
    mountPath: '/workspace',
    controlUiEnabled: true,
    dashboardEnabled: false,
    currentPhase: null,
    failureReason: null,
    startedAt: null,
    lastBootstrappedAt: null
})

const wireDb = (db: FakeDb): Database => {
    return {
        select: fakeSelect(db),
        insert: db.insert.bind(db),
        update: db.update.bind(db)
    } as unknown as Database
}

const host = (overrides: Partial<RuntimeHostRow> = {}): RuntimeHostRow =>
    ({
        id: 'dh-1',
        userId: 'u1',
        daemonUuid: 'uuid-1',
        name: 'mac-laptop',
        hostname: 'mac.local',
        os: 'darwin',
        arch: 'arm64',
        cliVersion: '0.0.1',
        homeDir: '/Users/me',
        workspaceBaseDir: '/Users/me/.nca/workspaces',
        detectedFrameworks: [],
        lastSeenAt: new Date(),
        lastIp: null,
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides
    }) as RuntimeHostRow

test('first sync inserts one runtime per detected framework', async () => {
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
    const inserts = db.mutations.filter((m) => m.op === 'insert')
    assert.equal(inserts.length, 2)
    assert.equal(inserts[0].insertVals?.kind, 'daemon')
    assert.equal(inserts[0].insertVals?.daemonId, 'dh-1')
})

test('a name held under another daemon gets a numeric suffix', async () => {
    // The dev502 shape: the machine re-registered under a new daemon uuid, so
    // the old runtime row (same user, other daemonId) still holds
    // `<host>-<framework>`. fakeSelect returns every row regardless of
    // predicate — which is exactly the user-scoped query the service runs.
    const db = new FakeDb()
    db.setRows([
        {
            id: 'art-old',
            userId: 'u1',
            framework: 'claude-code',
            kind: 'daemon',
            daemonId: 'dh-old',
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
    const insert = db.mutations.find((m) => m.op === 'insert')
    assert.equal(insert?.insertVals?.name, 'mac-laptop-claude-code-2')
    assert.equal(insert?.insertVals?.daemonId, 'dh-1')
})

test('two inserts in one register never pick the same name', async () => {
    // A daemon can report the same framework at two install paths; the second
    // insert must see the name the first one just took, not re-derive from a
    // stale snapshot.
    const db = new FakeDb()
    db.setRows([])
    const svc = new DaemonRuntimeSyncService(wireDb(db))
    await svc.syncForDaemon({
        host: host(),
        detectedFrameworks: [
            {
                framework: 'claude-code',
                version: '1.0',
                path: '/usr/local/bin/claude'
            },
            {
                framework: 'claude-code',
                version: '1.0',
                path: '/opt/homebrew/bin/claude'
            }
        ]
    })
    const names = db.mutations
        .filter((m) => m.op === 'insert')
        .map((m) => m.insertVals?.name)
    assert.deepEqual(names, [
        'mac-laptop-claude-code',
        'mac-laptop-claude-code-2'
    ])
})

test('second sync with one framework removed marks the missing one stopped', async () => {
    const db = new FakeDb()
    db.setRows([
        {
            id: 'art-claude',
            userId: 'u1',
            framework: 'claude-code',
            kind: 'daemon',
            daemonId: 'dh-1',
            name: 'mac-laptop-claude-code'
        },
        {
            id: 'art-codex',
            userId: 'u1',
            framework: 'codex',
            kind: 'daemon',
            daemonId: 'dh-1',
            name: 'mac-laptop-codex'
        }
    ])
    const svc = new DaemonRuntimeSyncService(wireDb(db))
    await svc.syncForDaemon({
        host: host(),
        detectedFrameworks: [
            { framework: 'claude-code', version: '1.0', path: '/x/claude' }
        ]
    })
    // We expect:
    //  - one update of the existing claude-code runtime (status=ready)
    //  - one update restoring stopped agents under the detected runtime
    //  - one update on the stale codex runtime and its agents (status=stopped)
    const updates = db.mutations.filter((m) => m.op === 'update')
    const runningUpdate = updates.find((m) => m.setVals?.status === 'running')
    const stoppedUpdate = updates.find((m) => m.setVals?.status === 'stopped')
    assert.ok(
        runningUpdate,
        'expected a running update for detected daemon agents'
    )
    assert.ok(
        stoppedUpdate,
        'expected a stopped update for the missing framework'
    )
})

// agent_runtimes.framework_version has three writers: this one and the two
// sprite paths. They must agree on the format, or the same installed build reads
// as `2.1.220` on a daemon and `2.1.220-rc.1` on a sprite, and every precedence
// comparison downstream (upgrade-available, install-needed, the minimum-version
// floor) disagrees about which of the two is newer.
test('a pre-release framework version is persisted in full, not truncated', async () => {
    const db = new FakeDb()
    db.setRows([])
    const svc = new DaemonRuntimeSyncService(wireDb(db))

    await svc.syncForDaemon({
        host: host(),
        detectedFrameworks: [
            {
                framework: 'claude-code',
                version: '2.1.220-rc.1 (Claude Code)',
                path: '/x/claude'
            }
        ]
    })

    const inserts = db.mutations.filter((m) => m.op === 'insert')
    assert.equal(inserts.length, 1)
    assert.equal(inserts[0].insertVals?.frameworkVersion, '2.1.220-rc.1')
})

// Unchanged: a version the parser cannot read leaves the column alone rather
// than storing a guess, so a transient probe miss never wipes a known value.
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

    const inserts = db.mutations.filter((m) => m.op === 'insert')
    assert.equal(inserts.length, 1)
    assert.equal(inserts[0].insertVals?.frameworkVersion ?? null, null)
})
