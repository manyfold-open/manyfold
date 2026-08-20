import assert from 'node:assert/strict'
import test from 'node:test'
import { PgDialect } from 'drizzle-orm/pg-core'
import {
    ChatRepository,
    ORPHANED_ASSISTANT_MESSAGE_GRACE_MS
} from '../src/modules/chat/chat.repository'

test('bootstrap orphan reconciliation only selects assistant messages older than the grace window', async () => {
    const now = new Date('2026-06-12T13:20:35.000Z')
    const query = await captureOrphanWhereQuery(now)

    assert.match(
        query.sql,
        /"chat_messages"\."created_at" < \$2/,
        'a newly started API machine must not terminalize a fresh assistant turn owned by another live machine'
    )
    assert.equal(
        query.params[1],
        new Date(
            now.getTime() - ORPHANED_ASSISTANT_MESSAGE_GRACE_MS
        ).toISOString(),
        'the default orphan cutoff must stay at the explicit bootstrap grace window, not at process start time or zero'
    )
})

const captureOrphanWhereQuery = async (
    now: Date
): Promise<{ sql: string; params: unknown[] }> => {
    let selectCalls = 0
    let whereExpr: unknown
    const subquery = {
        from: () => ({
            where: () => ({
                getSQL: () => ({ queryChunks: [] })
            })
        })
    }
    const mainQuery = {
        from: () => ({
            leftJoin: () => ({
                where: (expr: unknown) => {
                    whereExpr = expr
                    return { groupBy: async () => [] }
                }
            })
        })
    }
    const db = {
        select: () => {
            selectCalls += 1
            return selectCalls === 1 ? mainQuery : subquery
        }
    }

    await new ChatRepository(db as never).listOrphanedAssistantMessages({ now })

    assert.ok(whereExpr, 'expected listOrphanedAssistantMessages to build a where clause')
    return new PgDialect().sqlToQuery(whereExpr as never)
}
