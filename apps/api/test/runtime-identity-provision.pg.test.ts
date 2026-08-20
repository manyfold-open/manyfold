import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { and, eq, isNull } from 'drizzle-orm'
import { ConfigService } from '@nestjs/config'
import {
    agentPermissions,
    agentRuntimeTokens,
    agentRuntimes,
    agents,
    createDb,
    tokenCredentials,
    users,
    type Database
} from '@manyfold/db'
import { RuntimeTokenService } from '../src/modules/auth/runtime-token.service'
import { AgentPermissionsService } from '../src/modules/auth/agent-permissions.service'
import { CryptoService } from '../src/modules/secrets/crypto.service'
import { hashApiToken } from '../src/modules/auth/api-token.service'

const TEST_CRYPTO_KEY = Buffer.alloc(32, 9).toString('base64')

const permissionsService = (db: Database): AgentPermissionsService => {
    const config = new ConfigService({
        API_CRYPTO_KEY: TEST_CRYPTO_KEY,
        MF_WEB_URL: 'https://web.test'
    })
    return new AgentPermissionsService(db, new CryptoService(config), config)
}

const consentTokenFrom = (url: string): string =>
    new URL(url).searchParams.get('token') ?? ''

// Real-Postgres FK + ordering proof for runtime-identity provisioning. The
// in-memory FakeCreateAgentDb harnesses (sprites-/k8s-runtime-identity.test.ts)
// simulate the FK contract but cannot raise a real 23503 — which is exactly the
// class of bug that let the original 5b-2/5b-3 mint-before-agents-row ship. This
// asserts the contract against live PG. Env-gated like recovery-e2e: run with
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
// against a migrated DB (`just db-migrate`). Requires the seeded `free` plan row.
const RUN = process.env.RUN_PG_E2E === '1'

const isFkViolation = (err: unknown): boolean => {
    const code = (err as { code?: string })?.code
    return code === '23503' || /foreign key|violates/i.test(String(err))
}

interface Harness {
    db: Database
    svc: RuntimeTokenService
    userId: string
    runtimeId: string
    agentId: string
    mintedHashes: string[]
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const crypto = new CryptoService(
        new ConfigService({ API_CRYPTO_KEY: TEST_CRYPTO_KEY })
    )
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const runtimeId = `art_pgtest_${suffix}`
    const agentId = `agent_pgtest_${suffix}`
    const mintedHashes: string[] = []

    await db
        .insert(users)
        .values({ id: userId, email: `${suffix}@pgtest.local` })
    await db.insert(agentRuntimes).values({
        id: runtimeId,
        userId,
        name: `pgtest-runtime-${suffix}`,
        framework: 'claude-code',
        kind: 'sprites'
    })

    return {
        db,
        svc: new RuntimeTokenService(db, crypto),
        userId,
        runtimeId,
        agentId,
        mintedHashes,
        close: async (): Promise<void> => {
            // Delete the user → cascades agents, agent_runtimes, and
            // agent_runtime_tokens (all FK userId ON DELETE CASCADE). Then sweep
            // the orphaned token_credentials parents this run minted.
            await db.delete(users).where(eq(users.id, userId))
            for (const h of mintedHashes)
                await db
                    .delete(tokenCredentials)
                    .where(eq(tokenCredentials.tokenHash, h))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
}

const insertAgent = async (h: Harness): Promise<void> => {
    await h.db.insert(agents).values({
        id: h.agentId,
        userId: h.userId,
        name: 'pgtest-agent',
        framework: 'claude-code',
        runtime: 'sprites',
        runtimeId: h.runtimeId,
        internalId: `internal-${h.agentId}`
    })
}

const activeTokens = async (h: Harness): Promise<{ id: string }[]> =>
    h.db
        .select({ id: agentRuntimeTokens.id })
        .from(agentRuntimeTokens)
        .where(
            and(
                eq(agentRuntimeTokens.agentId, h.agentId),
                eq(agentRuntimeTokens.runtimeKind, 'sprites'),
                isNull(agentRuntimeTokens.revokedAt)
            )
        )

test('mintRuntimeIdentity rejects with FK 23503 when the agents row is missing', async (t) => {
    if (!RUN) {
        t.skip('set RUN_PG_E2E=1 to run')
        return
    }
    const h = await buildHarness()
    try {
        const runtimeCredsBefore = (
            await h.db
                .select({ hash: tokenCredentials.tokenHash })
                .from(tokenCredentials)
                .where(eq(tokenCredentials.kind, 'runtime'))
        ).length
        // The original 5b bug: mint before the agents row exists.
        await assert.rejects(
            h.svc.mintRuntimeIdentity({
                userId: h.userId,
                agentId: h.agentId,
                runtimeKind: 'sprites'
            }),
            isFkViolation,
            'mint before agents row must violate the agent_id FK'
        )
        // The transaction must have rolled back the token_credentials parent it
        // inserted before the failing child insert — no leaked runtime parent.
        const runtimeCredsAfter = (
            await h.db
                .select({ hash: tokenCredentials.tokenHash })
                .from(tokenCredentials)
                .where(eq(tokenCredentials.kind, 'runtime'))
        ).length
        assert.equal(
            runtimeCredsAfter,
            runtimeCredsBefore,
            'failed mint must roll back its token_credentials parent'
        )
    } finally {
        await h.close()
    }
})

test('mintRuntimeIdentity writes credential + identity after the agents row exists', async (t) => {
    if (!RUN) {
        t.skip('set RUN_PG_E2E=1 to run')
        return
    }
    const h = await buildHarness()
    try {
        await insertAgent(h)
        const minted = await h.svc.mintRuntimeIdentity({
            userId: h.userId,
            agentId: h.agentId,
            runtimeKind: 'sprites'
        })
        h.mintedHashes.push(hashApiToken(minted.plaintext))

        const [cred] = await h.db
            .select()
            .from(tokenCredentials)
            .where(
                eq(tokenCredentials.tokenHash, hashApiToken(minted.plaintext))
            )
        assert.equal(cred?.kind, 'runtime', 'parent credential must be runtime')

        const [row] = await h.db
            .select()
            .from(agentRuntimeTokens)
            .where(eq(agentRuntimeTokens.id, minted.runtimeTokenId))
        assert.ok(row, 'identity row must exist')
        assert.equal(row.tokenHash, hashApiToken(minted.plaintext))
        assert.equal(row.agentId, h.agentId)
        assert.equal(row.revokedAt, null, 'fresh identity must be active')
    } finally {
        await h.close()
    }
})

test('mintRuntimeIdentity rotation revokes the prior active row (partial unique holds)', async (t) => {
    if (!RUN) {
        t.skip('set RUN_PG_E2E=1 to run')
        return
    }
    const h = await buildHarness()
    try {
        await insertAgent(h)
        const first = await h.svc.mintRuntimeIdentity({
            userId: h.userId,
            agentId: h.agentId,
            runtimeKind: 'sprites'
        })
        h.mintedHashes.push(hashApiToken(first.plaintext))
        const second = await h.svc.mintRuntimeIdentity({
            userId: h.userId,
            agentId: h.agentId,
            runtimeKind: 'sprites'
        })
        h.mintedHashes.push(hashApiToken(second.plaintext))

        const active = await activeTokens(h)
        assert.equal(
            active.length,
            1,
            'exactly one active identity per (agent,kind)'
        )
        assert.equal(active[0].id, second.runtimeTokenId, 'newest wins')

        const [old] = await h.db
            .select({ revokedAt: agentRuntimeTokens.revokedAt })
            .from(agentRuntimeTokens)
            .where(eq(agentRuntimeTokens.id, first.runtimeTokenId))
        assert.ok(old?.revokedAt, 'prior identity must be revoked')
    } finally {
        await h.close()
    }
})

test('deleting the agents row cascades its runtime identity tokens', async (t) => {
    if (!RUN) {
        t.skip('set RUN_PG_E2E=1 to run')
        return
    }
    const h = await buildHarness()
    try {
        await insertAgent(h)
        const minted = await h.svc.mintRuntimeIdentity({
            userId: h.userId,
            agentId: h.agentId,
            runtimeKind: 'sprites'
        })
        h.mintedHashes.push(hashApiToken(minted.plaintext))

        await h.db.delete(agents).where(eq(agents.id, h.agentId))

        const rows = await h.db
            .select({ id: agentRuntimeTokens.id })
            .from(agentRuntimeTokens)
            .where(eq(agentRuntimeTokens.agentId, h.agentId))
        assert.equal(
            rows.length,
            0,
            'agent delete must cascade identity tokens'
        )
    } finally {
        await h.close()
    }
})

test('grantConsent APPENDS to agent_permissions (kept-not-replaced)', async (t) => {
    if (!RUN) {
        t.skip('set RUN_PG_E2E=1 to run')
        return
    }
    const h = await buildHarness()
    try {
        await insertAgent(h)
        const svc = permissionsService(h.db)

        const r1 = await svc.createRequest({
            agentId: h.agentId,
            scopes: ['channels:read']
        })
        const g1 = await svc.grantConsent({
            token: consentTokenFrom(r1.consentUrl),
            approverUserId: h.userId,
            approvedScopes: ['channels:read']
        })
        assert.deepEqual(g1.scopes.sort(), ['channels:read'])

        // A second request for a DIFFERENT scope must NOT wipe the first — this
        // is the whole "incremental / kept-not-replaced" doctrine.
        const r2 = await svc.createRequest({
            agentId: h.agentId,
            scopes: ['files:read']
        })
        const g2 = await svc.grantConsent({
            token: consentTokenFrom(r2.consentUrl),
            approverUserId: h.userId,
            approvedScopes: ['files:read']
        })
        assert.deepEqual(g2.scopes.sort(), ['channels:read', 'files:read'])

        // Idempotent: re-granting an existing scope does not duplicate it.
        const r3 = await svc.createRequest({
            agentId: h.agentId,
            scopes: ['channels:read']
        })
        const g3 = await svc.grantConsent({
            token: consentTokenFrom(r3.consentUrl),
            approverUserId: h.userId,
            approvedScopes: ['channels:read']
        })
        assert.deepEqual(g3.scopes.sort(), ['channels:read', 'files:read'])

        const [row] = await h.db
            .select({ scopes: agentPermissions.scopes })
            .from(agentPermissions)
            .where(eq(agentPermissions.agentId, h.agentId))
            .limit(1)
        assert.deepEqual([...((row?.scopes as string[]) ?? [])].sort(), [
            'channels:read',
            'files:read'
        ])
    } finally {
        await h.close()
    }
})

test('grantConsent refuses a non-owner approver', async (t) => {
    if (!RUN) {
        t.skip('set RUN_PG_E2E=1 to run')
        return
    }
    const h = await buildHarness()
    try {
        await insertAgent(h)
        const svc = permissionsService(h.db)
        const r = await svc.createRequest({
            agentId: h.agentId,
            scopes: ['channels:read']
        })
        await assert.rejects(
            svc.grantConsent({
                token: consentTokenFrom(r.consentUrl),
                approverUserId: 'user_not_owner',
                approvedScopes: ['channels:read']
            }),
            /not owned by user or not found/
        )
    } finally {
        await h.close()
    }
})
