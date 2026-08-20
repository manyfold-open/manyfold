import test from 'node:test'
import assert from 'node:assert/strict'
import { apiTokens, cliAuthSessions, type Database } from '@manyfold/db'
import {
    ApiTokenService,
    API_TOKEN_SCOPE_CHAT_COMPLETIONS,
    API_TOKEN_SCOPE_FULL,
    hashApiToken
} from '../src/modules/auth/api-token.service'
import { CliAuthRateLimitService } from '../src/modules/auth/cli-auth-rate-limit.service'
import {
    CliAuthService,
    isLoopbackRedirectUri
} from '../src/modules/auth/cli-auth.service'

class FakeDb {
    tokenRows: Array<{
        id: string
        userId: string
        name: string
        tokenHash: string
        scopes: Array<'chat.completions' | 'api.full'>
        lastUsedAt: Date | null
        expiresAt: Date | null
        revokedAt: Date | null
        createdAt: Date
    }> = []

    sessionRows: Array<{
        id: string
        userCode: string
        redirectUri: string | null
        userId: string | null
        authCodeHash: string | null
        status: 'pending' | 'approved' | 'exchanged' | 'expired'
        tokenId: string | null
        expiresAt: Date
        approvedAt: Date | null
        exchangedAt: Date | null
        createdAt: Date
        updatedAt: Date
    }> = []

    userRows = [{ id: 'user-1', email: 'user@example.com' }]

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
                name: value.name as string,
                tokenHash: value.tokenHash as string,
                scopes:
                    (value.scopes as Array<'chat.completions' | 'api.full'>) ??
                    [],
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
                redirectUri: (value.redirectUri as string | null) ?? null,
                userId: null,
                authCodeHash: null,
                status: 'pending',
                tokenId: null,
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

    where(_cond: unknown) {
        if (this.op === 'update') {
            return this
        }
        return this
    }

    orderBy(_cond: unknown) {
        return Promise.resolve(
            this.db.tokenRows.map((row) => ({
                id: row.id,
                name: row.name,
                scopes: row.scopes,
                lastUsedAt: row.lastUsedAt,
                expiresAt: row.expiresAt,
                revokedAt: row.revokedAt,
                createdAt: row.createdAt
            }))
        )
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

    limit(_n: number) {
        if (this.table === apiTokens) {
            return Promise.resolve(
                this.db.tokenRows.map((row) => ({
                    id: row.id,
                    userId: row.userId,
                    agentId: null,
                    callerAgentId: null,
                    scopes: row.scopes,
                    enforceAgentBinding: false,
                    createdVia: null,
                    expiresAt: row.expiresAt,
                    revokedAt: row.revokedAt,
                    email:
                        this.db.userRows.find((u) => u.id === row.userId)
                            ?.email ?? ''
                }))
            )
        }
        return Promise.resolve(this.db.sessionRows.slice())
    }

    private execute(returnRows: boolean): Promise<unknown[]> {
        if (this.op === 'delete' && this.table === cliAuthSessions) {
            const cutoff = new Date(Date.now() - 5 * 60_000)
            const deleted = this.db.sessionRows.filter(
                (row) => row.expiresAt < cutoff
            )
            this.db.sessionRows = this.db.sessionRows.filter(
                (row) => row.expiresAt >= cutoff
            )
            return Promise.resolve(returnRows ? deleted : [])
        }
        if (this.op !== 'update') return Promise.resolve([])
        if (this.table === apiTokens) {
            for (const row of this.db.tokenRows) Object.assign(row, this.patch)
            return Promise.resolve([])
        }

        const touched: unknown[] = []
        for (const row of this.db.sessionRows) {
            if (!this.shouldUpdateSession(row)) continue
            Object.assign(row, this.patch)
            touched.push({ ...row })
        }
        return Promise.resolve(returnRows ? touched : [])
    }

    private shouldUpdateSession(row: FakeDb['sessionRows'][number]): boolean {
        if (this.patch.status === 'approved')
            return row.status === 'pending' && row.expiresAt > new Date()
        if (
            this.patch.status === 'exchanged' &&
            this.patch.tokenId === undefined
        )
            return (
                row.status === 'approved' &&
                row.userId !== null &&
                row.expiresAt > new Date()
            )
        if (this.patch.tokenId !== undefined) return row.status === 'exchanged'
        return true
    }
}

const newCliAuth = (
    db: FakeDb,
    config: { get: (key: string) => string | undefined } = {
        get: () => 'https://agents.example.test'
    }
): CliAuthService =>
    new CliAuthService(
        db as unknown as Database,
        config as never,
        new ApiTokenService(db as unknown as Database),
        new CliAuthRateLimitService()
    )

test('ApiTokenService mints nca_ tokens and persists only hashes', async () => {
    const db = new FakeDb()
    const svc = new ApiTokenService(db as unknown as Database)
    const minted = await svc.mint({ userId: 'user-1', name: 'cli' })

    assert.match(minted.plaintext, /^nca_[A-Za-z0-9_-]+$/)
    assert.equal(db.tokenRows.length, 1)
    assert.equal(db.tokenRows[0].tokenHash, hashApiToken(minted.plaintext))
    assert.notEqual(db.tokenRows[0].tokenHash, minted.plaintext)
    assert.deepEqual(db.tokenRows[0].scopes, [API_TOKEN_SCOPE_CHAT_COMPLETIONS])
    assert.equal(db.tokenRows[0].expiresAt, null)
})

test('ApiTokenService supports explicit scopes and expiry', async () => {
    const db = new FakeDb()
    const svc = new ApiTokenService(db as unknown as Database)
    const minted = await svc.mint({
        userId: 'user-1',
        name: 'external app',
        scopes: [API_TOKEN_SCOPE_FULL],
        expiresInDays: 30
    })

    assert.deepEqual(minted.scopes, [API_TOKEN_SCOPE_FULL])
    assert.ok(minted.expiresAt instanceof Date)
    assert.deepEqual(db.tokenRows[0].scopes, [API_TOKEN_SCOPE_FULL])
})

test('ApiTokenService verifies tokens, returns user context and scopes, and touches lastUsedAt', async () => {
    const db = new FakeDb()
    const svc = new ApiTokenService(db as unknown as Database)
    const minted = await svc.mint({ userId: 'user-1', name: 'cli' })

    const auth = await svc.verify(minted.plaintext)

    assert.deepEqual(auth, {
        userId: 'user-1',
        email: 'user@example.com',
        kind: 'human-api-token',
        tokenId: minted.tokenId,
        scopes: [API_TOKEN_SCOPE_CHAT_COMPLETIONS]
    })
    assert.ok(db.tokenRows[0].lastUsedAt instanceof Date)
})

test('ApiTokenService rejects revoked tokens', async () => {
    const db = new FakeDb()
    const svc = new ApiTokenService(db as unknown as Database)
    const minted = await svc.mint({ userId: 'user-1', name: 'cli' })
    db.tokenRows[0].revokedAt = new Date()

    await assert.rejects(() => svc.verify(minted.plaintext), /revoked/)
})

test('ApiTokenService rejects expired tokens', async () => {
    const db = new FakeDb()
    const svc = new ApiTokenService(db as unknown as Database)
    const minted = await svc.mint({ userId: 'user-1', name: 'cli' })
    db.tokenRows[0].expiresAt = new Date(Date.now() - 1_000)

    await assert.rejects(() => svc.verify(minted.plaintext), /expired/)
})

test('ApiTokenService lists token summaries without plaintext', async () => {
    const db = new FakeDb()
    const svc = new ApiTokenService(db as unknown as Database)
    const minted = await svc.mint({ userId: 'user-1', name: 'integration' })

    const rows = await svc.listForUser('user-1')

    assert.equal(rows.length, 1)
    assert.equal(rows[0].id, minted.tokenId)
    assert.equal(rows[0].name, 'integration')
    assert.deepEqual(rows[0].scopes, [API_TOKEN_SCOPE_CHAT_COMPLETIONS])
    assert.equal('token' in rows[0], false)
})

test('ApiTokenService revoke marks token revoked', async () => {
    const db = new FakeDb()
    const svc = new ApiTokenService(db as unknown as Database)
    const minted = await svc.mint({ userId: 'user-1', name: 'integration' })

    await svc.revoke({ tokenId: minted.tokenId, userId: 'user-1' })

    assert.ok(db.tokenRows[0].revokedAt instanceof Date)
    await assert.rejects(() => svc.verify(minted.plaintext), /revoked/)
})

test('CliAuthService rejects non-loopback redirect URIs', async () => {
    assert.equal(isLoopbackRedirectUri('http://127.0.0.1:49152/callback'), true)
    assert.equal(isLoopbackRedirectUri('https://127.0.0.1/callback'), false)
    assert.equal(isLoopbackRedirectUri('http://example.com/callback'), false)
})

test('CliAuthService builds authUrl from configured web URL', async () => {
    const cliAuth = newCliAuth(new FakeDb(), {
        get: (key) =>
            key === 'MF_WEB_URL' ? 'https://app.example.com' : undefined
    })

    const started = await cliAuth.start({})

    assert.match(
        started.authUrl,
        /^https:\/\/app\.example\.com\/cli-login\?/
    )
})

test('CliAuthService builds local authUrl from WEB_BASE_URL fallback', async () => {
    const cliAuth = newCliAuth(new FakeDb(), {
        get: (key) =>
            key === 'WEB_BASE_URL' ? 'http://localhost:3002' : undefined
    })

    const started = await cliAuth.start({})

    assert.match(started.authUrl, /^http:\/\/localhost:3002\/cli-login\?/)
})

test('CliAuthService prefers MF_WEB_URL over WEB_BASE_URL', async () => {
    const cliAuth = newCliAuth(new FakeDb(), {
        get: (key) =>
            key === 'MF_WEB_URL'
                ? 'https://override.example.test'
                : key === 'WEB_BASE_URL'
                  ? 'http://localhost:3002'
                  : undefined
    })

    const started = await cliAuth.start({})

    assert.match(
        started.authUrl,
        /^https:\/\/override\.example\.test\/cli-login\?/
    )
})

test('CliAuthService accepts legacy NCA_WEB_URL fallback', async () => {
    const cliAuth = newCliAuth(new FakeDb(), {
        get: (key) =>
            key === 'NCA_WEB_URL' ? 'https://legacy.example.test' : undefined
    })

    const started = await cliAuth.start({})

    assert.match(
        started.authUrl,
        /^https:\/\/legacy\.example\.test\/cli-login\?/
    )
})

test('CliAuthService exchanges auth code once for an API token', async () => {
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
    assert.ok(approved.authCode)
    const exchanged = await cliAuth.exchange(approved.authCode)

    assert.match(
        approved.redirectUrl ?? '',
        /^http:\/\/127\.0\.0\.1:49152\/callback\?/
    )
    assert.match(exchanged.token, /^nca_/)
    const authCode = approved.authCode
    await assert.rejects(() => cliAuth.exchange(authCode), /already used/)
    assert.equal(db.tokenRows.length, 1)
    assert.equal(db.sessionRows[0].tokenId, db.tokenRows[0].id)
    assert.deepEqual(db.tokenRows[0].scopes, [API_TOKEN_SCOPE_FULL])
})

test('CliAuthService rejects duplicate approve without replacing auth code', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)

    const started = await cliAuth.start({
        redirectUri: 'http://127.0.0.1:49152/callback'
    })
    await cliAuth.approve({
        requestId: started.requestId,
        userCode: started.userCode,
        userId: 'user-1'
    })
    const firstHash = db.sessionRows[0].authCodeHash

    await assert.rejects(
        () =>
            cliAuth.approve({
                requestId: started.requestId,
                userCode: started.userCode,
                userId: 'user-1'
            }),
        /not pending/
    )
    assert.equal(db.sessionRows[0].authCodeHash, firstHash)
})

test('CliAuthService mints one token for concurrent exchange attempts', async () => {
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
    assert.ok(approved.authCode)

    const results = await Promise.allSettled([
        cliAuth.exchange(approved.authCode),
        cliAuth.exchange(approved.authCode)
    ])

    assert.equal(
        results.filter((result) => result.status === 'fulfilled').length,
        1
    )
    assert.equal(
        results.filter((result) => result.status === 'rejected').length,
        1
    )
    assert.equal(db.tokenRows.length, 1)
    assert.equal(db.sessionRows[0].tokenId, db.tokenRows[0].id)
})

test('CliAuthService cleanup removes retained expired sessions', async () => {
    const db = new FakeDb()
    const cliAuth = newCliAuth(db)
    await cliAuth.start({ redirectUri: 'http://127.0.0.1:49152/callback' })
    await cliAuth.start({ redirectUri: 'http://127.0.0.1:49153/callback' })
    db.sessionRows[0].expiresAt = new Date(Date.now() - 10 * 60_000)

    const deleted = await cliAuth.cleanupExpiredSessions()

    assert.equal(deleted, 1)
    assert.equal(db.sessionRows.length, 1)
})

test('CliAuthRateLimitService rejects over-limit calls and resets after sweep', () => {
    const limiter = new CliAuthRateLimitService()
    limiter.consume({ key: 'cli-auth:start:ip', limit: 2, windowMs: 60_000 })
    limiter.consume({ key: 'cli-auth:start:ip', limit: 2, windowMs: 60_000 })

    assert.throws(
        () =>
            limiter.consume({
                key: 'cli-auth:start:ip',
                limit: 2,
                windowMs: 60_000
            }),
        /rate limit exceeded/
    )

    limiter.sweep(Date.now() + 61_000)
    limiter.consume({ key: 'cli-auth:start:ip', limit: 2, windowMs: 60_000 })
})
