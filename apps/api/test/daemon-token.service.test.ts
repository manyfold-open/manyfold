import test from 'node:test'
import assert from 'node:assert/strict'
import {
    DaemonTokenService,
    hashToken
} from '../src/modules/daemon/daemon-token.service'
import type { Database } from '@manyfold/db'

interface Row {
    id: string
    userId: string
    daemonId: string | null
    name: string
    purpose: 'user' | 'sprite_runner'
    tokenHash: string
    lastUsedAt: Date | null
    expiresAt: Date | null
    revokedAt: Date | null
    createdAt: Date
}

class FakeDb {
    rows: Row[] = []

    select() {
        return new FakeQuery(this, 'select')
    }
    insert(_tbl: unknown) {
        return new FakeQuery(this, 'insert')
    }
    update(_tbl: unknown) {
        return new FakeQuery(this, 'update')
    }
}

class FakeQuery {
    private op: 'select' | 'insert' | 'update'
    private setVals: Partial<Row> | null = null
    constructor(
        private readonly db: FakeDb,
        op: 'select' | 'insert' | 'update'
    ) {
        this.op = op
    }
    from(_tbl: unknown) {
        return this
    }
    values(v: Partial<Row>) {
        const row: Row = {
            id: v.id!,
            userId: v.userId!,
            daemonId: v.daemonId ?? null,
            name: v.name!,
            purpose: v.purpose ?? 'user',
            tokenHash: v.tokenHash!,
            lastUsedAt: null,
            expiresAt: v.expiresAt ?? null,
            revokedAt: null,
            createdAt: v.createdAt ?? new Date()
        }
        this.db.rows.push(row)
        return Promise.resolve()
    }
    set(v: Partial<Row>) {
        this.setVals = v
        return this
    }
    where(_cond: unknown) {
        // Drizzle's eq() returns an opaque SQL object. We side-step
        // predicate matching by relying on the fact that
        // DaemonTokenService only ever queries/updates by tokenHash or id,
        // and our test files set up a DB containing exactly the row(s)
        // intended for the call site. The fake just operates on all rows.
        if (this.op === 'update' && this.setVals) {
            for (const r of this.db.rows) Object.assign(r, this.setVals)
            return Promise.resolve()
        }
        return this
    }
    limit(_n: number) {
        return Promise.resolve(this.db.rows.slice())
    }
}

test('mint returns ldt_-prefixed token and persists hashed copy', async () => {
    const db = new FakeDb()
    const svc = new DaemonTokenService(db as unknown as Database)
    const minted = await svc.mint({ userId: 'u1', name: 'laptop' })
    assert.match(minted.plaintext, /^ldt_[A-Za-z0-9_-]+$/)
    assert.equal(db.rows.length, 1)
    assert.equal(db.rows[0].tokenHash, hashToken(minted.plaintext))
    assert.equal(db.rows[0].userId, 'u1')
    assert.equal(db.rows[0].daemonId, null)
})

test('verify round-trips a freshly minted token', async () => {
    const db = new FakeDb()
    const svc = new DaemonTokenService(db as unknown as Database)
    const minted = await svc.mint({ userId: 'u1', name: 'laptop' })
    const auth = await svc.verify(minted.plaintext)
    assert.equal(auth.userId, 'u1')
    assert.equal(auth.daemonId, null)
    // The claim the register path reads to decide quota exemption. A token
    // nobody asked a purpose for is an ordinary user token.
    assert.equal(auth.purpose, 'user')
})

test('only an explicit mint argument can carry a non-user purpose', async () => {
    // What POST /api/daemon/tokens does — name comes from the request body and
    // is the only thing the user controls, so a runner-shaped name buys nothing.
    const userDb = new FakeDb()
    await new DaemonTokenService(userDb as unknown as Database).mint({
        userId: 'u1',
        name: 'sprite-runner:art-abc'
    })
    assert.equal(userDb.rows[0].purpose, 'user')

    // The fake resolves any lookup to the single row it holds, so the platform
    // mint gets its own db.
    const runnerDb = new FakeDb()
    const svc = new DaemonTokenService(runnerDb as unknown as Database)
    const runner = await svc.mint({
        userId: 'u1',
        name: 'sprite-runner:art-abc',
        purpose: 'sprite_runner'
    })
    assert.equal((await svc.verify(runner.plaintext)).purpose, 'sprite_runner')
})

test('verify rejects malformed prefix', async () => {
    const db = new FakeDb()
    const svc = new DaemonTokenService(db as unknown as Database)
    await assert.rejects(
        () => svc.verify('xxx_garbage'),
        /invalid token prefix/
    )
})

test('verify rejects revoked token', async () => {
    const db = new FakeDb()
    const svc = new DaemonTokenService(db as unknown as Database)
    const minted = await svc.mint({ userId: 'u1', name: 'laptop' })
    db.rows[0].revokedAt = new Date()
    await assert.rejects(() => svc.verify(minted.plaintext), /token revoked/)
})

test('verify rejects expired token', async () => {
    const db = new FakeDb()
    const svc = new DaemonTokenService(db as unknown as Database)
    const minted = await svc.mint({ userId: 'u1', name: 'laptop' })
    db.rows[0].expiresAt = new Date(Date.now() - 1000)
    await assert.rejects(() => svc.verify(minted.plaintext), /token expired/)
})
