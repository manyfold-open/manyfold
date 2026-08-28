import { auditAction } from '@manyfold/shared'
import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    a2aConnectSessions,
    agents,
    apiTokens,
    auditLogs,
    users,
    type Database
} from '@manyfold/db'
import { ApiTokenService } from '../src/modules/auth/api-token.service'
import { CliAuthRateLimitService } from '../src/modules/auth/cli-auth-rate-limit.service'
import { CliAuthService } from '../src/modules/auth/cli-auth.service'
import { ConnectA2aService } from '../src/modules/connect-a2a/connect-a2a.service'

// State-machine coverage for the A2A Connect flow on an in-memory fake DB.
// The fake's transaction() is a pass-through, so rollback and serialization
// are NOT proven here — connect-a2a.pg.test.ts carries those on real
// Postgres. What this file proves: approve records only the decision (no
// tokens), poll mints exactly once (atomic-claim modelling), every failure
// branch answers per the spec's failure-semantics table, and neither flow's
// device code is redeemable on the other flow's poll.

const API_ORIGIN = 'https://api.example.test/api'

interface SessionRow {
    id: string
    userCode: string
    deviceCodeHash: string
    clientName: string
    clientUrl: string | null
    userId: string | null
    status: 'pending' | 'approved' | 'exchanged' | 'expired' | 'denied'
    approvedAgentIds: string[] | null
    expiresInDays: number | null
    polledAt: Date | null
    expiresAt: Date
    approvedAt: Date | null
    exchangedAt: Date | null
    createdAt: Date
    updatedAt: Date
}

interface AgentRow {
    id: string
    userId: string
    name: string
    extras: Record<string, unknown>
}

const SESSION_STATUSES = [
    'pending',
    'approved',
    'exchanged',
    'expired',
    'denied'
]

interface CollectedParams {
    strings: string[]
    dates: Date[]
}

const collectParams = (cond: unknown): CollectedParams => {
    const strings: string[] = []
    const dates: Date[] = []
    const seen = new WeakSet<object>()
    const walk = (node: unknown): void => {
        if (node === null || node === undefined) return
        if (node instanceof Date) {
            dates.push(node)
            return
        }
        if (typeof node !== 'object') return
        if (seen.has(node as object)) return
        seen.add(node as object)
        const rec = node as Record<string, unknown>
        if ('value' in rec) {
            const value = rec.value
            if (Array.isArray(value)) {
                for (const item of value) {
                    if (typeof item === 'string') strings.push(item)
                    else if (item instanceof Date) dates.push(item)
                }
            } else if (typeof value === 'string') strings.push(value)
            else if (value instanceof Date) dates.push(value)
        }
        for (const key of Object.keys(rec)) walk(rec[key])
    }
    walk(cond)
    return { strings, dates }
}

interface SessionMatch {
    id?: string
    hash?: string
    code?: string
    statuses: string[]
    dates: Date[]
}

const sessionMatch = (cond: unknown): SessionMatch => {
    const { strings, dates } = collectParams(cond)
    return {
        id: strings.find((s) => s.startsWith('acs_')),
        hash: strings.find((s) => /^[0-9a-f]{64}$/.test(s)),
        code: strings.find((s) => /^[A-Z2-9]{4}-[A-Z2-9]{4}$/.test(s)),
        statuses: strings.filter((s) => SESSION_STATUSES.includes(s)),
        dates
    }
}

const sessionFieldsMatch = (row: SessionRow, m: SessionMatch): boolean =>
    (!m.id || row.id === m.id) &&
    (!m.hash || row.deviceCodeHash === m.hash) &&
    (!m.code || row.userCode === m.code)

const agentFilter = (cond: unknown): ((row: AgentRow) => boolean) => {
    const { strings } = collectParams(cond)
    const agentIds = strings.filter((s) => s.startsWith('agt_'))
    const userId = strings.find((s) => s.startsWith('user-'))
    return (row) =>
        (agentIds.length === 0 || agentIds.includes(row.id)) &&
        (!userId || row.userId === userId)
}

type Row = Record<string, unknown>

class FakeSelect {
    private cond: unknown = null

    constructor(
        private readonly db: FakeDb,
        private readonly table: unknown
    ) {}

    where(cond: unknown): this {
        this.cond = cond
        return this
    }

    limit(_n: number): Promise<Row[]> {
        return Promise.resolve(this.rows())
    }

    then<T>(resolve: (rows: Row[]) => T): Promise<T> {
        return Promise.resolve(this.rows()).then(resolve)
    }

    private rows(): Row[] {
        if (this.table === a2aConnectSessions) {
            const m = sessionMatch(this.cond)
            return this.db.sessionRows
                .filter((row) => sessionFieldsMatch(row, m))
                .map((row) => ({ ...row }))
        }
        if (this.table === agents) {
            const match = agentFilter(this.cond)
            return this.db.agentRows
                .filter(match)
                .map((row) => ({ ...row, extras: { ...row.extras } }))
        }
        if (this.table === users) {
            const { strings } = collectParams(this.cond)
            const id = strings.find((s) => s.startsWith('user-'))
            return this.db.userRows
                .filter((row) => !id || row.id === id)
                .map((row) => ({ ...row }))
        }
        if (this.table === apiTokens) {
            const { strings } = collectParams(this.cond)
            const id = strings.find((s) => s.startsWith('pat_'))
            return this.db.tokenRows
                .filter((row) => !id || row.id === id)
                .map((row) => ({ ...row }))
        }
        throw new Error('unexpected select target')
    }
}

class FakeUpdate {
    private setValues: Row = {}
    private cond: unknown = null

    constructor(
        private readonly db: FakeDb,
        private readonly table: unknown
    ) {}

    set(values: Row): this {
        this.setValues = values
        return this
    }

    where(cond: unknown): this {
        this.cond = cond
        return this
    }

    returning(_sel?: unknown): Promise<Row[]> {
        return Promise.resolve(this.apply())
    }

    then<T>(resolve: (rows: Row[]) => T): Promise<T> {
        return Promise.resolve(this.apply()).then(resolve)
    }

    private apply(): Row[] {
        if (this.table === a2aConnectSessions) {
            const m = sessionMatch(this.cond)
            const matched = this.db.sessionRows.filter(
                (row) =>
                    sessionFieldsMatch(row, m) &&
                    (m.statuses.length === 0 ||
                        m.statuses.includes(row.status)) &&
                    // Only gt(expiresAt, now) guards appear in updates.
                    m.dates.every((d) => row.expiresAt > d)
            )
            for (const row of matched) Object.assign(row, this.setValues)
            return matched.map((row) => ({ ...row }))
        }
        if (this.table === agents) {
            const match = agentFilter(this.cond)
            const matched = this.db.agentRows.filter(match)
            for (const row of matched) Object.assign(row, this.setValues)
            return matched.map((row) => ({ ...row }))
        }
        if (this.table === apiTokens) {
            const { strings } = collectParams(this.cond)
            const id = strings.find((s) => s.startsWith('pat_'))
            const matched = this.db.tokenRows.filter(
                (row) => !id || row.id === id
            )
            for (const row of matched) Object.assign(row, this.setValues)
            return matched.map((row) => ({ ...row }))
        }
        throw new Error('unexpected update target')
    }
}

class FakeDelete {
    private cond: unknown = null

    constructor(
        private readonly db: FakeDb,
        private readonly table: unknown
    ) {}

    where(cond: unknown): this {
        this.cond = cond
        return this
    }

    returning(_sel?: unknown): Promise<Row[]> {
        if (this.table !== a2aConnectSessions)
            throw new Error('unexpected delete target')
        const m = sessionMatch(this.cond)
        const matched = this.db.sessionRows.filter(
            (row) =>
                (m.statuses.length === 0 || m.statuses.includes(row.status)) &&
                // Only lt(expiresAt, cutoff) guards appear in deletes.
                m.dates.every((d) => row.expiresAt < d)
        )
        this.db.sessionRows = this.db.sessionRows.filter(
            (row) => !matched.includes(row)
        )
        return Promise.resolve(matched.map((row) => ({ id: row.id })))
    }
}

class FakeDb {
    sessionRows: SessionRow[] = []
    agentRows: AgentRow[] = []
    userRows: Array<{ id: string; email: string }> = []
    tokenRows: Row[] = []
    auditRows: Row[] = []

    transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
        return fn(this)
    }

    insert(table: unknown): { values: (v: Row) => Promise<void> } {
        return {
            values: async (v) => {
                if (table === a2aConnectSessions) {
                    if (
                        this.sessionRows.some(
                            (row) =>
                                row.userCode === v.userCode ||
                                row.deviceCodeHash === v.deviceCodeHash
                        )
                    )
                        throw new Error('unique violation')
                    this.sessionRows.push({
                        clientUrl: null,
                        userId: null,
                        status: 'pending',
                        approvedAgentIds: null,
                        expiresInDays: null,
                        polledAt: null,
                        approvedAt: null,
                        exchangedAt: null,
                        createdAt: new Date(),
                        updatedAt: new Date(),
                        ...(v as object)
                    } as SessionRow)
                } else if (table === apiTokens) {
                    this.tokenRows.push({ tokenKind: 'user-grant', ...v })
                } else if (table === auditLogs) {
                    this.auditRows.push({ ...v })
                } else {
                    throw new Error('unexpected insert target')
                }
            }
        }
    }

    select(_fields?: unknown): { from: (table: unknown) => FakeSelect } {
        return { from: (table) => new FakeSelect(this, table) }
    }

    update(table: unknown): FakeUpdate {
        return new FakeUpdate(this, table)
    }

    delete(table: unknown): FakeDelete {
        return new FakeDelete(this, table)
    }
}

const newConnect = (db: FakeDb): ConnectA2aService => {
    db.userRows.push({ id: 'user-1', email: 'user@example.com' })
    db.userRows.push({ id: 'user-2', email: 'other@example.com' })
    db.agentRows.push({
        id: 'agt_a',
        userId: 'user-1',
        name: 'agent-a',
        extras: { a2aExposure: { enabled: true } }
    })
    db.agentRows.push({
        id: 'agt_b',
        userId: 'user-1',
        name: 'agent-b',
        extras: {}
    })
    db.agentRows.push({
        id: 'agt_other',
        userId: 'user-2',
        name: 'other-owner',
        extras: { a2aExposure: { enabled: true } }
    })
    // A2aService.setExposure stub with the same observable semantics; the
    // real service runs against real Postgres in connect-a2a.pg.test.ts.
    const a2aStub = {
        setExposure: async (
            agentId: string,
            patch: { enabled: boolean }
        ): Promise<void> => {
            const agent = db.agentRows.find((row) => row.id === agentId)
            if (!agent) throw new Error('agent not found')
            const existing =
                (agent.extras.a2aExposure as Record<string, unknown>) ?? {}
            agent.extras = {
                ...agent.extras,
                a2aExposure: { ...existing, ...patch }
            }
        }
    }
    return new ConnectA2aService(
        db as unknown as Database,
        { get: () => undefined } as never,
        new ApiTokenService(db as unknown as Database),
        a2aStub as never
    )
}

const startSession = async (
    connect: ConnectA2aService
): Promise<{
    requestId: string
    userCode: string
    deviceCode: string
}> => {
    const started = await connect.start({ clientName: 'Team Agents' })
    return {
        requestId: started.requestId,
        userCode: started.userCode,
        deviceCode: started.deviceCode
    }
}

void test('start persists a hashed mf_cnx_ device code and a pending session', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)

    const started = await connect.start({
        clientName: 'Team Agents',
        clientUrl: 'https://team-agents.example.com'
    })

    assert.match(started.deviceCode, /^mf_cnx_/)
    assert.match(started.requestId, /^acs_[a-z2-7]{26}$/)
    assert.match(started.userCode, /^[A-Z2-9]{4}-[A-Z2-9]{4}$/)
    const url = new URL(started.authUrl)
    assert.equal(url.pathname, '/connect/a2a')
    assert.equal(url.searchParams.get('request'), started.requestId)
    assert.equal(url.searchParams.get('code'), started.userCode)

    assert.equal(db.sessionRows.length, 1)
    const row = db.sessionRows[0]
    assert.equal(row.status, 'pending')
    assert.equal(row.clientName, 'Team Agents')
    assert.equal(row.clientUrl, 'https://team-agents.example.com')
    assert.notEqual(row.deviceCodeHash, started.deviceCode)
    assert.match(row.deviceCodeHash, /^[0-9a-f]{64}$/)
})

void test('start rejects missing/oversized clientName and non-https clientUrl', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)

    await assert.rejects(
        () => connect.start({ clientName: '  ' }),
        /clientName is required/
    )
    await assert.rejects(
        () => connect.start({ clientName: 'x'.repeat(61) }),
        /at most 60 characters/
    )
    await assert.rejects(
        () =>
            connect.start({
                clientName: 'App',
                clientUrl: 'http://insecure.example.com'
            }),
        /must be an https URL/
    )
    assert.equal(db.sessionRows.length, 0)
})

void test('getSession requires both requestId and userCode to match', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)
    const started = await startSession(connect)

    const session = await connect.getSession({
        requestId: started.requestId,
        userCode: started.userCode.toLowerCase()
    })
    assert.equal(session.clientName, 'Team Agents')
    assert.equal(session.status, 'pending')

    await assert.rejects(
        () =>
            connect.getSession({
                requestId: started.requestId,
                userCode: 'AAAA-2222'
            }),
        /not found/
    )
})

void test('getSession reports expired lazily once the TTL passes', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)
    const started = await startSession(connect)
    db.sessionRows[0].expiresAt = new Date(Date.now() - 1_000)

    const session = await connect.getSession({
        requestId: started.requestId,
        userCode: started.userCode
    })
    assert.equal(session.status, 'expired')
})

void test('approve records the decision only — no tokens are minted', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)
    const started = await startSession(connect)

    const result = await connect.approve({
        requestId: started.requestId,
        userCode: started.userCode,
        userId: 'user-1',
        agentIds: ['agt_a'],
        enableExposure: false
    })

    assert.deepEqual(result, { status: 'approved', agentCount: 1 })
    const row = db.sessionRows[0]
    assert.equal(row.status, 'approved')
    assert.equal(row.userId, 'user-1')
    assert.deepEqual(row.approvedAgentIds, ['agt_a'])
    assert.equal(db.tokenRows.length, 0)

    const audits = db.auditRows.filter(
        (a) => a.action === auditAction.A2A_CONNECT_APPROVED
    )
    assert.equal(audits.length, 1)
    assert.equal(audits[0].actorId, 'user-1')
    assert.equal(audits[0].subject, started.requestId)
})

void test('approve rejects agents not owned by the approving user, all-or-nothing', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)
    const started = await startSession(connect)

    await assert.rejects(
        () =>
            connect.approve({
                requestId: started.requestId,
                userCode: started.userCode,
                userId: 'user-1',
                agentIds: ['agt_a', 'agt_other'],
                enableExposure: false
            }),
        /not owned by approving user/
    )
    assert.equal(db.sessionRows[0].status, 'pending')
    assert.equal(db.auditRows.length, 0)
})

void test('approve without enableExposure rejects unexposed agents and writes nothing', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)
    const started = await startSession(connect)

    await assert.rejects(
        () =>
            connect.approve({
                requestId: started.requestId,
                userCode: started.userCode,
                userId: 'user-1',
                agentIds: ['agt_a', 'agt_b'],
                enableExposure: false
            }),
        /agent not exposed/
    )
    assert.equal(db.sessionRows[0].status, 'pending')
    const agentB = db.agentRows.find((a) => a.id === 'agt_b')
    assert.equal(agentB?.extras.a2aExposure, undefined)
})

void test('approve with enableExposure enables exposure for unexposed agents', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)
    const started = await startSession(connect)

    await connect.approve({
        requestId: started.requestId,
        userCode: started.userCode,
        userId: 'user-1',
        agentIds: ['agt_a', 'agt_b'],
        enableExposure: true
    })

    const agentB = db.agentRows.find((a) => a.id === 'agt_b')
    assert.equal(
        (agentB?.extras.a2aExposure as { enabled?: boolean })?.enabled,
        true
    )
    assert.equal(db.sessionRows[0].status, 'approved')
})

void test('approve validates userCode, agent count bounds and expiresInDays', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)
    const started = await startSession(connect)

    await assert.rejects(
        () =>
            connect.approve({
                requestId: started.requestId,
                userCode: 'ZZZZ-9999',
                userId: 'user-1',
                agentIds: ['agt_a'],
                enableExposure: false
            }),
        /user code does not match/
    )
    await assert.rejects(
        () =>
            connect.approve({
                requestId: started.requestId,
                userCode: started.userCode,
                userId: 'user-1',
                agentIds: [],
                enableExposure: false
            }),
        /agentIds must be non-empty/
    )
    await assert.rejects(
        () =>
            connect.approve({
                requestId: started.requestId,
                userCode: started.userCode,
                userId: 'user-1',
                agentIds: Array.from({ length: 21 }, (_, i) => `agt_x${i}`),
                enableExposure: false
            }),
        /at most 20 agents/
    )
    await assert.rejects(
        () =>
            connect.approve({
                requestId: started.requestId,
                userCode: started.userCode,
                userId: 'user-1',
                agentIds: ['agt_a'],
                enableExposure: false,
                expiresInDays: -5
            }),
        /positive integer/
    )
    assert.equal(db.sessionRows[0].status, 'pending')
})

void test('approve on an expired session → 410 and lazy expiry', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)
    const started = await startSession(connect)
    db.sessionRows[0].expiresAt = new Date(Date.now() - 1_000)

    await assert.rejects(
        () =>
            connect.approve({
                requestId: started.requestId,
                userCode: started.userCode,
                userId: 'user-1',
                agentIds: ['agt_a'],
                enableExposure: false
            }),
        /connect session expired/
    )
    assert.equal(db.sessionRows[0].status, 'expired')
})

void test('poll rejects device codes without the mf_cnx_ prefix (CLI codes included)', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)

    await assert.rejects(
        () => connect.poll({ deviceCode: 'mf_dvc_from_cli_flow' }, API_ORIGIN),
        /invalid deviceCode/
    )
    await assert.rejects(
        () => connect.poll({ deviceCode: '' }, API_ORIGIN),
        /invalid deviceCode/
    )
})

void test('cli poll rejects connect device codes before any lookup (cross-flow)', async () => {
    const db = new FakeDb()
    const cliAuth = new CliAuthService(
        db as unknown as Database,
        { get: () => undefined } as never,
        new ApiTokenService(db as unknown as Database),
        new CliAuthRateLimitService()
    )

    // The cli-auth poll endpoint is a retirement tombstone now, so a connect
    // device code leaking across flows is refused like everything else —
    // before any lookup, same as the shape gate it replaces.
    await assert.rejects(
        () => cliAuth.poll({ deviceCode: 'mf_cnx_from_connect_flow' }),
        /retired/
    )
})

void test('poll: pending session stays pending and records polledAt', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)
    const started = await startSession(connect)

    const result = await connect.poll(
        { deviceCode: started.deviceCode },
        API_ORIGIN
    )
    assert.deepEqual(result, { status: 'pending' })
    assert.ok(db.sessionRows[0].polledAt instanceof Date)
})

void test('poll: unknown device code → 404', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)
    await assert.rejects(
        () => connect.poll({ deviceCode: 'mf_cnx_missing' }, API_ORIGIN),
        /not found/
    )
})

void test('poll after approve mints one caller-less external grant per agent', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)
    const started = await startSession(connect)
    await connect.approve({
        requestId: started.requestId,
        userCode: started.userCode,
        userId: 'user-1',
        agentIds: ['agt_a', 'agt_b'],
        enableExposure: true
    })
    assert.equal(db.tokenRows.length, 0)

    const result = await connect.poll(
        { deviceCode: started.deviceCode },
        API_ORIGIN
    )

    assert.equal(result.status, 'approved')
    if (result.status !== 'approved') return
    assert.equal(result.userEmail, 'user@example.com')
    assert.equal(result.agents.length, 2)
    const first = result.agents[0]
    assert.equal(first.agentId, 'agt_a')
    assert.equal(first.name, 'agent-a')
    assert.equal(first.rpcUrl, `${API_ORIGIN}/a2a/agents/agt_a/rpc`)
    assert.equal(
        first.cardUrl,
        `${API_ORIGIN}/a2a/agents/agt_a/agent-card.json`
    )
    assert.match(first.token, /^nca_/)
    assert.equal(first.expiresAt, null)

    assert.equal(db.tokenRows.length, 2)
    for (const token of db.tokenRows) {
        assert.equal(token.tokenKind, 'a2a-grant')
        assert.equal(token.callerAgentId, null)
        assert.equal(token.enforceAgentBinding, true)
        assert.ok(['agt_a', 'agt_b'].includes(token.agentId as string))
    }
    assert.equal(db.sessionRows[0].status, 'exchanged')

    const grantAudits = db.auditRows.filter(
        (a) => a.action === auditAction.GRANT_MINTED
    )
    assert.equal(grantAudits.length, 2)
})

void test('poll consumes the session exactly once — repeat polls get expired', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)
    const started = await startSession(connect)
    await connect.approve({
        requestId: started.requestId,
        userCode: started.userCode,
        userId: 'user-1',
        agentIds: ['agt_a'],
        enableExposure: false
    })

    const first = await connect.poll(
        { deviceCode: started.deviceCode },
        API_ORIGIN
    )
    assert.equal(first.status, 'approved')

    const second = await connect.poll(
        { deviceCode: started.deviceCode },
        API_ORIGIN
    )
    assert.deepEqual(second, { status: 'expired' })
    assert.equal(db.tokenRows.length, 1)
})

void test('concurrent polls: exactly one winner, tokens minted once', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)
    const started = await startSession(connect)
    await connect.approve({
        requestId: started.requestId,
        userCode: started.userCode,
        userId: 'user-1',
        agentIds: ['agt_a'],
        enableExposure: false
    })

    const results = await Promise.all([
        connect.poll({ deviceCode: started.deviceCode }, API_ORIGIN),
        connect.poll({ deviceCode: started.deviceCode }, API_ORIGIN)
    ])

    const approved = results.filter((r) => r.status === 'approved')
    const expired = results.filter((r) => r.status === 'expired')
    assert.equal(approved.length, 1)
    assert.equal(expired.length, 1)
    assert.equal(db.tokenRows.length, 1)
})

void test('poll passes expiresInDays through to the minted tokens', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)
    const started = await startSession(connect)
    await connect.approve({
        requestId: started.requestId,
        userCode: started.userCode,
        userId: 'user-1',
        agentIds: ['agt_a'],
        enableExposure: false,
        expiresInDays: 90
    })

    const result = await connect.poll(
        { deviceCode: started.deviceCode },
        API_ORIGIN
    )
    assert.equal(result.status, 'approved')
    if (result.status !== 'approved') return
    assert.ok(result.agents[0].expiresAt)
    assert.ok(new Date(result.agents[0].expiresAt!) > new Date())
})

void test('poll skips agents deleted between approve and poll', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)
    const started = await startSession(connect)
    await connect.approve({
        requestId: started.requestId,
        userCode: started.userCode,
        userId: 'user-1',
        agentIds: ['agt_a', 'agt_b'],
        enableExposure: true
    })
    db.agentRows = db.agentRows.filter((a) => a.id !== 'agt_b')

    const result = await connect.poll(
        { deviceCode: started.deviceCode },
        API_ORIGIN
    )
    assert.equal(result.status, 'approved')
    if (result.status !== 'approved') return
    assert.equal(result.agents.length, 1)
    assert.equal(result.agents[0].agentId, 'agt_a')
    assert.equal(db.tokenRows.length, 1)
})

void test('poll on an expired session persists expired lazily', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)
    const started = await startSession(connect)
    db.sessionRows[0].expiresAt = new Date(Date.now() - 1_000)

    const result = await connect.poll(
        { deviceCode: started.deviceCode },
        API_ORIGIN
    )
    assert.deepEqual(result, { status: 'expired' })
    assert.equal(db.sessionRows[0].status, 'expired')
})

void test('deny flips a pending session and poll reports it', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)
    const started = await startSession(connect)

    const denied = await connect.deny({
        requestId: started.requestId,
        userCode: started.userCode
    })
    assert.deepEqual(denied, { status: 'denied' })
    assert.equal(db.sessionRows[0].status, 'denied')

    const result = await connect.poll(
        { deviceCode: started.deviceCode },
        API_ORIGIN
    )
    assert.deepEqual(result, { status: 'denied' })

    await assert.rejects(
        () =>
            connect.approve({
                requestId: started.requestId,
                userCode: started.userCode,
                userId: 'user-1',
                agentIds: ['agt_a'],
                enableExposure: false
            }),
        /not pending/
    )
})

void test('cleanup sweeps all terminal statuses including denied, after retention', async () => {
    const db = new FakeDb()
    const connect = newConnect(db)
    const started = await startSession(connect)
    await connect.deny({
        requestId: started.requestId,
        userCode: started.userCode
    })
    const fresh = await connect.start({ clientName: 'Fresh App' })
    db.sessionRows[0].expiresAt = new Date(Date.now() - 2 * 60 * 60_000)

    const deleted = await connect.cleanupExpiredSessions()
    assert.equal(deleted, 1)
    assert.equal(db.sessionRows.length, 1)
    assert.equal(db.sessionRows[0].id, fresh.requestId)
})
