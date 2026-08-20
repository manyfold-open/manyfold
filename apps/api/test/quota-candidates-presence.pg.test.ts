import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes } from 'node:crypto'
import test from 'node:test'
import { inArray } from 'drizzle-orm'
import { createDb, userApiUsageDays, users, userSessions } from '@manyfold/db'
import { SpriteStatusSyncService } from '@/modules/agents/sprite-status/sprite-status-sync.service'

// #615: quota warnings are SSE-only and unpersisted, so the candidate UNION in
// usersForQuotaEvaluation only admits users with a live session used inside
// the presence window — anyone else can't receive the event and evaluating
// them burns their 24h dedupe stamp. The EXISTS semantics (recent vs stale vs
// revoked vs expired vs absent session) are real SQL a fake can't honestly
// model. Env-gated like the other *.pg.test.ts:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     pnpm --filter @manyfold/api test
// against a migrated DB (`just db-migrate`).
const RUN = process.env.RUN_PG_E2E === '1'

test(
    'quota candidates require a live recently-used session (#615)',
    { skip: !RUN },
    async () => {
        const url = process.env.DATABASE_URL
        assert.ok(url, 'DATABASE_URL must be set')
        const db = createDb(url)
        const suffix = randomBytes(8).toString('hex')
        const uid = (name: string) => `user_pgtest_${name}_${suffix}`
        const seeded = [
            uid('recent'),
            uid('stale'),
            uid('revoked'),
            uid('expired'),
            uid('nosession')
        ]
        const now = Date.now()
        const day = new Date().toISOString().slice(0, 10)
        try {
            await db.insert(users).values(
                seeded.map((id) => ({ id, email: `${id}@example.com` }))
            )
            // Every seeded user is a UNION candidate via the api-usage arm —
            // the lightest arm to seed (no FK chain beyond users).
            await db.insert(userApiUsageDays).values(
                seeded.map((userId) => ({ userId, day, requestCount: 1 }))
            )
            const session = (
                name: string,
                overrides: Partial<typeof userSessions.$inferInsert>
            ): typeof userSessions.$inferInsert => ({
                id: `uss_pgtest_${name}_${suffix}`,
                userId: uid(name),
                tokenHash: `hash_${name}_${suffix}`,
                provider: 'email',
                subject: uid(name),
                lastUsedAt: new Date(now - 60_000),
                expiresAt: new Date(now + 86_400_000),
                ...overrides
            })
            await db.insert(userSessions).values([
                session('recent', {}),
                // Outside the 15-minute presence window.
                session('stale', { lastUsedAt: new Date(now - 16 * 60_000) }),
                session('revoked', { revokedAt: new Date(now - 30_000) }),
                session('expired', { expiresAt: new Date(now - 30_000) })
            ])

            // usersForQuotaEvaluation only touches this.db; the other deps are
            // never reached.
            const svc = new SpriteStatusSyncService(
                db as never,
                {} as never,
                {} as never,
                {} as never,
                {} as never,
                {} as never,
                {} as never,
                {} as never,
                {} as never,
                {} as never
            )
            const candidates = (await (
                svc['usersForQuotaEvaluation' as never] as () => Promise<
                    string[]
                >
            ).call(svc)) as string[]
            const mine = new Set(candidates.filter((c) => seeded.includes(c)))

            assert.deepEqual(
                [...mine],
                [uid('recent')],
                'only the user with a live recently-used session qualifies'
            )
        } finally {
            await db.delete(users).where(inArray(users.id, seeded))
            const client = (
                db as unknown as { $client?: { end?: () => Promise<void> } }
            ).$client
            if (client?.end) await client.end()
        }
    }
)
