import assert from 'node:assert/strict'
import test from 'node:test'
import { a2aAgentGrants, apiTokens, type Database } from '@manyfold/db'
import { ApiTokenService } from '../src/modules/auth/api-token.service'

// Fake that serves rows by table identity and ignores WHERE (the SQL filters
// are covered by the real-PG check; these tests pin the dual-source combine
// logic: OR for isActiveA2aGrant, union+dedup for the targets list).
class A2aFakeDb {
    apiRows: Record<string, unknown>[] = []
    freshRows: Record<string, unknown>[] = []
    select(_shape?: unknown) {
        return new A2aQuery(this)
    }
}

class A2aQuery {
    private table: unknown
    constructor(private readonly db: A2aFakeDb) {}
    from(table: unknown) {
        this.table = table
        return this
    }
    where() {
        return this
    }
    limit() {
        return Promise.resolve(this.rows())
    }
    then<T = unknown[]>(
        onfulfilled?: ((value: unknown[]) => T | PromiseLike<T>) | null
    ): Promise<T> {
        return Promise.resolve(this.rows()).then(onfulfilled)
    }
    private rows(): Record<string, unknown>[] {
        if (this.table === apiTokens) return this.db.apiRows
        if (this.table === a2aAgentGrants) return this.db.freshRows
        return []
    }
}

const svcWith = (db: A2aFakeDb) =>
    new ApiTokenService(db as unknown as Database)

test('isActiveA2aGrant honors a grant present only in a2a_agent_grants', async () => {
    const db = new A2aFakeDb()
    db.freshRows = [{ id: 'a2g_1' }]
    assert.equal(await svcWith(db).isActiveA2aGrant('agt_c', 'agt_t'), true)
})

test('isActiveA2aGrant honors a legacy api_tokens grant', async () => {
    const db = new A2aFakeDb()
    db.apiRows = [{ id: 'pat_1' }]
    assert.equal(await svcWith(db).isActiveA2aGrant('agt_c', 'agt_t'), true)
})

test('isActiveA2aGrant is false when neither table has a grant', async () => {
    const db = new A2aFakeDb()
    assert.equal(await svcWith(db).isActiveA2aGrant('agt_c', 'agt_t'), false)
})

test('listActiveA2aGrantTargetsForCaller unions both tables and dedups', async () => {
    const db = new A2aFakeDb()
    db.apiRows = [{ userId: 'u1', targetAgentId: 'agt_t1' }]
    db.freshRows = [
        { userId: 'u1', targetAgentId: 'agt_t1' },
        { userId: 'u1', targetAgentId: 'agt_t2' }
    ]
    const targets =
        await svcWith(db).listActiveA2aGrantTargetsForCaller('agt_c')
    assert.deepEqual(
        targets.sort((a, b) => a.targetAgentId.localeCompare(b.targetAgentId)),
        [
            { userId: 'u1', targetAgentId: 'agt_t1' },
            { userId: 'u1', targetAgentId: 'agt_t2' }
        ]
    )
})

class A2aRevokeFakeDb {
    row:
        | {
              id: string
              callerAgentId: string | null
          }
        | undefined
    updates: Array<{ table: unknown; patch: Record<string, unknown> }> = []

    transaction<T>(fn: (tx: A2aRevokeFakeDb) => Promise<T>): Promise<T> {
        return fn(this)
    }

    select() {
        return {
            from: () => ({
                where: () => ({
                    limit: async () => (this.row ? [this.row] : [])
                })
            })
        }
    }

    update(table: unknown) {
        return {
            set: (patch: Record<string, unknown>) => ({
                where: async () => {
                    this.updates.push({ table, patch })
                }
            })
        }
    }

    insert() {
        return { values: async () => {} }
    }
}

test('revokeA2aGrant revokes both grant stores for a peer caller', async () => {
    const db = new A2aRevokeFakeDb()
    db.row = {
        id: 'pat_peer',
        callerAgentId: 'agt_c'
    }
    await new ApiTokenService(db as unknown as Database).revokeA2aGrant({
        tokenId: 'pat_peer',
        userId: 'u1',
        targetAgentId: 'agt_t'
    })

    assert.deepEqual(
        db.updates.map((update) => update.table),
        [apiTokens, a2aAgentGrants]
    )
    assert.ok(db.updates[0].patch.revokedAt instanceof Date)
    assert.equal(db.updates[0].patch.revokedAt, db.updates[1].patch.revokedAt)
})

test('revokeA2aGrant does not mutate anything when the scoped row is absent', async () => {
    const db = new A2aRevokeFakeDb()
    await new ApiTokenService(db as unknown as Database).revokeA2aGrant({
        tokenId: 'pat_other',
        userId: 'u1',
        targetAgentId: 'agt_t'
    })
    assert.deepEqual(db.updates, [])
})
