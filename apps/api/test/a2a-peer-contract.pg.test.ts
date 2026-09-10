import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { readMigrationFiles } from 'drizzle-orm/migrator'
import { ConfigService } from '@nestjs/config'
import { eq } from 'drizzle-orm'
import {
    a2aAgentGrants,
    agentRuntimes,
    agents,
    apiTokens,
    createDb,
    users
} from '@manyfold/db'
import { withScratchDatabase } from '../scripts/scratch-db'
import {
    ApiTokenService,
    hashApiToken
} from '../src/modules/auth/api-token.service'
import { RuntimeTokenService } from '../src/modules/auth/runtime-token.service'
import { CryptoService } from '../src/modules/secrets/crypto.service'

const RUN = process.env.RUN_PG_E2E === '1'
const tag = '0016_a2a_peer_mirror_retirement.contract'
const contract = readFileSync(`drizzle/${tag}.sql`, 'utf8').split(
    '--> statement-breakpoint'
)
type Db = ReturnType<typeof createDb>

const withDatabase = (
    body: (db: Db, apply: () => Promise<void>) => Promise<void>
) =>
    withScratchDatabase(
        'peer_contract',
        async ({ name, url }) => {
            console.log(`A2A contract scratch database: ${name}`)
            const db = createDb(url, {
                max: 2,
                applicationName: 'peer-contract-test'
            })
            try {
                const journal = JSON.parse(
                    readFileSync('drizzle/meta/_journal.json', 'utf8')
                )
                const boundary = journal.entries.find(
                    (entry: { tag: string }) => entry.tag === tag
                ).when
                await db.$client.begin(async (sql) => {
                    for (const migration of readMigrationFiles({
                        migrationsFolder: 'drizzle'
                    })) {
                        if (migration.folderMillis >= boundary) break
                        for (const statement of migration.sql)
                            await sql.unsafe(statement)
                    }
                })
                await db
                    .insert(users)
                    .values({ id: 'owner', email: 'contract@example.test' })
                await db
                    .insert(agentRuntimes)
                    .values({
                        id: 'runtime',
                        userId: 'owner',
                        name: 'contract',
                        framework: 'codex',
                        kind: 'sprites'
                    })
                for (const id of ['caller', 'target'])
                    await db
                        .insert(agents)
                        .values({
                            id,
                            userId: 'owner',
                            runtimeId: 'runtime',
                            framework: 'codex',
                            runtime: 'sprites',
                            internalId: id,
                            name: id
                        })
                await body(db, async () => {
                    await db.$client.begin(async (sql) => {
                        for (const statement of contract)
                            await sql.unsafe(statement)
                    })
                })
            } finally {
                await db.$client.end({ timeout: 5 })
            }
        },
        { migrate: async () => {} }
    )

const seedMirror = async (db: Db) => {
    await db.insert(apiTokens).values({
        id: 'apt_peer',
        userId: 'owner',
        agentId: 'target',
        callerAgentId: 'caller',
        tokenKind: 'a2a-grant',
        tokenHash: hashApiToken('nca_retired_fixture'),
        name: 'peer mirror',
        scopes: ['a2a:edit'],
        createdAt: new Date('2025-01-01')
    })
}

const seedPolicy = async (db: Db) => {
    await db
        .insert(a2aAgentGrants)
        .values({
            id: 'apt_peer',
            userId: 'owner',
            callerAgentId: 'caller',
            targetAgentId: 'target',
            scopes: ['a2a:edit']
        })
}

test(
    'contract removes only peer credential parents and preserves policy, external tokens and identities',
    { skip: !RUN },
    async () => {
        await withDatabase(async (db, apply) => {
            const tokens = new ApiTokenService(db)
            await seedMirror(db)
            await seedPolicy(db)
            const external = await tokens.mintA2aGrant({
                userId: 'owner',
                targetAgentId: 'target'
            })
            const personal = await tokens.mint({
                userId: 'owner',
                name: 'personal'
            })
            const identities = new RuntimeTokenService(
                db,
                new CryptoService(
                    new ConfigService({
                        API_CRYPTO_KEY: Buffer.alloc(32, 7).toString('base64')
                    })
                )
            )
            const identity = await identities.ensureRuntimeIdentity({
                userId: 'owner',
                agentId: 'caller',
                runtimeKind: 'sprites'
            })
            const policy = await db.select().from(a2aAgentGrants)
            await apply()
            const [remaining] = await db.$client`select
            (select count(*)::int from api_tokens where caller_agent_id is not null and token_kind='a2a-grant') as peers,
            (select count(*)::int from token_credentials where token_hash=${hashApiToken('nca_retired_fixture')}) as peer_credentials,
            (select count(*)::int from token_credentials) as credentials,
            (select count(*)::int from pg_trigger where tgname in ('mf_a2a_peer_identity_compat','mf_a2a_peer_revoke_compat')) as bridges`
            assert.deepEqual(remaining, {
                peers: 0,
                peer_credentials: 0,
                credentials: 3,
                bridges: 0
            })
            assert.deepEqual(await db.select().from(a2aAgentGrants), policy)
            assert.equal(
                await tokens.isActiveA2aGrant('caller', 'target'),
                true
            )
            assert.equal(
                await tokens.isActiveExternalA2aGrant(
                    external.tokenId,
                    'target'
                ),
                true
            )
            assert.equal(
                (await tokens.verify(personal.plaintext)).kind,
                'human-api-token'
            )
            assert.equal(
                (await tokens.verify(identity.plaintext)).kind,
                'agent-runtime'
            )
            await apply()
            assert.equal(
                (await tokens.listA2aGrantsForCaller('owner', 'caller'))[0]
                    .tokenId,
                'apt_peer'
            )
            await tokens.revokeA2aGrant({
                tokenId: 'apt_peer',
                userId: 'owner',
                targetAgentId: 'target'
            })
            assert.equal(
                await tokens.isActiveA2aGrant('caller', 'target'),
                false
            )
            assert.equal(
                await tokens.isActiveExternalA2aGrant(
                    external.tokenId,
                    'target'
                ),
                true
            )
        })
    }
)

test(
    'contract refuses unmigrated or recently used credentials without deleting anything',
    { skip: !RUN },
    async () => {
        await withDatabase(async (db, apply) => {
            await seedMirror(db)
            await assert.rejects(apply, /unmigrated peer credential/)
            assert.equal((await db.select().from(apiTokens)).length, 1)
            await seedPolicy(db)
            await db
                .update(apiTokens)
                .set({ lastUsedAt: new Date() })
                .where(eq(apiTokens.id, 'apt_peer'))
            await assert.rejects(apply, /recently used caller-bound credential/)
            assert.equal((await db.select().from(apiTokens)).length, 1)
            await db
                .update(apiTokens)
                .set({ lastUsedAt: new Date('2025-01-01') })
                .where(eq(apiTokens.id, 'apt_peer'))
            await apply()
            assert.equal((await db.select().from(apiTokens)).length, 0)
        })
    }
)
