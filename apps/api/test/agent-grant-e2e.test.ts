/**
 * Phase 9 — end-to-end grant lifecycle (services only, no HTTP).
 *
 * Drives the full happy path:
 *   1. CLI `start` (grant mode) creates a session with deviceCode
 *   2. Web `approve` records approvedScopes + agent ownership check
 *   3. CLI `poll` mints the grant token via ApiTokenService.mintGrantInTx
 *   4. AuthGuard accepts the token for a method requiring channels:edit
 *   5. AuthGuard rejects the same token for an endpoint requiring agents:edit
 *   6. ApiTokenService.revoke marks the token revoked
 *   7. AuthGuard rejects the token on the next request
 *   8. Re-login (start → approve → poll) with widened scopes mints a NEW
 *      token; old token stays revoked; new token passes channels:edit AND
 *      automations:read.
 */
import 'reflect-metadata'
import test from 'node:test'
import assert from 'node:assert/strict'
import type { ExecutionContext } from '@nestjs/common'
import { Reflector } from '@nestjs/core'
import {
    agents,
    apiTokens,
    cliAuthSessions,
    users,
    type Database
} from '@manyfold/db'
import { AuthGuard } from '../src/common/guards/auth.guard'
import { REQUIRED_API_TOKEN_SCOPES_META } from '../src/common/decorators/require-api-token-scope.decorator'
import { ApiTokenService } from '../src/modules/auth/api-token.service'
import { CliAuthRateLimitService } from '../src/modules/auth/cli-auth-rate-limit.service'
import { CliAuthService } from '../src/modules/auth/cli-auth.service'

// ---------- FakeDb (focused for this e2e) ----------

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
    agentRows: AgentRow[] = [
        { id: 'agt_A', userId: 'user-1', name: 'Workshop A' },
        { id: 'agt_B', userId: 'user-1', name: 'Workshop B' }
    ]
    userRows: UserRow[] = [{ id: 'user-1', email: 'user@example.com' }]

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
            // IMPORTANT: do NOT filter out revoked here. verify() needs to
            // see revoked tokens so it can throw "api token revoked".
            return Promise.resolve(
                this.db.tokenRows
                    .filter((row) => !hashParam || row.tokenHash === hashParam)
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
            this.db.sessionRows = []
            return Promise.resolve([])
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
            const userParam = params.find(
                (p): p is string =>
                    typeof p === 'string' && p.startsWith('user-')
            )
            const touched: TokenRow[] = []
            for (const row of this.db.tokenRows) {
                if (agentParam && row.agentId !== agentParam) continue
                if (tokenParam && row.id !== tokenParam) continue
                if (userParam && row.userId !== userParam) continue
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

// ---------- Guard plumbing ----------

const decorate = (
    handler: () => unknown,
    scopes: readonly string[]
): (() => unknown) => {
    Reflect.defineMetadata(REQUIRED_API_TOKEN_SCOPES_META, scopes, handler)
    return handler
}

const ctx = (request: unknown, handler: () => unknown): ExecutionContext =>
    ({
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => handler,
        getClass: () => class {}
    }) as unknown as ExecutionContext

const newStack = () => {
    const db = new FakeDb()
    const apiTokenSvc = new ApiTokenService(db as unknown as Database)
    const cliAuth = new CliAuthService(
        db as unknown as Database,
        { get: () => 'https://agents.example.test' } as never,
        apiTokenSvc,
        new CliAuthRateLimitService()
    )
    const guard = new AuthGuard(
        { verifyBearerToken: (t: string) => apiTokenSvc.verify(t) } as never,
        new Reflector(),
        {
            resolveSubjectAgent: async () => ({
                classification: null,
                subjectAgentId: null
            }),
            assertBoundTokenSubject: () => {},
            recordCrossAgentUse: async () => {}
        } as never
    )
    return { db, apiTokenSvc, cliAuth, guard }
}

// ---------- The e2e flow ----------

test('grant lifecycle: start → approve → poll → guard → revoke → re-login → guard', async () => {
    const { db, apiTokenSvc, cliAuth, guard } = newStack()

    // Step 1 — CLI starts the grant session.
    const started = await cliAuth.start({
        requestedScopes: ['channels:read', 'channels:edit'],
        requestedAgentId: 'agt_A'
    })
    assert.match(started.deviceCode ?? '', /^mf_dvc_/)
    assert.equal(db.sessionRows[0].status, 'pending')

    // Step 2 — User approves with the same scopes.
    const approved = await cliAuth.approve({
        requestId: started.requestId,
        userCode: started.userCode,
        userId: 'user-1',
        approvedScopes: ['channels:read', 'channels:edit']
    })
    assert.equal(approved.mode, 'grant')
    assert.equal(approved.authCode, null)

    // Step 3 — CLI polls and gets the token.
    const polled = await cliAuth.poll({ deviceCode: started.deviceCode! })
    assert.equal(polled.status, 'approved')
    if (polled.status !== 'approved') return
    const token = polled.token
    assert.match(token, /^nca_/)
    assert.deepEqual(polled.scopes, ['channels:read', 'channels:edit'])
    assert.equal(polled.userEmail, 'user@example.com')

    // Step 4 — Guard accepts the token for a channels:edit endpoint (acting
    // on a DIFFERENT agent than the token was minted for — decision #5).
    const channelsCreate = decorate(() => {}, ['channels:edit'])
    const request1 = {
        headers: { authorization: `Bearer ${token}` },
        body: { agentId: 'agt_B' },
        auth: undefined as unknown
    }
    assert.equal(await guard.canActivate(ctx(request1, channelsCreate)), true)
    const principal = request1.auth as {
        kind?: string
        agentId?: string
        matchedScopes?: string[]
    }
    assert.equal(principal.kind, 'legacy-runtime')
    assert.equal(principal.agentId, 'agt_A')
    assert.deepEqual(principal.matchedScopes, ['channels:edit'])

    // Step 5 — Guard rejects the token for an endpoint requiring agents:edit.
    const agentsEdit = decorate(() => {}, ['agents:edit'])
    await assert.rejects(
        () =>
            guard.canActivate(
                ctx(
                    {
                        headers: { authorization: `Bearer ${token}` },
                        auth: undefined as unknown
                    },
                    agentsEdit
                )
            ),
        /missing scope/
    )

    // Step 6 — Revoke the token.
    const tokenId = db.tokenRows[0].id
    await apiTokenSvc.revoke({ tokenId, userId: 'user-1' })
    assert.ok(db.tokenRows[0].revokedAt instanceof Date)

    // Step 7 — Guard rejects the revoked token (returns 401 'api token revoked').
    await assert.rejects(
        () =>
            guard.canActivate(
                ctx(
                    {
                        headers: { authorization: `Bearer ${token}` },
                        auth: undefined as unknown
                    },
                    channelsCreate
                )
            ),
        /revoked/
    )

    // Step 8 — Re-login with WIDENED scopes (add automations:read).
    const started2 = await cliAuth.start({
        requestedScopes: ['channels:read', 'channels:edit', 'automations:read'],
        requestedAgentId: 'agt_A'
    })
    await cliAuth.approve({
        requestId: started2.requestId,
        userCode: started2.userCode,
        userId: 'user-1',
        approvedScopes: ['channels:edit', 'automations:read']
    })
    const polled2 = await cliAuth.poll({ deviceCode: started2.deviceCode! })
    if (polled2.status !== 'approved')
        throw new Error('second poll did not approve')
    const token2 = polled2.token
    assert.notEqual(token, token2)
    assert.deepEqual(polled2.scopes, ['channels:edit', 'automations:read'])

    // Old token (still revoked) is still rejected.
    await assert.rejects(
        () =>
            guard.canActivate(
                ctx(
                    {
                        headers: { authorization: `Bearer ${token}` },
                        auth: undefined as unknown
                    },
                    channelsCreate
                )
            ),
        /revoked/
    )

    // New token reaches both channels:edit and automations:read.
    const automationsRead = decorate(() => {}, ['automations:read'])
    for (const handler of [channelsCreate, automationsRead]) {
        assert.equal(
            await guard.canActivate(
                ctx(
                    {
                        headers: { authorization: `Bearer ${token2}` },
                        auth: undefined as unknown
                    },
                    handler
                )
            ),
            true
        )
    }

    // New token does NOT have automations:edit — should still be rejected.
    const automationsEdit = decorate(() => {}, ['automations:edit'])
    await assert.rejects(
        () =>
            guard.canActivate(
                ctx(
                    {
                        headers: { authorization: `Bearer ${token2}` },
                        auth: undefined as unknown
                    },
                    automationsEdit
                )
            ),
        /missing scope/
    )
})

test('grant flow: prior grant for same agent is revoked when re-login mints', async () => {
    const { db, cliAuth } = newStack()

    const started1 = await cliAuth.start({
        requestedScopes: ['channels:read'],
        requestedAgentId: 'agt_A'
    })
    await cliAuth.approve({
        requestId: started1.requestId,
        userCode: started1.userCode,
        userId: 'user-1',
        approvedScopes: ['channels:read']
    })
    await cliAuth.poll({ deviceCode: started1.deviceCode! })
    const firstTokenId = db.tokenRows[0].id

    const started2 = await cliAuth.start({
        requestedScopes: ['channels:read', 'channels:edit'],
        requestedAgentId: 'agt_A'
    })
    await cliAuth.approve({
        requestId: started2.requestId,
        userCode: started2.userCode,
        userId: 'user-1',
        approvedScopes: ['channels:read', 'channels:edit']
    })
    await cliAuth.poll({ deviceCode: started2.deviceCode! })

    assert.equal(db.tokenRows.length, 2)
    const firstRow = db.tokenRows.find((r) => r.id === firstTokenId)
    assert.ok(
        firstRow?.revokedAt instanceof Date,
        'first grant should be auto-revoked when second mints'
    )
    const secondRow = db.tokenRows.find((r) => r.id !== firstTokenId)
    assert.equal(secondRow?.revokedAt, null)
})
