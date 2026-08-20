import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { ConfigService } from '@nestjs/config'
import { createDb, userConnections, users, type Database } from '@manyfold/db'
import { ConnectionsService } from '../src/modules/connections/connections.service'
import { CryptoService } from '../src/modules/secrets/crypto.service'

// Real-Postgres proof that an agent's linked connections resolve into the
// agent-facing summaries + usage hints the /agent-self/connections endpoint and
// AGENTS.manyfold.md both render from. Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
const RUN = process.env.RUN_PG_E2E === '1'
const TEST_CRYPTO_KEY = Buffer.alloc(32, 9).toString('base64')

const makeService = (db: Database): ConnectionsService =>
    new ConnectionsService(
        db,
        new CryptoService(new ConfigService({ API_CRYPTO_KEY: TEST_CRYPTO_KEY })),
        {} as never,
        {} as never,
        {} as never,
        { get: () => ({ refreshOnChange: async () => {} }) } as never
    )

interface Harness {
    db: Database
    userId: string
    githubId: string
    composioId: string
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(8).toString('hex')
    const userId = `user_pgtest_${suffix}`
    const githubId = `ucn_gh_${suffix}`
    const composioId = `ucn_cx_${suffix}`
    await db
        .insert(users)
        .values({ id: userId, email: `${suffix}@pgtest.local` })
    await db.insert(userConnections).values([
        {
            id: githubId,
            userId,
            provider: 'github',
            kind: 'github_app_installation',
            displayName: 'acme',
            externalId: '12345',
            secretCiphertext: null,
            keyVersion: 1,
            metadata: { accountName: 'acme', accountType: 'Organization' }
        },
        {
            id: composioId,
            userId,
            provider: 'composio',
            kind: 'composio_consumer_key',
            displayName: 'Composio',
            externalId: 'f'.repeat(64),
            secretCiphertext: 'ignored',
            keyVersion: 1,
            metadata: null
        }
    ])
    return {
        db,
        userId,
        githubId,
        composioId,
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, userId))
        }
    }
}

test('resolveAgentConnections maps linked refs to account + usage hints', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const svc = makeService(h.db)
        const infos = await svc.resolveAgentConnections({
            userId: h.userId,
            extras: {
                githubConnectionId: h.githubId,
                composioConnectionId: h.composioId
            }
        })
        assert.equal(infos.length, 2)
        const gh = infos.find((i) => i.provider === 'github')
        assert.equal(gh?.account, 'acme')
        assert.match(gh?.usage ?? '', /git and gh are authenticated/)
        const cx = infos.find((i) => i.provider === 'composio')
        assert.equal(cx?.account, null)
        assert.match(cx?.usage ?? '', /Composio Connect is linked/)
    } finally {
        await h.close()
    }
})

test('resolveAgentConnections skips missing/unlinked refs', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const svc = makeService(h.db)
        assert.deepEqual(
            await svc.resolveAgentConnections({ userId: h.userId, extras: {} }),
            []
        )
        // A ref that points at a non-existent connection is dropped, not thrown.
        const infos = await svc.resolveAgentConnections({
            userId: h.userId,
            extras: { githubConnectionId: 'ucn_missing' }
        })
        assert.deepEqual(infos, [])
    } finally {
        await h.close()
    }
})
