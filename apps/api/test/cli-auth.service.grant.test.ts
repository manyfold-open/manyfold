import test from 'node:test'
import assert from 'node:assert/strict'
import {
    agents,
    apiTokens,
    cliAuthSessions,
    users,
    type Database
} from '@manyfold/db'
import { ApiTokenService } from '../src/modules/auth/api-token.service'
import { CliAuthRateLimitService } from '../src/modules/auth/cli-auth-rate-limit.service'
import {
    CliAuthService,
    hashSecret
} from '../src/modules/auth/cli-auth.service'

interface SessionRow {
    id: string
    userCode: string
    redirectUri: string | null
    userId: string | null
    authCodeHash: string | null
    status: 'pending' | 'approved' | 'exchanged' | 'expired'
    tokenId: string | null
    requestedScopes: string[] | null
    approvedScopes: string[] | null
    requestedAgentId: string | null
    deviceCodeHash: string | null
    polledAt: Date | null
    expiresAt: Date
    approvedAt: Date | null
    exchangedAt: Date | null
    createdAt: Date
    updatedAt: Date
}

interface TokenRow {
    id: string
    userId: string
    agentId: string | null
    name: string
    tokenHash: string
    scopes: string[]
    lastUsedAt: Date | null
    expiresAt: Date | null
    revokedAt: Date | null
    createdAt: Date
}

interface AgentRow {
    id: string
    userId: string
    name?: string
}

interface UserRow {
    id: string
    email: string
}

class FakeDb {
    sessionRows: SessionRow[] = []
    tokenRows: TokenRow[] = []
    agentRows: AgentRow[] = []
    userRows: UserRow[] = []

    select(_shape?: unknown) {
        return new FakeQuery(this, 'select')
    }
    insert(table: unknown) {
        return new FakeQuery(this, 'insert', table)
    }
    update(table: unknown) {
        return new FakeQuery(this, 'update', table)
    }
    delete(table: unknown) {
        return new FakeQuery(this, 'delete', table)
    }
    transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
        return fn(this)
    }
}

class FakeQuery {
    private table: unknown
    private patch: Record<string, unknown> = {}
    private params: unknown[] = []

    constructor(
        private readonly db: FakeDb,
        private readonly op: 'select' | 'insert' | 'update' | 'delete',
        table?: unknown
    ) {
        this.table = table
    }

    from(table: unknown) {
        this.table = table
        return this
    }

    innerJoin(_table: unknown, _cond: unknown) {
        return this
    }

    values(value: Record<string, unknown>) {
        if (this.table === apiTokens) {
            this.db.tokenRows.push({
                id: value.id as string,
                userId: value.userId as string,
                agentId: (value.agentId as string | null | undefined) ?? null,
                name: value.name as string,
                tokenHash: value.tokenHash as string,
                scopes: (value.scopes as string[]) ?? [],
                lastUsedAt: null,
                expiresAt: (value.expiresAt as Date | null) ?? null,
                revokedAt: null,
                createdAt: (value.createdAt as Date | undefined) ?? new Date()
            })
        }
        if (this.table === cliAuthSessions) {
            this.db.sessionRows.push({
                id: value.id as string,
                userCode: value.userCode as string,
                redirectUri:
                    (value.redirectUri as string | null | undefined) ?? null,
                userId: null,
                authCodeHash: null,
                status: 'pending',
                tokenId: null,
                requestedScopes:
                    (value.requestedScopes as string[] | null | undefined) ??
                    null,
                approvedScopes: null,
                requestedAgentId:
                    (value.requestedAgentId as string | null | undefined) ??
                    null,
                deviceCodeHash:
                    (value.deviceCodeHash as string | null | undefined) ?? null,
                polledAt: null,
                expiresAt: value.expiresAt as Date,
                approvedAt: null,
                exchangedAt: null,
                createdAt: new Date(),
                updatedAt: new Date()
            })
        }
        return this
    }

    onConflictDoUpdate(_arg: { set?: Record<string, unknown> }) {
        return Promise.resolve([])
    }

    set(value: Record<string, unknown>) {
        this.patch = value
        return this
    }

    where(cond: unknown) {
        this.params = collectParams(cond)
        return this
    }

    limit(_n: number) {
        const params = this.params
        if (this.table === agents) {
            const agentParam = params.find(
                (p): p is string =>
                    typeof p === 'string' && p.startsWith('agt_')
            )
            const userParam = params.find(
                (p): p is string =>
                    typeof p === 'string' && p.startsWith('user-')
            )
            const row = this.db.agentRows.find((r) => {
                if (r.id !== agentParam) return false
                if (userParam && r.userId !== userParam) return false
                return true
            })
            return Promise.resolve(
                row ? [{ id: row.id, name: row.name ?? row.id }] : []
            )
        }
        if (this.table === users) {
            const userParam = params.find(
                (p): p is string =>
                    typeof p === 'string' && p.startsWith('user-')
            )
            const row = this.db.userRows.find((u) => u.id === userParam)
            return Promise.resolve(row ? [{ email: row.email }] : [])
        }
        if (this.table === apiTokens) {
            const hashParam = params.find(
                (p): p is string => typeof p === 'string' && p.length === 64
            )
            return Promise.resolve(
                this.db.tokenRows
                    .filter((row) => !hashParam || row.tokenHash === hashParam)
                    .filter((row) => !row.revokedAt)
                    .map((row) => ({
                        id: row.id,
                        userId: row.userId,
                        agentId: row.agentId,
                        scopes: row.scopes,
                        expiresAt: row.expiresAt,
                        revokedAt: row.revokedAt,
                        email:
                            this.db.userRows.find((u) => u.id === row.userId)
                                ?.email ?? ''
                    }))
            )
        }
        if (this.table === cliAuthSessions) {
            return Promise.resolve(this.matchSessionRows().slice())
        }
        return Promise.resolve([])
    }

    returning(): Promise<unknown[]> {
        return this.execute(true)
    }

    then<TResult1 = unknown[], TResult2 = never>(
        onfulfilled?:
            | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
            | null,
        onrejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | null
    ): Promise<TResult1 | TResult2> {
        return this.execute(false).then(onfulfilled, onrejected)
    }

    private execute(returnRows: boolean): Promise<unknown[]> {
        if (this.op === 'delete' && this.table === cliAuthSessions) {
            const before = this.db.sessionRows.length
            this.db.sessionRows = []
            return Promise.resolve(
                returnRows
                    ? Array.from({ length: before }, (_, i) => ({ id: i }))
                    : []
            )
        }
        if (this.op !== 'update') return Promise.resolve([])

        if (this.table === apiTokens) {
            const params = this.params
            const agentParam = params.find(
                (p): p is string =>
                    typeof p === 'string' && p.startsWith('agt_')
            )
            const tokenParam = params.find(
                (p): p is string =>
                    typeof p === 'string' && p.startsWith('pat_')
            )
            const touched: TokenRow[] = []
            for (const row of this.db.tokenRows) {
                if (agentParam && row.agentId !== agentParam) continue
                if (tokenParam && row.id !== tokenParam) continue
                if (this.patch.revokedAt && row.revokedAt) continue
                Object.assign(row, this.patch)
                touched.push(row)
            }
            return Promise.resolve(returnRows ? touched.map(cloneRow) : [])
        }

        if (this.table === cliAuthSessions) {
            const rows = this.matchSessionRows()
            const touched: SessionRow[] = []
            for (const row of rows) {
                Object.assign(row, this.patch)
                touched.push(row)
            }
            return Promise.resolve(returnRows ? touched.map(cloneRow) : [])
        }
        return Promise.resolve([])
    }

    private matchSessionRows(): SessionRow[] {
        const params = this.params
        const idParam = params.find(
            (p): p is string => typeof p === 'string' && p.startsWith('cli_')
        )
        const userCodeParam = params.find(
            (p): p is string =>
                typeof p === 'string' && /^[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(p)
        )
        const hashParam = params.find(
            (p): p is string => typeof p === 'string' && p.length === 64
        )
        const statusParam = params.find(
            (p): p is string =>
                typeof p === 'string' &&
                ['pending', 'approved', 'exchanged', 'expired'].includes(p)
        )

        return this.db.sessionRows.filter((row) => {
            if (idParam && row.id !== idParam) return false
            if (userCodeParam && row.userCode !== userCodeParam) return false
            if (
                hashParam &&
                row.authCodeHash !== hashParam &&
                row.deviceCodeHash !== hashParam
            )
                return false
            if (statusParam && row.status !== statusParam) return false
            return true
        })
    }
}

const cloneRow = <T extends object>(row: T): T => ({ ...row })

const collectParams = (cond: unknown): unknown[] => {
    const out: unknown[] = []
    const seen = new WeakSet<object>()
    const walk = (node: unknown): void => {
        if (node === null || node === undefined) return
        if (typeof node !== 'object') return
        if (seen.has(node as object)) return
        seen.add(node as object)
        const rec = node as Record<string, unknown>
        if ('value' in rec && typeof rec.value !== 'object') {
            out.push(rec.value)
        }
        for (const key of Object.keys(rec)) walk(rec[key])
    }
    walk(cond)
    return out
}

const newCliAuth = (db: FakeDb): CliAuthService => {
    db.userRows.push({ id: 'user-1', email: 'user@example.com' })
    db.userRows.push({ id: 'user-2', email: 'other@example.com' })
    db.agentRows.push({ id: 'agt_A', userId: 'user-1' })
    db.agentRows.push({ id: 'agt_B', userId: 'user-1' })
    db.agentRows.push({ id: 'agt_other', userId: 'user-2' })
    return new CliAuthService(
        db as unknown as Database,
        { get: () => 'https://agents.example.test' } as never,
        new ApiTokenService(db as unknown as Database),
        new CliAuthRateLimitService()
    )
}

test('start in grant mode persists requestedScopes/agentId and returns deviceCode', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)

    const started = await cliAuth.start({
        requestedScopes: ['channels:read', 'channels:edit'],
        requestedAgentId: 'agt_A'
    })

    assert.match(started.deviceCode ?? '', /^mf_dvc_/)
    assert.equal(db.sessionRows.length, 1)
    assert.deepEqual(db.sessionRows[0].requestedScopes, [
        'channels:read',
        'channels:edit'
    ])
    assert.equal(db.sessionRows[0].requestedAgentId, 'agt_A')
    assert.equal(
        db.sessionRows[0].deviceCodeHash,
        hashSecret(started.deviceCode!)
    )
})

test('start in browser mode does NOT generate deviceCode', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)

    const started = await cliAuth.start({
        redirectUri: 'http://127.0.0.1:49152/callback'
    })

    assert.equal(started.deviceCode, undefined)
    assert.equal(db.sessionRows[0].deviceCodeHash, null)
    assert.equal(db.sessionRows[0].requestedScopes, null)
})

test('start rejects unknown requestedAgentId with 404', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)

    await assert.rejects(
        () =>
            cliAuth.start({
                requestedScopes: ['channels:read'],
                requestedAgentId: 'agt_nonexistent'
            }),
        /requested agent not found/
    )
    assert.equal(db.sessionRows.length, 0)
})

test('start rejects non-grantable scope', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)
    await assert.rejects(
        () =>
            cliAuth.start({
                requestedScopes: ['api.full' as string],
                requestedAgentId: 'agt_A'
            }),
        /unsupported grantable scope/
    )
})

test('approve grant mode requires approvedScopes', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)
    const started = await cliAuth.start({
        requestedScopes: ['channels:edit'],
        requestedAgentId: 'agt_A'
    })

    await assert.rejects(
        () =>
            cliAuth.approve({
                requestId: started.requestId,
                userCode: started.userCode,
                userId: 'user-1'
            }),
        /approvedScopes is required/
    )
})

test('approve grant rejects scope outside requested set', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)
    const started = await cliAuth.start({
        requestedScopes: ['channels:read'],
        requestedAgentId: 'agt_A'
    })

    await assert.rejects(
        () =>
            cliAuth.approve({
                requestId: started.requestId,
                userCode: started.userCode,
                userId: 'user-1',
                approvedScopes: ['channels:edit']
            }),
        /not in requested set/
    )
})

test('approve grant rejects cross-user agent ownership', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)
    const started = await cliAuth.start({
        requestedScopes: ['channels:edit'],
        requestedAgentId: 'agt_other'
    })

    await assert.rejects(
        () =>
            cliAuth.approve({
                requestId: started.requestId,
                userCode: started.userCode,
                userId: 'user-1',
                approvedScopes: ['channels:edit']
            }),
        /not owned by approving user/
    )
})

test('approve grant persists approvedScopes, no authCode, mode=grant', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)
    const started = await cliAuth.start({
        requestedScopes: ['channels:read', 'channels:edit'],
        requestedAgentId: 'agt_A'
    })

    const approved = await cliAuth.approve({
        requestId: started.requestId,
        userCode: started.userCode,
        userId: 'user-1',
        approvedScopes: ['channels:read']
    })

    assert.equal(approved.authCode, null)
    assert.equal(approved.redirectUrl, null)
    assert.equal(approved.mode, 'grant')
    assert.deepEqual(db.sessionRows[0].approvedScopes, ['channels:read'])
    assert.equal(db.sessionRows[0].authCodeHash, null)
    assert.equal(db.sessionRows[0].status, 'approved')
})

test('approve browser mode returns mode=browser', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)
    const started = await cliAuth.start({
        redirectUri: 'http://127.0.0.1:49152/callback'
    })

    const approved = await cliAuth.approve({
        requestId: started.requestId,
        userCode: started.userCode,
        userId: 'user-1'
    })

    assert.equal(approved.mode, 'browser')
    assert.match(approved.authCode ?? '', /^mf_auth_/)
    assert.match(approved.redirectUrl ?? '', /^http:\/\/127\.0\.0\.1:49152/)
})

test('exchange rejects grant-mode sessions', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)
    const started = await cliAuth.start({
        requestedScopes: ['channels:edit'],
        requestedAgentId: 'agt_A'
    })
    await cliAuth.approve({
        requestId: started.requestId,
        userCode: started.userCode,
        userId: 'user-1',
        approvedScopes: ['channels:edit']
    })

    // grant sessions never produce an authCode; fake one with the right prefix
    await assert.rejects(() => cliAuth.exchange('mf_auth_fake'), /not found/)
})

test('exchange rejects the retired nca_auth_ prefix at the shape gate', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)
    // No live legacy code can exist: minting went mf_-only at the rename and
    // login codes expire after 15 minutes (legacy-inventory §2).
    await assert.rejects(
        () => cliAuth.exchange('nca_auth_fake'),
        /invalid auth code/
    )
})

test('poll: deviceCode not found → 404', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)
    await assert.rejects(
        () => cliAuth.poll({ deviceCode: 'mf_dvc_missing' }),
        /not found/
    )
})

test('poll rejects the retired nca_dvc_ prefix at the shape gate', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)
    await assert.rejects(
        () => cliAuth.poll({ deviceCode: 'nca_dvc_missing' }),
        /invalid deviceCode/
    )
})

test('poll: pending session → status pending and polledAt updated', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)
    const started = await cliAuth.start({
        requestedScopes: ['channels:read'],
        requestedAgentId: 'agt_A'
    })

    const result = await cliAuth.poll({ deviceCode: started.deviceCode! })

    assert.deepEqual(result, { status: 'pending' })
    assert.ok(db.sessionRows[0].polledAt instanceof Date)
})

test('poll: expired session → status expired and not minted', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)
    const started = await cliAuth.start({
        requestedScopes: ['channels:read'],
        requestedAgentId: 'agt_A'
    })
    db.sessionRows[0].expiresAt = new Date(Date.now() - 1_000)

    const result = await cliAuth.poll({ deviceCode: started.deviceCode! })

    assert.deepEqual(result, { status: 'expired' })
    assert.equal(db.tokenRows.length, 0)
})

test('poll: approved → mints grant token, marks exchanged, returns token+scopes+email', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)
    const started = await cliAuth.start({
        requestedScopes: ['channels:read', 'channels:edit'],
        requestedAgentId: 'agt_A'
    })
    await cliAuth.approve({
        requestId: started.requestId,
        userCode: started.userCode,
        userId: 'user-1',
        approvedScopes: ['channels:read', 'channels:edit']
    })

    const result = await cliAuth.poll({ deviceCode: started.deviceCode! })

    assert.equal(result.status, 'approved')
    if (result.status !== 'approved') return
    assert.match(result.token, /^nca_/)
    assert.deepEqual(result.scopes, ['channels:read', 'channels:edit'])
    assert.equal(result.userEmail, 'user@example.com')

    assert.equal(db.tokenRows.length, 1)
    assert.equal(db.tokenRows[0].agentId, 'agt_A')
    assert.deepEqual(db.tokenRows[0].scopes, ['channels:read', 'channels:edit'])
    assert.equal(db.sessionRows[0].status, 'exchanged')
    assert.equal(db.sessionRows[0].tokenId, db.tokenRows[0].id)
})

test('getSession: pending grant session returns metadata', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)
    const agentA = db.agentRows.find((a) => a.id === 'agt_A')
    if (agentA) agentA.name = 'Workshop'
    const started = await cliAuth.start({
        requestedScopes: ['channels:read', 'channels:edit'],
        requestedAgentId: 'agt_A'
    })

    const session = await cliAuth.getSession({
        requestId: started.requestId,
        userCode: started.userCode
    })

    assert.equal(session.isGrantMode, true)
    assert.deepEqual(session.requestedScopes, [
        'channels:read',
        'channels:edit'
    ])
    assert.equal(session.requestedAgent?.id, 'agt_A')
    assert.equal(session.requestedAgent?.name, 'Workshop')
    assert.equal(session.status, 'pending')
    assert.equal(session.hasRedirect, false)
})

test('getSession: pending browser session returns isGrantMode=false', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)
    const started = await cliAuth.start({
        redirectUri: 'http://127.0.0.1:49152/callback'
    })

    const session = await cliAuth.getSession({
        requestId: started.requestId,
        userCode: started.userCode
    })

    assert.equal(session.isGrantMode, false)
    assert.equal(session.requestedScopes, null)
    assert.equal(session.requestedAgent, null)
    assert.equal(session.hasRedirect, true)
})

test('getSession: expired session reports status=expired', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)
    const started = await cliAuth.start({
        requestedScopes: ['channels:read'],
        requestedAgentId: 'agt_A'
    })
    db.sessionRows[0].expiresAt = new Date(Date.now() - 1_000)

    const session = await cliAuth.getSession({
        requestId: started.requestId,
        userCode: started.userCode
    })

    assert.equal(session.status, 'expired')
})

test('getSession: unknown requestId → 404', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)
    await assert.rejects(
        () =>
            cliAuth.getSession({
                requestId: 'cli_missing',
                userCode: 'AAAA-BBBB'
            }),
        /not found/
    )
})

test('getSession: wrong userCode → 404', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)
    const started = await cliAuth.start({
        redirectUri: 'http://127.0.0.1:49152/callback'
    })
    await assert.rejects(
        () =>
            cliAuth.getSession({
                requestId: started.requestId,
                userCode: 'WRON-GCDE'
            }),
        /not found/
    )
})

test('poll: subsequent poll after approval → status expired (single-use)', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)
    const started = await cliAuth.start({
        requestedScopes: ['channels:read'],
        requestedAgentId: 'agt_A'
    })
    await cliAuth.approve({
        requestId: started.requestId,
        userCode: started.userCode,
        userId: 'user-1',
        approvedScopes: ['channels:read']
    })
    await cliAuth.poll({ deviceCode: started.deviceCode! })

    const second = await cliAuth.poll({ deviceCode: started.deviceCode! })

    assert.deepEqual(second, { status: 'expired' })
    assert.equal(db.tokenRows.length, 1)
})
