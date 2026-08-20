import type { TokenCreatedVia } from '@manyfold/shared'
import test from 'node:test'
import assert from 'node:assert/strict'
import {
    BadRequestException,
    ConflictException,
    NotFoundException
} from '@nestjs/common'
import {
    agentPermissions,
    agents,
    apiTokens,
    type Database
} from '@manyfold/db'
import {
    ApiTokenService,
    hashApiToken
} from '../src/modules/auth/api-token.service'

interface TokenRow {
    id: string
    userId: string
    agentId: string | null
    name: string
    tokenHash: string
    scopes: string[]
    enforceAgentBinding: boolean
    createdVia: TokenCreatedVia | null
    lastUsedAt: Date | null
    expiresAt: Date | null
    revokedAt: Date | null
    createdAt: Date
}

interface AgentRow {
    id: string
    userId: string
}

interface Patch {
    revokedAt?: Date | null
    agentId?: string | null
    enforceAgentBinding?: boolean
    createdVia?: TokenCreatedVia | null
    lastUsedAt?: Date | null
}

class FakeDb {
    tokenRows: TokenRow[] = []
    agentRows: AgentRow[] = [
        { id: 'agt_A', userId: 'user-1' },
        { id: 'agt_B', userId: 'user-1' },
        { id: 'agt_other', userId: 'user-2' }
    ]
    userRows = [
        { id: 'user-1', email: 'user@example.com' },
        { id: 'user-2', email: 'other@example.com' }
    ]
    permissionRows: Array<{
        agentId: string
        userId: string
        scopes: string[]
        grantedBy: string | null
    }> = []

    select(_shape?: unknown) {
        return new FakeQuery(this, 'select')
    }
    insert(table: unknown) {
        return new FakeQuery(this, 'insert', table)
    }
    update(table: unknown) {
        return new FakeQuery(this, 'update', table)
    }
    transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
        return fn(this)
    }
}

class FakeQuery {
    private table: unknown
    private patch: Patch = {}
    private whereParams: unknown[] = []
    private pendingPermission: Record<string, unknown> | null = null

    constructor(
        private readonly db: FakeDb,
        private readonly op: 'select' | 'insert' | 'update',
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
                enforceAgentBinding:
                    (value.enforceAgentBinding as boolean | undefined) ?? false,
                createdVia:
                    (value.createdVia as TokenCreatedVia | null | undefined) ??
                    null,
                lastUsedAt: null,
                expiresAt: (value.expiresAt as Date | null) ?? null,
                revokedAt: null,
                createdAt:
                    (value.createdAt as Date | undefined) ?? new Date()
            })
        }
        if (this.table === agentPermissions) {
            this.pendingPermission = value
        }
        return this
    }

    onConflictDoUpdate(arg: { set?: Record<string, unknown> }) {
        if (this.table === agentPermissions && this.pendingPermission) {
            const v = this.pendingPermission
            const existing = this.db.permissionRows.find(
                (r) => r.agentId === v.agentId
            )
            if (existing) Object.assign(existing, arg.set ?? {})
            else
                this.db.permissionRows.push({
                    agentId: v.agentId as string,
                    userId: v.userId as string,
                    scopes: v.scopes as string[],
                    grantedBy: (v.grantedBy as string | null) ?? null
                })
        }
        return Promise.resolve([])
    }

    set(value: Patch) {
        this.patch = value
        return this
    }

    where(cond: unknown) {
        this.whereParams = collectParams(cond)
        return this
    }

    limit(_n: number) {
        const params = this.whereParams
        if (this.table === agents) {
            const agentParam = params.find(
                (p): p is string =>
                    typeof p === 'string' && p.startsWith('agt_')
            )
            const userParam = params.find(
                (p): p is string =>
                    typeof p === 'string' && p.startsWith('user-')
            )
            const row = this.db.agentRows.find(
                (r) => r.id === agentParam && r.userId === userParam
            )
            return Promise.resolve(row ? [{ id: row.id }] : [])
        }
        if (this.table === apiTokens) {
            const hashParam = params.find(
                (p): p is string => typeof p === 'string' && p.length === 64
            )
            const agentParam = params.find(
                (p): p is string =>
                    typeof p === 'string' && p.startsWith('agt_')
            )
            const tokenParam = params.find(
                (p): p is string =>
                    typeof p === 'string' && p.startsWith('pat_')
            )
            return Promise.resolve(
                this.db.tokenRows
                    .filter(
                        (row) =>
                            !hashParam || row.tokenHash === hashParam
                    )
                    .filter(
                        (row) => !agentParam || row.agentId === agentParam
                    )
                    .filter(
                        (row) => !tokenParam || row.id === tokenParam
                    )
                    // Filter active rows only when looking up by hash (verify
                    // path) or by agent (mintGrant precheck). Reauthorize
                    // intentionally surfaces revoked tokens by id so it can
                    // reject them.
                    .filter(
                        (row) =>
                            tokenParam !== undefined || !row.revokedAt
                    )
                    .map((row) => ({
                        id: row.id,
                        userId: row.userId,
                        agentId: row.agentId,
                        name: row.name,
                        scopes: row.scopes,
                        enforceAgentBinding: row.enforceAgentBinding,
                        createdVia: row.createdVia,
                        expiresAt: row.expiresAt,
                        revokedAt: row.revokedAt,
                        email:
                            this.db.userRows.find((u) => u.id === row.userId)
                                ?.email ?? ''
                    }))
            )
        }
        return Promise.resolve([])
    }

    then<TResult1 = unknown[], TResult2 = never>(
        onfulfilled?:
            | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
            | null,
        onrejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | null
    ): Promise<TResult1 | TResult2> {
        return this.execute().then(onfulfilled, onrejected)
    }

    private execute(): Promise<unknown[]> {
        if (this.op !== 'update') return Promise.resolve([])
        if (this.table !== apiTokens) return Promise.resolve([])

        const params = this.whereParams
        const agentParam = params.find(
            (p): p is string =>
                typeof p === 'string' && p.startsWith('agt_')
        )
        const tokenParam = params.find(
            (p): p is string =>
                typeof p === 'string' && p.startsWith('pat_')
        )

        for (const row of this.db.tokenRows) {
            if (agentParam && row.agentId !== agentParam) continue
            if (tokenParam && row.id !== tokenParam) continue
            if (this.patch.revokedAt && row.revokedAt) continue
            Object.assign(row, this.patch)
        }
        return Promise.resolve([])
    }
}

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
        for (const key of Object.keys(rec)) {
            walk(rec[key])
        }
    }
    walk(cond)
    return out
}

const newSvc = () => {
    const db = new FakeDb()
    const svc = new ApiTokenService(db as unknown as Database)
    return { db, svc }
}

const grantArgs = (overrides: Partial<Parameters<ApiTokenService['mintGrant']>[0]> = {}) => ({
    userId: 'user-1',
    agentId: 'agt_A',
    scopes: ['channels:edit' as const],
    createdVia: 'cli-poll' as TokenCreatedVia,
    enforceAgentBinding: false,
    replaceExisting: true,
    ...overrides
})

test('mintGrant dual-writes agent_permissions with the granted scopes', async () => {
    const { db, svc } = newSvc()
    await svc.mintGrant(grantArgs({ scopes: ['channels:edit', 'files:read'] }))
    assert.equal(db.permissionRows.length, 1)
    assert.equal(db.permissionRows[0].agentId, 'agt_A')
    assert.equal(db.permissionRows[0].grantedBy, 'user-1')
    assert.deepEqual(
        [...db.permissionRows[0].scopes].sort(),
        ['channels:edit', 'files:read'].sort()
    )
})

test('mintGrant UPSERT sets agent_permissions scopes on re-grant', async () => {
    const { db, svc } = newSvc()
    await svc.mintGrant(grantArgs({ scopes: ['channels:edit'] }))
    await svc.mintGrant(grantArgs({ scopes: ['files:read'] }))
    assert.equal(db.permissionRows.length, 1)
    assert.deepEqual(db.permissionRows[0].scopes, ['files:read'])
})

test('mintGrant binds agentId, persists scopes, and returns plaintext', async () => {
    const { db, svc } = newSvc()
    const minted = await svc.mintGrant(
        grantArgs({ scopes: ['channels:edit', 'channels:read'] })
    )

    assert.match(minted.plaintext, /^nca_[A-Za-z0-9_-]+$/)
    assert.equal(minted.expiresAt, null)
    assert.deepEqual(minted.scopes, ['channels:edit', 'channels:read'])
    assert.equal(minted.agentId, 'agt_A')
    assert.equal(minted.enforceAgentBinding, false)
    assert.equal(minted.createdVia, 'cli-poll')
    assert.equal(db.tokenRows.length, 1)
    assert.equal(db.tokenRows[0].agentId, 'agt_A')
    assert.equal(db.tokenRows[0].tokenHash, hashApiToken(minted.plaintext))
    assert.equal(db.tokenRows[0].revokedAt, null)
    assert.equal(db.tokenRows[0].createdVia, 'cli-poll')
    assert.equal(db.tokenRows[0].enforceAgentBinding, false)
    assert.match(db.tokenRows[0].name, /agent grant agt_A/)
})

test('mintGrant persists enforceAgentBinding=true and createdVia=user-grant', async () => {
    const { db, svc } = newSvc()
    const minted = await svc.mintGrant(
        grantArgs({
            createdVia: 'user-grant',
            enforceAgentBinding: true
        })
    )

    assert.equal(minted.enforceAgentBinding, true)
    assert.equal(minted.createdVia, 'user-grant')
    assert.equal(db.tokenRows[0].enforceAgentBinding, true)
    assert.equal(db.tokenRows[0].createdVia, 'user-grant')
})

test('mintGrant with replaceExisting=true revokes prior active grant for the same agent', async () => {
    const { db, svc } = newSvc()
    const first = await svc.mintGrant(grantArgs())
    const second = await svc.mintGrant(
        grantArgs({ scopes: ['channels:edit', 'channels:read'] })
    )

    assert.notEqual(first.tokenId, second.tokenId)
    assert.equal(db.tokenRows.length, 2)
    const firstRow = db.tokenRows.find((r) => r.id === first.tokenId)
    const secondRow = db.tokenRows.find((r) => r.id === second.tokenId)
    assert.ok(firstRow?.revokedAt instanceof Date)
    assert.equal(secondRow?.revokedAt, null)
    assert.deepEqual(secondRow?.scopes, ['channels:edit', 'channels:read'])
})

test('mintGrant with replaceExisting=false rejects when active grant exists', async () => {
    const { db, svc } = newSvc()
    await svc.mintGrant(grantArgs())

    await assert.rejects(
        () =>
            svc.mintGrant(
                grantArgs({
                    createdVia: 'user-grant',
                    replaceExisting: false
                })
            ),
        ConflictException
    )
    assert.equal(db.tokenRows.length, 1)
    assert.equal(db.tokenRows[0].revokedAt, null)
})

test('mintGrant with replaceExisting=false succeeds when no active grant exists', async () => {
    const { db, svc } = newSvc()
    const minted = await svc.mintGrant(
        grantArgs({
            createdVia: 'user-grant',
            enforceAgentBinding: true,
            replaceExisting: false
        })
    )

    assert.equal(minted.createdVia, 'user-grant')
    assert.equal(minted.enforceAgentBinding, true)
    assert.equal(db.tokenRows.length, 1)
})

test('mintGrant does NOT revoke grants for other agents', async () => {
    const { db, svc } = newSvc()
    await svc.mintGrant(grantArgs())
    await svc.mintGrant(
        grantArgs({ agentId: 'agt_B', scopes: ['channels:read'] })
    )

    const aRow = db.tokenRows.find((r) => r.agentId === 'agt_A')
    const bRow = db.tokenRows.find((r) => r.agentId === 'agt_B')
    assert.equal(aRow?.revokedAt, null)
    assert.equal(bRow?.revokedAt, null)
})

test('mintGrant rejects empty scopes', async () => {
    const { svc } = newSvc()
    await assert.rejects(
        () => svc.mintGrant(grantArgs({ scopes: [] })),
        BadRequestException
    )
})

test('mintGrant rejects api.full', async () => {
    const { svc } = newSvc()
    await assert.rejects(
        () => svc.mintGrant(grantArgs({ scopes: ['api.full' as never] })),
        BadRequestException
    )
})

test('mintGrant rejects chat.completions', async () => {
    const { svc } = newSvc()
    await assert.rejects(
        () =>
            svc.mintGrant(
                grantArgs({ scopes: ['chat.completions' as never] })
            ),
        BadRequestException
    )
})

test('mintGrant rejects unknown scope', async () => {
    const { svc } = newSvc()
    await assert.rejects(
        () =>
            svc.mintGrant(
                grantArgs({ scopes: ['nonsense:read' as never] })
            ),
        BadRequestException
    )
})

test('mintGrant rejects cross-user agent ownership', async () => {
    const { svc } = newSvc()
    await assert.rejects(
        () => svc.mintGrant(grantArgs({ agentId: 'agt_other' })),
        NotFoundException
    )
})

test('mintGrant rejects unknown agent', async () => {
    const { svc } = newSvc()
    await assert.rejects(
        () => svc.mintGrant(grantArgs({ agentId: 'agt_missing' })),
        NotFoundException
    )
})

test('mintGrant rejects unknown createdVia', async () => {
    const { svc } = newSvc()
    await assert.rejects(
        () =>
            svc.mintGrant(
                grantArgs({ createdVia: 'whoknows' as never })
            ),
        BadRequestException
    )
})

test('verify returns agentId, enforceAgentBinding, createdVia on grant tokens', async () => {
    const { svc } = newSvc()
    const minted = await svc.mintGrant(
        grantArgs({
            createdVia: 'user-grant',
            enforceAgentBinding: true
        })
    )

    const auth = await svc.verify(minted.plaintext)

    assert.equal(auth.kind, 'legacy-runtime')
    if (auth.kind !== 'legacy-runtime') return
    assert.equal(auth.agentId, 'agt_A')
    assert.equal(auth.enforceAgentBinding, true)
    assert.equal(auth.createdVia, 'user-grant')
    assert.deepEqual(auth.scopes, ['channels:edit'])
})

test('verify returns null agentId, false enforceAgentBinding on user-minted tokens', async () => {
    const { svc } = newSvc()
    const minted = await svc.mint({ userId: 'user-1', name: 'cli' })

    const auth = await svc.verify(minted.plaintext)

    // A user-minted PAT has no agent binding at all — the union expresses that
    // as the human-api-token arm (no agentId / enforceAgentBinding / createdVia
    // fields), which is the structural equivalent of the old null/false/null.
    assert.equal(auth.kind, 'human-api-token')
})
