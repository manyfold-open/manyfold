import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { BadGatewayException, NotFoundException } from '@nestjs/common'
import { ConfigService } from '@nestjs/config'
import { createDb, userConnections, users, type Database } from '@manyfold/db'
import type { CloudflareResources } from '../src/modules/connections/cloudflare.service'
import { ConnectionsService } from '../src/modules/connections/connections.service'
import { CryptoService } from '../src/modules/secrets/crypto.service'

// Real-Postgres proof of the per-connection resource proxies: GitHub repos ride
// the stored installation id + connection metadata, Cloudflare gets the
// DECRYPTED token (never the ciphertext) plus the stored account id, Composio
// gets the decrypted consumer key, ownership is enforced via findActive (404),
// and upstream failures surface as 502 — not 500s or silent empties. Env-gated
// like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
const RUN = process.env.RUN_PG_E2E === '1'
const TEST_CRYPTO_KEY = Buffer.alloc(32, 9).toString('base64')

interface ProviderMocks {
    github?: unknown
    cloudflare?: unknown
    composio?: unknown
}

const makeService = (db: Database, mocks: ProviderMocks): ConnectionsService => {
    const crypto = new CryptoService(
        new ConfigService({ API_CRYPTO_KEY: TEST_CRYPTO_KEY })
    )
    const moduleRef = { get: () => ({ refreshOnChange: async () => {} }) }
    return new ConnectionsService(
        db,
        crypto,
        (mocks.cloudflare ?? {}) as never,
        (mocks.composio ?? {}) as never,
        (mocks.github ?? {}) as never,
        moduleRef as never
    )
}

interface Harness {
    db: Database
    userId: string
    suffix: string
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
        suffix,
        close: async (): Promise<void> => {
            await db.delete(users).where(eq(users.id, userId))
        }
    }
}

const insertGithubConnection = async (h: Harness): Promise<string> => {
    const id = `ucn_pgtest_${h.suffix}`
    await h.db.insert(userConnections).values({
        id,
        userId: h.userId,
        provider: 'github',
        kind: 'github_app_installation',
        displayName: 'octo-org',
        externalId: '12345678',
        secretCiphertext: null,
        keyVersion: 1,
        metadata: {
            accountName: 'octo-org',
            accountType: 'Organization',
            repositorySelection: 'selected'
        }
    })
    return id
}

test('githubRepos lists via the stored installation id and keeps the stored selection', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const seen: string[] = []
        const svc = makeService(h.db, {
            github: {
                listInstallationRepos: async (installationId: string) => {
                    seen.push(installationId)
                    return {
                        totalCount: 1,
                        repos: [
                            {
                                name: 'demo',
                                fullName: 'octo-org/demo',
                                private: true,
                                htmlUrl: 'https://github.com/octo-org/demo',
                                defaultBranch: 'main',
                                pushedAt: null
                            }
                        ]
                    }
                }
            }
        })
        const id = await insertGithubConnection(h)
        const res = await svc.githubRepos(h.userId, id)
        assert.deepEqual(seen, ['12345678'])
        assert.equal(res.repositorySelection, 'selected')
        assert.equal(res.totalCount, 1)
        assert.equal(res.repos[0].fullName, 'octo-org/demo')

        await assert.rejects(
            () => svc.githubRepos(h.userId, 'ucn_does_not_exist'),
            NotFoundException
        )
    } finally {
        await h.close()
    }
})

test('githubRepos surfaces an upstream failure as 502', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const svc = makeService(h.db, {
            github: {
                listInstallationRepos: async () => {
                    throw new Error('github installation repos list failed: 500')
                }
            }
        })
        const id = await insertGithubConnection(h)
        await assert.rejects(
            () => svc.githubRepos(h.userId, id),
            BadGatewayException
        )
    } finally {
        await h.close()
    }
})

test('cloudflareResources decrypts the token and passes sections through', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const seen: { token: string; accountId: string }[] = []
        const resources: CloudflareResources = {
            tokenStatus: 'active',
            workers: {
                status: 'ok',
                items: [{ name: 'edge-fn', modifiedOn: null }]
            },
            pages: { status: 'forbidden' }
        }
        const svc = makeService(h.db, {
            cloudflare: {
                verifyAndListAccounts: async () => ({
                    valid: true,
                    accounts: [{ id: 'acc-1', name: 'Acme' }]
                }),
                listResources: async (token: string, accountId: string) => {
                    seen.push({ token, accountId })
                    return resources
                }
            }
        })
        const created = await svc.createCloudflare(h.userId, {
            token: 'cf_plain_token'
        })
        assert.equal(created.status, 'created')
        if (created.status !== 'created') return
        const res = await svc.cloudflareResources(
            h.userId,
            created.connection.id
        )
        assert.deepEqual(seen, [{ token: 'cf_plain_token', accountId: 'acc-1' }])
        assert.equal(res.tokenStatus, 'active')
        assert.equal(res.accountId, 'acc-1')
        assert.equal(res.accountName, 'Acme')
        assert.deepEqual(res.workers, resources.workers)
        assert.deepEqual(res.pages, { status: 'forbidden' })

        await assert.rejects(
            () => svc.cloudflareResources(h.userId, 'ucn_does_not_exist'),
            NotFoundException
        )
    } finally {
        await h.close()
    }
})

test('composioTools uses the decrypted key and maps upstream failure to 502', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const seen: string[] = []
        let fail = false
        const svc = makeService(h.db, {
            composio: {
                verifyKey: async () => ({ valid: true }),
                listTools: async (apiKey: string) => {
                    if (fail) throw new Error('composio mcp call failed: 500')
                    seen.push(apiKey)
                    return [{ name: 'GMAIL_SEND_EMAIL', description: null }]
                }
            }
        })
        const conn = await svc.createComposio(h.userId, {
            apiKey: 'ak_tools_key'
        })
        const res = await svc.composioTools(h.userId, conn.id)
        assert.deepEqual(seen, ['ak_tools_key'])
        assert.deepEqual(res.tools, [
            { name: 'GMAIL_SEND_EMAIL', description: null }
        ])

        fail = true
        await assert.rejects(
            () => svc.composioTools(h.userId, conn.id),
            BadGatewayException
        )
        // A github/cloudflare id never reaches composio: wrong provider → 404.
        const ghId = await insertGithubConnection(h)
        await assert.rejects(
            () => svc.composioTools(h.userId, ghId),
            NotFoundException
        )
    } finally {
        await h.close()
    }
})
