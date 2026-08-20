import test from 'node:test'
import assert from 'node:assert/strict'
import { tokenCredentials, type Database } from '@manyfold/db'
import { ApiTokenService } from '../src/modules/auth/api-token.service'

interface TokenRow {
    id: string
    userId: string
    tokenHash: string
}

const collectParams = (cond: unknown): unknown[] => {
    const out: unknown[] = []
    const seen = new WeakSet<object>()
    const walk = (node: unknown): void => {
        if (node === null || typeof node !== 'object') return
        if (seen.has(node as object)) return
        seen.add(node as object)
        const rec = node as Record<string, unknown>
        if ('value' in rec && typeof rec.value !== 'object') out.push(rec.value)
        for (const key of Object.keys(rec)) walk(rec[key])
    }
    walk(cond)
    return out
}

// Minimal fake: models api_tokens rows + the token_credentials delete, and
// simulates the FK cascade (deleting a credential drops its api_tokens row) so
// the test asserts end-state, not just the issued statement.
class FakeDb {
    tokenRows: TokenRow[] = []
    deletedHashes: string[] = []

    select(_shape?: unknown) {
        return new FakeSelect(this)
    }
    delete(table: unknown) {
        return new FakeDelete(this, table)
    }
    transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
        return fn(this)
    }
}

class FakeSelect {
    private params: unknown[] = []
    constructor(private readonly db: FakeDb) {}
    from(_table: unknown) {
        return this
    }
    where(cond: unknown) {
        this.params = collectParams(cond)
        return this
    }
    limit(_n: number): Promise<Array<{ tokenHash: string }>> {
        const row = this.db.tokenRows.find(
            (r) => this.params.includes(r.id) && this.params.includes(r.userId)
        )
        return Promise.resolve(row ? [{ tokenHash: row.tokenHash }] : [])
    }
}

class FakeDelete {
    constructor(
        private readonly db: FakeDb,
        private readonly table: unknown
    ) {}
    where(cond: unknown): Promise<unknown[]> {
        if (this.table === tokenCredentials) {
            const hash = collectParams(cond).find(
                (p): p is string => typeof p === 'string'
            )
            if (hash) {
                this.db.deletedHashes.push(hash)
                this.db.tokenRows = this.db.tokenRows.filter(
                    (r) => r.tokenHash !== hash
                )
            }
        }
        return Promise.resolve([])
    }
}

const newSvc = () => {
    const db = new FakeDb()
    const svc = new ApiTokenService(db as unknown as Database)
    return { db, svc }
}

test('hardDelete drops the owner token by deleting its credential hash (cascade)', async () => {
    const { db, svc } = newSvc()
    db.tokenRows.push({ id: 'tok_1', userId: 'user-1', tokenHash: 'h1' })

    await svc.hardDelete({ tokenId: 'tok_1', userId: 'user-1' })

    assert.deepEqual(db.deletedHashes, ['h1'])
    assert.equal(db.tokenRows.length, 0)
})

test('hardDelete is a no-op for a token the user does not own', async () => {
    const { db, svc } = newSvc()
    db.tokenRows.push({ id: 'tok_1', userId: 'user-1', tokenHash: 'h1' })

    await svc.hardDelete({ tokenId: 'tok_1', userId: 'user-2' })

    assert.deepEqual(db.deletedHashes, [])
    assert.equal(db.tokenRows.length, 1)
})
