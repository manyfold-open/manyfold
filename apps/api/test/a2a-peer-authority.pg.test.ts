import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { readFileSync } from 'node:fs'
import { readMigrationFiles } from 'drizzle-orm/migrator'
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
import { ApiTokenService } from '../src/modules/auth/api-token.service'

const RUN = process.env.RUN_PG_E2E === '1'
const tag = '0013_a2a_peer_authority_preparation'
const statements = readFileSync(`drizzle/${tag}.sql`, 'utf8').split(
    '--> statement-breakpoint'
)
const createdAt = new Date('2025-01-01T00:00:00Z')
const revokedAt = new Date('2025-01-03T00:00:00Z')

type Db = ReturnType<typeof createDb>
interface Harness {
    db: Db
    tokens: ApiTokenService
    prepare(): Promise<void>
}

const withHarness = (body: (h: Harness) => Promise<void>): Promise<void> =>
    withScratchDatabase(
        'a2a_authority',
        async ({ name, url }) => {
            console.log(`a2a authority scratch database: ${name}`)
            const db = createDb(url, {
                max: 4,
                applicationName: 'a2a-authority-test'
            })
            try {
                const journal = JSON.parse(
                    readFileSync('drizzle/meta/_journal.json', 'utf8')
                )
                const boundary = journal.entries.find(
                    (entry: { tag: string }) => entry.tag === tag
                ).when
                for (const migration of readMigrationFiles({
                    migrationsFolder: 'drizzle'
                })) {
                    if (migration.folderMillis >= boundary) break
                    for (const statement of migration.sql)
                        await db.$client.unsafe(statement)
                }
                for (const id of ['owner', 'other']) {
                    await db
                        .insert(users)
                        .values({ id, email: `${id}@example.test` })
                    await db.insert(agentRuntimes).values({
                        id: `art_${id}`,
                        userId: id,
                        name: id,
                        kind: 'sprites',
                        framework: 'codex'
                    })
                }
                for (const id of [
                    'live',
                    'revoked',
                    'only',
                    'inverse',
                    'native',
                    'target',
                    'other_target',
                    'foreign'
                ]) {
                    const userId = id === 'foreign' ? 'other' : 'owner'
                    await db.insert(agents).values({
                        id,
                        userId,
                        name: id,
                        runtimeId: `art_${userId}`,
                        framework: 'codex',
                        runtime: 'sprites',
                        internalId: id
                    })
                }
                await body({
                    db,
                    tokens: new ApiTokenService(db),
                    prepare: async () => {
                        await db.$client.begin(async (sql) => {
                            for (const statement of statements)
                                await sql.unsafe(statement)
                        })
                    }
                })
            } finally {
                await db.$client.end({ timeout: 5 })
            }
        },
        { migrate: async () => {} }
    )

const legacy = async (db: Db, caller: string, revoked: Date | null = null) => {
    const id = `apt_${caller}`
    await db.insert(apiTokens).values({
        id,
        userId: 'owner',
        agentId: 'target',
        callerAgentId: caller,
        tokenKind: 'a2a-grant',
        tokenHash: `fixture_hash_${id}`,
        name: caller,
        scopes: ['a2a:edit'],
        createdAt,
        revokedAt: revoked
    })
    return id
}

const policy = async (db: Db, caller: string, revoked: Date | null = null) => {
    await db.insert(a2aAgentGrants).values({
        id: `aag_${caller}`,
        userId: 'owner',
        targetAgentId: 'target',
        callerAgentId: caller,
        scopes: ['a2a:edit'],
        createdAt,
        revokedAt: revoked
    })
}

test(
    'preparation preserves public IDs and honors revocation in either old store',
    { skip: !RUN },
    async () => {
        await withHarness(async (h) => {
            await legacy(h.db, 'live')
            await policy(h.db, 'live')
            await legacy(h.db, 'revoked', revokedAt)
            await policy(h.db, 'revoked')
            await legacy(h.db, 'only')
            await legacy(h.db, 'inverse')
            await policy(h.db, 'inverse', revokedAt)
            await policy(h.db, 'native')
            const external = await h.tokens.mintA2aGrant({
                userId: 'owner',
                targetAgentId: 'target'
            })
            const pat = await h.tokens.mint({
                userId: 'owner',
                name: 'personal'
            })
            await h.prepare()

            assert.equal(
                await h.tokens.isActiveA2aGrant('live', 'target'),
                true
            )
            assert.equal(
                await h.tokens.isActiveA2aGrant('only', 'target'),
                true
            )
            assert.equal(
                await h.tokens.isActiveA2aGrant('native', 'target'),
                true
            )
            assert.equal(
                await h.tokens.isActiveA2aGrant('revoked', 'target'),
                false
            )
            assert.equal(
                await h.tokens.isActiveA2aGrant('inverse', 'target'),
                false
            )
            assert.deepEqual(
                await h.tokens.listActiveA2aGrantTargetsForCaller('revoked'),
                []
            )
            const grants = await h.tokens.listA2aGrants('owner', 'target')
            assert.deepEqual(
                new Set(grants.map((g) => g.tokenId)),
                new Set([
                    'apt_live',
                    'apt_only',
                    'aag_native',
                    external.tokenId
                ])
            )
            assert.equal(
                (await h.tokens.listA2aGrantsForCaller('owner', 'live'))[0]
                    .tokenId,
                'apt_live'
            )
            assert.deepEqual(
                await h.tokens.listA2aGrants('other', 'target'),
                []
            )
            assert.equal(
                await h.tokens.isActiveExternalA2aGrant(
                    external.tokenId,
                    'target'
                ),
                true
            )
            assert.equal(
                await h.tokens.isActiveExternalA2aGrant(
                    external.tokenId,
                    'other_target'
                ),
                false
            )
            assert.equal(
                await h.tokens.isActiveExternalA2aGrant('apt_live', 'target'),
                false
            )
            assert.equal(
                (await h.tokens.verify(pat.plaintext)).kind,
                'human-api-token'
            )
            const [audit] = await h.db
                .$client`select count(*)::int as n from audit_logs where meta->>'reason' = 'a2a-peer-authority-reconciliation'`
            assert.equal(audit.n, 1)
            const before = await h.db
                .select()
                .from(a2aAgentGrants)
                .orderBy(a2aAgentGrants.id)
            await h.prepare()
            assert.deepEqual(
                await h.db
                    .select()
                    .from(a2aAgentGrants)
                    .orderBy(a2aAgentGrants.id),
                before
            )
        })
    }
)

test(
    'old SQL writers receive stable IDs and their generic revokes cannot strand policy',
    { skip: !RUN },
    async () => {
        await withHarness(async (h) => {
            await h.prepare()
            await legacy(h.db, 'live')
            await policy(h.db, 'live')
            assert.equal(
                (await h.db.select().from(a2aAgentGrants))[0].id,
                'apt_live'
            )
            await h.db
                .update(apiTokens)
                .set({ revokedAt })
                .where(eq(apiTokens.id, 'apt_live'))
            assert.equal(
                await h.tokens.isActiveA2aGrant('live', 'target'),
                false
            )

            const [replacement] = await h.tokens.mintA2aGrants({
                userId: 'owner',
                targetAgentId: 'target',
                callerAgentIds: ['live']
            })
            await h.db
                .update(apiTokens)
                .set({ revokedAt: new Date() })
                .where(eq(apiTokens.id, 'apt_live'))
            await h.tokens.revokeA2aGrant({
                tokenId: 'apt_live',
                userId: 'owner',
                targetAgentId: 'target'
            })
            assert.equal(
                await h.tokens.isActiveA2aGrant('live', 'target'),
                true
            )
            assert.equal(
                (await h.tokens.listA2aGrantsForCaller('owner', 'live'))[0]
                    .tokenId,
                replacement.tokenId
            )
        })
    }
)

test(
    'canonical grants own scoped revoke, expiry and replacement despite stale mirrors',
    { skip: !RUN },
    async () => {
        await withHarness(async (h) => {
            await h.prepare()
            const [first] = await h.tokens.mintA2aGrants({
                userId: 'owner',
                targetAgentId: 'target',
                callerAgentIds: ['live']
            })
            await h.tokens.revokeA2aGrant({
                tokenId: first.tokenId,
                userId: 'other',
                targetAgentId: 'target'
            })
            await h.tokens.revokeA2aGrant({
                tokenId: first.tokenId,
                userId: 'owner',
                targetAgentId: 'other_target'
            })
            assert.equal(
                await h.tokens.isActiveA2aGrant('live', 'target'),
                true
            )
            await h.tokens.revoke({ tokenId: first.tokenId, userId: 'owner' })
            assert.equal(
                await h.tokens.isActiveA2aGrant('live', 'target'),
                false
            )
            await h.db
                .update(apiTokens)
                .set({ revokedAt: null })
                .where(eq(apiTokens.id, first.tokenId))
            assert.equal(
                await h.tokens.isActiveA2aGrant('live', 'target'),
                false
            )
            assert.deepEqual(
                await h.tokens.listA2aGrants('owner', 'target'),
                []
            )

            const [second] = await h.tokens.mintA2aGrants({
                userId: 'owner',
                targetAgentId: 'target',
                callerAgentIds: ['live']
            })
            assert.notEqual(second.tokenId, first.tokenId)
            const [, replacements] = await Promise.all([
                h.tokens.revokeA2aGrant({
                    tokenId: second.tokenId,
                    userId: 'owner',
                    targetAgentId: 'target'
                }),
                h.tokens.mintA2aGrants({
                    userId: 'owner',
                    targetAgentId: 'target',
                    callerAgentIds: ['live'],
                    replaceExisting: true
                })
            ])
            assert.equal(
                await h.tokens.isActiveA2aGrant('live', 'target'),
                true
            )
            await h.tokens.revoke({ tokenId: second.tokenId, userId: 'owner' })
            assert.equal(
                await h.tokens.isActiveA2aGrant('live', 'target'),
                true
            )
            await h.db
                .update(a2aAgentGrants)
                .set({ expiresAt: createdAt })
                .where(eq(a2aAgentGrants.id, replacements[0].tokenId))
            assert.equal(
                await h.tokens.isActiveA2aGrant('live', 'target'),
                false
            )
            assert.deepEqual(
                await h.tokens.listActiveA2aGrantTargetsForCaller('live'),
                []
            )

            await policy(h.db, 'native')
            await h.tokens.revoke({ tokenId: 'aag_native', userId: 'owner' })
            assert.equal(
                await h.tokens.isActiveA2aGrant('native', 'target'),
                false
            )
            const [deleted] = await h.tokens.mintA2aGrants({
                userId: 'owner',
                targetAgentId: 'other_target',
                callerAgentIds: ['native']
            })
            await h.tokens.hardDelete({
                tokenId: deleted.tokenId,
                userId: 'owner'
            })
            assert.equal(
                await h.tokens.isActiveA2aGrant('native', 'other_target'),
                false
            )
            await assert.rejects(
                () =>
                    h.tokens.mintA2aGrants({
                        userId: 'owner',
                        targetAgentId: 'target',
                        callerAgentIds: ['foreign']
                    }),
                /caller agent not owned/
            )
            await assert.rejects(
                () =>
                    h.tokens.mintA2aGrant({
                        userId: 'owner',
                        targetAgentId: 'target',
                        callerAgentId: 'live'
                    }),
                /Caller-bound A2A tokens are retired/
            )
        })
    }
)

test(
    'ambiguous policy history and foreign ownership abort preparation without partial repair',
    { skip: !RUN },
    async () => {
        await withHarness(async (h) => {
            await legacy(h.db, 'revoked', revokedAt)
            await policy(h.db, 'revoked')
            await legacy(h.db, 'live')
            await policy(h.db, 'live')
            await h.db
                .update(a2aAgentGrants)
                .set({ expiresAt: new Date('2030-01-01') })
                .where(eq(a2aAgentGrants.id, 'aag_live'))
            await assert.rejects(h.prepare, /conflicting active grant policy/)
            assert.equal(
                (
                    await h.db
                        .select()
                        .from(a2aAgentGrants)
                        .where(eq(a2aAgentGrants.id, 'aag_revoked'))
                )[0].revokedAt,
                null
            )
            await h.db
                .update(a2aAgentGrants)
                .set({ expiresAt: null })
                .where(eq(a2aAgentGrants.id, 'aag_live'))
            await legacy(h.db, 'inverse', revokedAt)
            await policy(h.db, 'inverse')
            await h.db
                .update(a2aAgentGrants)
                .set({ expiresAt: new Date('2030-01-01') })
                .where(eq(a2aAgentGrants.id, 'aag_inverse'))
            await assert.rejects(h.prepare, /conflicting revoked grant history/)
            assert.equal(
                (
                    await h.db
                        .select()
                        .from(a2aAgentGrants)
                        .where(eq(a2aAgentGrants.id, 'aag_revoked'))
                )[0].revokedAt,
                null
            )
            const [audit] = await h.db
                .$client`select count(*)::int as n from audit_logs where meta->>'reason' = 'a2a-peer-authority-reconciliation'`
            assert.equal(
                audit.n,
                0,
                'the earlier repair and its audit roll back together'
            )
            await h.db
                .update(a2aAgentGrants)
                .set({ expiresAt: null })
                .where(eq(a2aAgentGrants.id, 'aag_inverse'))
            await policy(h.db, 'foreign')
            await assert.rejects(h.prepare, /inconsistent grant ownership/)
        })
    }
)
