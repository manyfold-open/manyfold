import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { and, eq } from 'drizzle-orm'
import { BadRequestException, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import {
    agentRuntimes,
    agents,
    createDb,
    userConnections,
    users,
    type Database
} from '@manyfold/db'
import { ConnectionsService } from '../src/modules/connections/connections.service'
import { CryptoService } from '../src/modules/secrets/crypto.service'

// Real-Postgres proof of the Composio connection lifecycle against live Drizzle:
// invalid keys are refused, valid keys land encrypted (never plaintext), the key
// fingerprint that idempotency rides on never surfaces in the summary, re-pasting
// the same key updates the same row, and ownership is enforced. Env-gated like
// the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
// against a migrated DB (`just db-migrate`).
const RUN = process.env.RUN_PG_E2E === '1'
const TEST_CRYPTO_KEY = Buffer.alloc(32, 9).toString('base64')

const makeService = (
    db: Database,
    verifyValid: boolean,
    onRefresh?: (agentId: string) => void
): ConnectionsService => {
    const crypto = new CryptoService(
        new ConfigService({ API_CRYPTO_KEY: TEST_CRYPTO_KEY })
    )
    const composio = { verifyKey: async () => ({ valid: verifyValid }) }
    const materializer = {
        refreshOnChange: async (agent: { id: string }) => onRefresh?.(agent.id)
    }
    const moduleRef = { get: () => materializer }
    return new ConnectionsService(
        db,
        crypto,
        {} as never,
        composio as never,
        {} as never,
        moduleRef as never
    )
}

interface Harness {
    db: Database
    userId: string
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    await db
        .insert(users)
        .values({ id: userId, email: `${suffix}@pgtest.local` })
    return {
        db,
        userId,
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, userId))
        }
    }
}

test('createComposio refuses an invalid key and stores nothing', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const svc = makeService(h.db, false)
        await assert.rejects(
            () => svc.createComposio(h.userId, { apiKey: 'ak_bad_key_123' }),
            BadRequestException
        )
        const rows = await h.db
            .select()
            .from(userConnections)
            .where(eq(userConnections.userId, h.userId))
        assert.equal(rows.length, 0)
    } finally {
        await h.close()
    }
})

test('createComposio encrypts the key, hides the fingerprint, and is idempotent on re-paste', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const svc = makeService(h.db, true)
        const summary = await svc.createComposio(h.userId, {
            apiKey: 'ak_live_secret',
            name: 'My Composio'
        })
        assert.equal(summary.provider, 'composio')
        assert.equal(summary.displayName, 'My Composio')
        assert.equal(summary.externalId, null)
        assert.equal(summary.manageUrl, null)

        const [row] = await h.db
            .select()
            .from(userConnections)
            .where(eq(userConnections.id, summary.id))
        assert.ok(row.secretCiphertext)
        assert.notEqual(row.secretCiphertext, 'ak_live_secret')
        assert.equal(row.externalId?.length, 64)

        const again = await svc.createComposio(h.userId, {
            apiKey: 'ak_live_secret',
            name: 'Renamed'
        })
        assert.equal(again.id, summary.id)
        const all = await h.db
            .select()
            .from(userConnections)
            .where(
                and(
                    eq(userConnections.userId, h.userId),
                    eq(userConnections.provider, 'composio')
                )
            )
        assert.equal(all.length, 1)
        assert.equal(all[0].displayName, 'Renamed')
    } finally {
        await h.close()
    }
})

test('revealComposioKey returns the decrypted key to the owner, else 404', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const svc = makeService(h.db, true)
        const conn = await svc.createComposio(h.userId, {
            apiKey: 'ak_reveal_me'
        })
        const revealed = await svc.revealComposioKey(h.userId, conn.id)
        assert.equal(revealed.apiKey, 'ak_reveal_me')
        // Nonexistent / not owned → NotFound (decryptComposioKey enforces owner).
        await assert.rejects(
            () => svc.revealComposioKey(h.userId, 'ucn_does_not_exist'),
            NotFoundException
        )
    } finally {
        await h.close()
    }
})

test('assertOwned rejects a composio connection the user does not own', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const svc = makeService(h.db, true)
        await assert.rejects(
            () => svc.assertOwned(h.userId, 'ucn_does_not_exist', 'composio'),
            BadRequestException
        )
    } finally {
        await h.close()
    }
})

// B2/B3/S3: revoking a Composio connection fans out a re-materialize to every
// agent bound to it, so the managed `composio` server is dropped from their
// sprites. The fan-out finds agents by extras->>composioConnectionId.
test('deleting a composio connection re-materializes bound agents', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const refreshed: string[] = []
        const svc = makeService(h.db, true, (id) => refreshed.push(id))
        const conn = await svc.createComposio(h.userId, {
            apiKey: 'ak_live_secret'
        })
        // Connect fan-out finds nothing yet — no agent is bound.
        assert.deepEqual(refreshed, [])

        const suffix = conn.id.slice(-8)
        const runtimeId = `art_pgtest_${suffix}`
        const agentId = `agt_pgtest_${suffix}`
        await h.db.insert(agentRuntimes).values({
            id: runtimeId,
            userId: h.userId,
            name: `pgtest-runtime-${suffix}`,
            framework: 'claude-code',
            kind: 'sprites'
        })
        await h.db.insert(agents).values({
            id: agentId,
            userId: h.userId,
            name: 'pgtest-agent',
            framework: 'claude-code',
            runtime: 'sprites',
            runtimeId,
            internalId: `internal-${agentId}`,
            extras: { composioConnectionId: conn.id }
        })

        await svc.delete(h.userId, conn.id)
        assert.deepEqual(refreshed, [agentId])
    } finally {
        await h.close()
    }
})
