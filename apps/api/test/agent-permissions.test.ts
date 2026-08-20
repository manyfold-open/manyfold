import { auditAction } from '@manyfold/shared'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    ForbiddenException,
    GoneException,
    NotFoundException,
    type ExecutionContext
} from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import type { Reflector } from '@nestjs/core'
import {
    agentPermissions,
    agents,
    auditLogs,
    permissionConsentRequests
} from '@manyfold/db'
import { AuthGuard } from '../src/common/guards/auth.guard'
import type { AuthzService } from '../src/modules/auth/authz.service'
import { AgentPermissionsService } from '../src/modules/auth/agent-permissions.service'
import { CryptoService } from '../src/modules/secrets/crypto.service'
import { ALLOW_RUNTIME_SELF_META } from '../src/common/decorators/allow-runtime-self.decorator'

const ctx = (request: unknown): ExecutionContext =>
    ({
        switchToHttp: () => ({ getRequest: () => request }),
        getHandler: () => (() => {}) as never,
        getClass: () => class {}
    }) as unknown as ExecutionContext

// Reflector that flags the handler as @AllowRuntimeSelf and nothing else.
const reflectorSelf = (): Reflector =>
    ({
        getAllAndOverride: (key: string) =>
            key === ALLOW_RUNTIME_SELF_META ? true : undefined
    }) as unknown as Reflector

// authz mock whose assertBoundTokenSubject enforces self-binding like the real
// one, and that records whether agent_permissions was consulted.
const authzSelf = (subjectAgentId: string, sink?: string[]): AuthzService =>
    ({
        getAgentPermissionScopes: async (id: string) => {
            sink?.push(id)
            return []
        },
        resolveSubjectAgent: async () => ({
            classification: { type: 'path', param: 'id' },
            subjectAgentId
        }),
        assertBoundTokenSubject: (
            bound: string,
            res: { subjectAgentId: string | null }
        ) => {
            if (res.subjectAgentId !== bound)
                throw new ForbiddenException(
                    `token bound to ${bound}, request targets ${res.subjectAgentId}`
                )
        },
        recordCrossAgentUse: async () => {}
    }) as unknown as AuthzService

const runtimeReq = () => ({
    headers: { authorization: 'Bearer nca_rt' },
    auth: undefined as unknown
})

const guardSelf = (subjectAgentId: string, sink?: string[]): AuthGuard =>
    new AuthGuard(
        {
            verifyBearerToken: async () => ({
                userId: 'user-1',
                kind: 'agent-runtime' as const,
                agentId: 'agt_A',
                runtimeTokenId: 'rtk_1'
            })
        } as never,
        reflectorSelf(),
        authzSelf(subjectAgentId, sink)
    )

test('@AllowRuntimeSelf: runtime identity reaches its OWN endpoint with no scope', async () => {
    const sink: string[] = []
    const req = runtimeReq()
    // subject resolves to the token's own agent (agt_A)
    assert.equal(await guardSelf('agt_A', sink).canActivate(ctx(req)), true)
    // crucially, authorization did NOT consult agent_permissions — the request
    // is allowed precisely because the agent has no scope yet.
    assert.deepEqual(sink, [])
})

test('@AllowRuntimeSelf: runtime identity CANNOT target another agent', async () => {
    const req = runtimeReq()
    await assert.rejects(
        () => guardSelf('agt_B').canActivate(ctx(req)),
        /token bound to agt_A/
    )
})

// ---- consent token + validation (no DB) ----

const TEST_KEY = Buffer.alloc(32, 7).toString('base64')

const consentConfig = (): ConfigService =>
    new ConfigService({
        API_CRYPTO_KEY: TEST_KEY,
        MF_WEB_URL: 'https://web.test'
    })

// PermDb is declared further down (owner-direct CRUD section); the default is
// evaluated per call, well after module init.
const buildService = (db: PermDb = new PermDb()): AgentPermissionsService => {
    const config = consentConfig()
    return new AgentPermissionsService(
        db as never,
        new CryptoService(config),
        config
    )
}

const tokenFrom = (url: string): string =>
    new URL(url).searchParams.get('token') ?? ''

const decodedToken = (token: string): Record<string, unknown> => {
    const crypto = new CryptoService(consentConfig())
    const enc = JSON.parse(Buffer.from(token, 'base64url').toString('utf8'))
    return JSON.parse(crypto.decrypt(enc)) as Record<string, unknown>
}

// Mints a token for an EXISTING request row whose durable expiry is in the
// past — the consent card re-rendered from chat history hours after the owner
// answered.
const staleTokenFor = (row: { id: string; expiresAt: Date }): string => {
    const crypto = new CryptoService(consentConfig())
    row.expiresAt = new Date(1)
    const enc = crypto.encrypt(JSON.stringify({ id: row.id, v: 2 }))
    return Buffer.from(JSON.stringify(enc)).toString('base64url')
}

test('createRequest → previewConsent round-trips the requested scopes', async () => {
    const svc = buildService()
    const req = await svc.createRequest({
        agentId: 'agt_A',
        scopes: ['channels:read']
    })
    assert.ok(req.consentUrl.startsWith('https://web.test/grant-permission?'))
    const preview = await svc.previewConsent(
        tokenFrom(req.consentUrl),
        'user-1'
    )
    assert.equal(preview.agentId, 'agt_A')
    assert.equal(preview.agentName, 'Agent A')
    assert.deepEqual(
        preview.scopes.map((s) => s.scope),
        ['channels:read']
    )
    assert.equal(preview.scopes[0].danger, 'low')
})

test('new tokens fail closed on a pre-stateful API during a rolling deploy', async () => {
    const db = new PermDb()
    const req = await buildService(db).createRequest({
        agentId: 'agt_A',
        scopes: ['channels:read']
    })
    const payload: Record<string, unknown> = decodedToken(
        tokenFrom(req.consentUrl)
    )

    assert.deepEqual(payload, { id: db.consentRows[0].id, v: 2 })
    // The previous API accepted only self-contained legacy claims. Keeping
    // those claims out of v2 means it rejects the request instead of granting
    // it without atomically consuming permission_consent_requests.
    const acceptedByPreviousApi = hasLegacyConsentClaims(payload)
    assert.equal(acceptedByPreviousApi, false)
})

const hasLegacyConsentClaims = (payload: Record<string, unknown>): boolean =>
    typeof payload.agentId === 'string' &&
    Array.isArray(payload.scopes) &&
    typeof payload.exp === 'number'

test('createRequest rejects api.full / chat.completions / empty', async () => {
    const svc = buildService()
    await assert.rejects(
        () =>
            svc.createRequest({
                agentId: 'agt_A',
                scopes: ['api.full'] as never
            }),
        /unsupported grantable scope/
    )
    await assert.rejects(
        () =>
            svc.createRequest({
                agentId: 'agt_A',
                scopes: ['chat.completions'] as never
            }),
        /unsupported grantable scope/
    )
    await assert.rejects(
        () => svc.createRequest({ agentId: 'agt_A', scopes: [] }),
        /non-empty/
    )
})

test('previewConsent rejects a tampered token', async () => {
    const svc = buildService()
    const req = await svc.createRequest({
        agentId: 'agt_A',
        scopes: ['channels:read']
    })
    const tampered = tokenFrom(req.consentUrl).slice(0, -4) + 'AAAA'
    await assert.rejects(
        () => svc.previewConsent(tampered, 'user-1'),
        /invalid or corrupt consent token|invalid consent token/
    )
})

test('previewConsent rejects an expired token that is still pending', async () => {
    const config = consentConfig()
    const crypto = new CryptoService(config)
    const svc = new AgentPermissionsService(
        new PermDb() as never,
        crypto,
        config
    )
    const enc = crypto.encrypt(
        JSON.stringify({ agentId: 'agt_A', scopes: ['channels:read'], exp: 1 })
    )
    const expired = Buffer.from(JSON.stringify(enc)).toString('base64url')
    await assert.rejects(() => svc.previewConsent(expired, 'user-1'), /expired/)
})

test('a stateful pending request takes expiry from its durable row', async () => {
    const db = new PermDb()
    const svc = buildService(db)
    const req = await svc.createRequest({
        agentId: 'agt_A',
        scopes: ['channels:read']
    })
    db.consentRows[0].expiresAt = new Date(1)

    await assert.rejects(
        () => svc.previewConsent(tokenFrom(req.consentUrl), 'user-1'),
        /expired/
    )
})

test('grantConsent rejects scopes outside the request', async () => {
    const svc = buildService()
    const req = await svc.createRequest({
        agentId: 'agt_A',
        scopes: ['channels:read']
    })
    await assert.rejects(
        () =>
            svc.grantConsent({
                token: tokenFrom(req.consentUrl),
                approverUserId: 'user-1',
                approvedScopes: ['files:edit']
            }),
        /subset of the requested scopes/
    )
})

// ---- single-use consent requests (permission_consent_requests) ----

test('createRequest opens a pending row and previewConsent reports it', async () => {
    const db = new PermDb()
    const svc = buildService(db)
    const req = await svc.createRequest({
        agentId: 'agt_A',
        scopes: ['channels:read']
    })
    assert.equal(db.consentRows.length, 1)
    assert.equal(db.consentRows[0].status, 'pending')
    assert.deepEqual(db.consentRows[0].requestedScopes, ['channels:read'])
    const preview = await svc.previewConsent(
        tokenFrom(req.consentUrl),
        'user-1'
    )
    assert.equal(preview.status, 'pending')
    assert.deepEqual(preview.approvedScopes, [])
    assert.equal(preview.resolvedAt, null)
})

// The reported bug: the owner approves, the chat card remounts on the next
// turn, and the preview has to say "already approved" instead of re-offering
// the buttons.
test('previewConsent reports the approval after the request is granted', async () => {
    const db = new PermDb()
    const svc = buildService(db)
    const req = await svc.createRequest({
        agentId: 'agt_A',
        scopes: ['a2a:read', 'channels:read']
    })
    const token = tokenFrom(req.consentUrl)
    await svc.grantConsent({
        token,
        approverUserId: 'user-1',
        approvedScopes: ['a2a:read']
    })
    const preview = await svc.previewConsent(token, 'user-1')
    assert.equal(preview.status, 'approved')
    assert.deepEqual(preview.approvedScopes, ['a2a:read'])
    assert.ok(preview.resolvedAt)
    assert.equal(db.consentRows[0].resolvedBy, 'user-1')
})

// The card outlives the token's hour, so expiry must not hide a decision that
// was already made — only a still-pending request is refused as expired.
test('previewConsent still reports the approval once the token has expired', async () => {
    const db = new PermDb()
    const svc = buildService(db)
    const req = await svc.createRequest({
        agentId: 'agt_A',
        scopes: ['channels:read']
    })
    await svc.grantConsent({
        token: tokenFrom(req.consentUrl),
        approverUserId: 'user-1',
        approvedScopes: ['channels:read']
    })
    const preview = await svc.previewConsent(
        staleTokenFor(db.consentRows[0]),
        'user-1'
    )
    assert.equal(preview.status, 'approved')
    assert.deepEqual(preview.approvedScopes, ['channels:read'])
})

test('a granted consent request cannot be replayed (410)', async () => {
    const db = new PermDb()
    const svc = buildService(db)
    const req = await svc.createRequest({
        agentId: 'agt_A',
        scopes: ['channels:read', 'files:read']
    })
    const token = tokenFrom(req.consentUrl)
    await svc.grantConsent({
        token,
        approverUserId: 'user-1',
        approvedScopes: ['channels:read']
    })
    await assert.rejects(
        () =>
            svc.grantConsent({
                token,
                approverUserId: 'user-1',
                approvedScopes: ['files:read']
            }),
        GoneException
    )
    // the replay granted nothing — the agent keeps only the approved scope
    assert.deepEqual(db.permRows[0].scopes, ['channels:read'])
})

test('denyConsent records the refusal, grants nothing, and audits it', async () => {
    const db = new PermDb()
    const svc = buildService(db)
    const req = await svc.createRequest({
        agentId: 'agt_A',
        scopes: ['channels:read']
    })
    const token = tokenFrom(req.consentUrl)
    const res = await svc.denyConsent({ token, approverUserId: 'user-1' })
    assert.equal(res.status, 'denied')
    assert.equal(db.consentRows[0].status, 'denied')
    assert.equal(db.consentRows[0].approvedScopes, null)
    assert.equal(db.permRows.length, 0)
    assert.equal(db.auditRows.at(-1)?.action, auditAction.PERMISSION_DENIED)
    const preview = await svc.previewConsent(token, 'user-1')
    assert.equal(preview.status, 'denied')
})

test('a denied consent request can no longer be approved (410)', async () => {
    const db = new PermDb()
    const svc = buildService(db)
    const req = await svc.createRequest({
        agentId: 'agt_A',
        scopes: ['channels:read']
    })
    const token = tokenFrom(req.consentUrl)
    await svc.denyConsent({ token, approverUserId: 'user-1' })
    await assert.rejects(
        () =>
            svc.grantConsent({
                token,
                approverUserId: 'user-1',
                approvedScopes: ['channels:read']
            }),
        GoneException
    )
    assert.equal(db.permRows.length, 0)
})

test('denyConsent rejects a request the caller does not own (NotFound)', async () => {
    const db = new PermDb()
    const svc = buildService(db)
    const req = await svc.createRequest({
        agentId: 'agt_A',
        scopes: ['channels:read']
    })
    await assert.rejects(
        () =>
            svc.denyConsent({
                token: tokenFrom(req.consentUrl),
                approverUserId: 'user-2'
            }),
        NotFoundException
    )
    assert.equal(db.consentRows[0].status, 'pending')
})

// Tokens minted before the table existed carry no request id. They must keep
// working (statelessly) for the rest of their hour instead of hard-failing.
test('a legacy token without a request id still previews and grants', async () => {
    const db = new PermDb()
    const config = consentConfig()
    const crypto = new CryptoService(config)
    const svc = new AgentPermissionsService(db as never, crypto, config)
    const enc = crypto.encrypt(
        JSON.stringify({
            agentId: 'agt_A',
            scopes: ['channels:read'],
            exp: Date.now() + 60_000
        })
    )
    const legacy = Buffer.from(JSON.stringify(enc)).toString('base64url')
    const preview = await svc.previewConsent(legacy, 'user-1')
    assert.equal(preview.status, 'pending')
    const res = await svc.grantConsent({
        token: legacy,
        approverUserId: 'user-1',
        approvedScopes: ['channels:read']
    })
    assert.deepEqual(res.scopes, ['channels:read'])
})

// ---- owner-direct CRUD (listForOwner / addForOwner / removeForOwner) ----

// A stateful fake that emulates the real jsonb semantics: append UNIONs the
// stored scopes with the inserted ones, revoke removes the set embedded in the
// UPDATE's sql fragment. That lets these tests assert the union/difference
// doctrine, not just control flow.
interface PermRow {
    agentId: string
    userId: string
    scopes: string[]
    grantedBy: string | null
    updatedAt: Date
}

interface ConsentRow {
    id: string
    agentId: string
    requestedScopes: string[]
    status: 'pending' | 'approved' | 'denied'
    approvedScopes: string[] | null
    resolvedBy: string | null
    resolvedAt: Date | null
    expiresAt: Date
}

class PermDb {
    agentRows = [
        { id: 'agt_A', userId: 'user-1', name: 'Agent A' },
        { id: 'agt_other', userId: 'user-2', name: 'Other' }
    ]
    permRows: PermRow[] = []
    consentRows: ConsentRow[] = []
    auditRows: Array<{ action: string; subject: string; meta: unknown }> = []

    select(_shape?: unknown) {
        return new PermQuery(this, 'select')
    }
    insert(table: unknown) {
        return new PermQuery(this, 'insert', table)
    }
    update(table: unknown) {
        return new PermQuery(this, 'update', table)
    }
    // Single-connection fake: the callback sees the same store, which is what
    // the grant path needs (claim + append must observe each other).
    transaction<T>(cb: (tx: PermDb) => Promise<T>): Promise<T> {
        return cb(this)
    }
}

const collectStrings = (cond: unknown): string[] => {
    const out: string[] = []
    const seen = new WeakSet<object>()
    const walk = (node: unknown): void => {
        if (node === null || typeof node !== 'object') return
        if (seen.has(node)) return
        seen.add(node)
        const rec = node as Record<string, unknown>
        if ('value' in rec && typeof rec.value === 'string') out.push(rec.value)
        for (const key of Object.keys(rec)) walk(rec[key])
    }
    walk(cond)
    return out
}

// The removed set is embedded as a JSON-array string chunk in the UPDATE's sql
// fragment; pull it back out so the fake can compute the difference.
const removedFromSetScopes = (scopes: unknown): string[] => {
    const chunks = (scopes as { queryChunks?: unknown[] })?.queryChunks ?? []
    for (const chunk of chunks) {
        if (typeof chunk !== 'string') continue
        try {
            const parsed = JSON.parse(chunk)
            if (Array.isArray(parsed)) return parsed as string[]
        } catch {
            // not the JSON chunk
        }
    }
    return []
}

class PermQuery {
    private table: unknown
    private whereParams: string[] = []
    private patch: Record<string, unknown> = {}
    private pending: Record<string, unknown> | null = null
    private ran = false

    constructor(
        private readonly db: PermDb,
        private readonly op: 'select' | 'insert' | 'update',
        table?: unknown
    ) {
        this.table = table
    }

    from(table: unknown) {
        this.table = table
        return this
    }

    values(value: Record<string, unknown>) {
        if (this.table === agentPermissions) this.pending = value
        if (this.table === permissionConsentRequests)
            this.db.consentRows.push({
                id: value.id as string,
                agentId: value.agentId as string,
                requestedScopes: (value.requestedScopes as string[]) ?? [],
                status: 'pending',
                approvedScopes: null,
                resolvedBy: null,
                resolvedAt: null,
                expiresAt: value.expiresAt as Date
            })
        if (this.table === auditLogs)
            this.db.auditRows.push({
                action: value.action as string,
                subject: value.subject as string,
                meta: value.meta
            })
        return this
    }

    onConflictDoUpdate(_arg: unknown) {
        const v = this.pending
        if (this.table === agentPermissions && v) {
            const existing = this.db.permRows.find(
                (r) => r.agentId === v.agentId
            )
            const added = (v.scopes as string[]) ?? []
            if (existing) {
                existing.scopes = [...new Set([...existing.scopes, ...added])]
                existing.grantedBy = v.grantedBy as string
                existing.updatedAt = new Date()
            } else {
                this.db.permRows.push({
                    agentId: v.agentId as string,
                    userId: v.userId as string,
                    scopes: [...new Set(added)],
                    grantedBy: (v.grantedBy as string | null) ?? null,
                    updatedAt: new Date()
                })
            }
        }
        return this
    }

    set(value: Record<string, unknown>) {
        this.patch = value
        return this
    }

    where(cond: unknown) {
        this.whereParams = collectStrings(cond)
        return this
    }

    limit(_n: number) {
        const agentParam = this.whereParams.find((p) => p.startsWith('agt_'))
        const userParam = this.whereParams.find((p) => p.startsWith('user-'))
        if (this.table === agents) {
            const row = this.db.agentRows.find(
                (r) => r.id === agentParam && r.userId === userParam
            )
            return Promise.resolve(row ? [{ name: row.name }] : [])
        }
        if (this.table === agentPermissions) {
            const row = this.db.permRows.find((r) => r.agentId === agentParam)
            return Promise.resolve(
                row ? [{ scopes: row.scopes, updatedAt: row.updatedAt }] : []
            )
        }
        if (this.table === permissionConsentRequests) {
            const row = this.db.consentRows.find(
                (r) => r.id === this.consentIdParam()
            )
            return Promise.resolve(row ? [row] : [])
        }
        return Promise.resolve([])
    }

    returning(_shape?: unknown) {
        return this.execute()
    }

    then<T = unknown[]>(
        onfulfilled?: ((value: unknown[]) => T | PromiseLike<T>) | null
    ): Promise<T> {
        return this.execute().then(onfulfilled ?? undefined)
    }

    private consentIdParam(): string | undefined {
        return this.whereParams.find((p) => p.startsWith('pcr_'))
    }

    private execute(): Promise<unknown[]> {
        if (this.ran) return Promise.resolve([])
        this.ran = true
        if (this.op === 'insert' && this.table === agentPermissions) {
            const row = this.db.permRows.find(
                (r) => r.agentId === this.pending?.agentId
            )
            return Promise.resolve(row ? [{ scopes: row.scopes }] : [])
        }
        if (this.op === 'update' && this.table === agentPermissions) {
            const agentParam = this.whereParams.find((p) =>
                p.startsWith('agt_')
            )
            const row = this.db.permRows.find((r) => r.agentId === agentParam)
            if (row) {
                const removed = new Set(removedFromSetScopes(this.patch.scopes))
                row.scopes = row.scopes.filter((s) => !removed.has(s))
                row.grantedBy =
                    (this.patch.grantedBy as string) ?? row.grantedBy
                row.updatedAt = new Date()
            }
        }
        if (this.op === 'update' && this.table === permissionConsentRequests) {
            const row = this.db.consentRows.find(
                (r) => r.id === this.consentIdParam()
            )
            if (!row) return Promise.resolve([])
            // Mirrors the real WHERE: drop the status guard in the service and
            // this fake stops guarding too, so the replay tests fail.
            if (
                this.whereParams.includes('pending') &&
                row.status !== 'pending'
            )
                return Promise.resolve([])
            row.status = this.patch.status as ConsentRow['status']
            row.approvedScopes =
                (this.patch.approvedScopes as string[] | null) ?? null
            row.resolvedBy = (this.patch.resolvedBy as string) ?? null
            row.resolvedAt = (this.patch.resolvedAt as Date) ?? new Date()
            return Promise.resolve([{ id: row.id }])
        }
        return Promise.resolve([])
    }
}

const ownerSvc = (db: PermDb): AgentPermissionsService =>
    new AgentPermissionsService(
        db as never,
        new CryptoService(new ConfigService({ API_CRYPTO_KEY: TEST_KEY })),
        new ConfigService({ API_CRYPTO_KEY: TEST_KEY })
    )

test('listForOwner returns empty list + null updatedAt when no row exists', async () => {
    const db = new PermDb()
    const res = await ownerSvc(db).listForOwner('agt_A', 'user-1')
    assert.deepEqual(res, { agentId: 'agt_A', scopes: [], updatedAt: null })
})

test('listForOwner returns stored grantable scopes for an owned agent', async () => {
    const db = new PermDb()
    db.permRows.push({
        agentId: 'agt_A',
        userId: 'user-1',
        // a stray non-grantable value must be filtered out on read
        scopes: ['channels:read', 'api.full', 'files:read'],
        grantedBy: 'user-1',
        updatedAt: new Date('2026-06-15T00:00:00Z')
    })
    const res = await ownerSvc(db).listForOwner('agt_A', 'user-1')
    assert.deepEqual([...res.scopes].sort(), ['channels:read', 'files:read'])
    assert.equal(res.updatedAt, '2026-06-15T00:00:00.000Z')
})

test('listForOwner rejects an agent the caller does not own (NotFound)', async () => {
    const db = new PermDb()
    await assert.rejects(
        () => ownerSvc(db).listForOwner('agt_other', 'user-1'),
        NotFoundException
    )
})

test('addForOwner appends scopes (creates the row) and audits PERMISSION_GRANTED', async () => {
    const db = new PermDb()
    const res = await ownerSvc(db).addForOwner('agt_A', 'user-1', [
        'channels:read'
    ])
    assert.deepEqual(res.scopes, ['channels:read'])
    assert.equal(db.permRows.length, 1)
    assert.equal(db.permRows[0].grantedBy, 'user-1')
    assert.equal(db.auditRows.at(-1)?.action, auditAction.PERMISSION_GRANTED)
})

test('addForOwner UNIONs with existing scopes (kept-not-replaced)', async () => {
    const db = new PermDb()
    await ownerSvc(db).addForOwner('agt_A', 'user-1', ['channels:read'])
    const res = await ownerSvc(db).addForOwner('agt_A', 'user-1', [
        'files:read',
        'channels:read'
    ])
    assert.deepEqual([...res.scopes].sort(), ['channels:read', 'files:read'])
    assert.equal(db.permRows.length, 1)
})

test('addForOwner rejects api.full / chat.completions (never grantable)', async () => {
    const db = new PermDb()
    await assert.rejects(
        () =>
            ownerSvc(db).addForOwner('agt_A', 'user-1', ['api.full'] as never),
        /unsupported grantable scope/
    )
    await assert.rejects(
        () =>
            ownerSvc(db).addForOwner('agt_A', 'user-1', [
                'chat.completions'
            ] as never),
        /unsupported grantable scope/
    )
    assert.equal(db.permRows.length, 0)
})

test('addForOwner rejects a non-owned agent (NotFound)', async () => {
    const db = new PermDb()
    await assert.rejects(
        () =>
            ownerSvc(db).addForOwner('agt_other', 'user-1', ['channels:read']),
        NotFoundException
    )
})

test('removeForOwner drops only the given scopes and audits PERMISSION_REVOKED', async () => {
    const db = new PermDb()
    await ownerSvc(db).addForOwner('agt_A', 'user-1', [
        'channels:read',
        'files:read',
        'skills:read'
    ])
    const res = await ownerSvc(db).removeForOwner('agt_A', 'user-1', [
        'files:read'
    ])
    assert.deepEqual([...res.scopes].sort(), ['channels:read', 'skills:read'])
    assert.equal(db.auditRows.at(-1)?.action, auditAction.PERMISSION_REVOKED)
})

test('removeForOwner is a no-op returning [] when no row exists', async () => {
    const db = new PermDb()
    const res = await ownerSvc(db).removeForOwner('agt_A', 'user-1', [
        'channels:read'
    ])
    assert.deepEqual(res.scopes, [])
    assert.equal(res.updatedAt, null)
    assert.equal(db.permRows.length, 0)
})

test('removeForOwner rejects a non-owned agent (NotFound)', async () => {
    const db = new PermDb()
    await assert.rejects(
        () =>
            ownerSvc(db).removeForOwner('agt_other', 'user-1', [
                'channels:read'
            ]),
        NotFoundException
    )
})
