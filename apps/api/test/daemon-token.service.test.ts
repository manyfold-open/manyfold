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
    hostId: string | null
    name: string
    tokenHash: string
    lastUsedAt: Date | null
    expiresAt: Date | null
    revokedAt: Date | null
    createdAt: Date
}

// Predicates are opaque SQL objects, so the fake operates on every row it
// holds and each test sets up exactly the rows the call site should see. The
// one predicate that matters — `host_id IS NULL` on deleteUnbound — is
// modelled explicitly, since it is the property under test.
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
    delete(_tbl: unknown) {
        return new FakeQuery(this, 'delete')
    }
}

class FakeQuery {
    private setVals: Partial<Row> | null = null
    constructor(
        private readonly db: FakeDb,
        private readonly op: 'select' | 'insert' | 'update' | 'delete'
    ) {}
    from(_tbl: unknown) {
        return this
    }
    values(v: Partial<Row>) {
        this.db.rows.push({
            id: v.id!,
            userId: v.userId!,
            hostId: v.hostId ?? null,
            name: v.name!,
            tokenHash: v.tokenHash!,
            lastUsedAt: null,
            expiresAt: v.expiresAt ?? null,
            revokedAt: null,
            createdAt: v.createdAt ?? new Date()
        })
        return Promise.resolve()
    }
    set(v: Partial<Row>) {
        this.setVals = v
        return this
    }
    where(_cond: unknown) {
        if (this.op === 'update' && this.setVals) {
            for (const r of this.db.rows) Object.assign(r, this.setVals)
            const rows = this.db.rows.slice()
            return Object.assign(Promise.resolve(rows), {
                returning: async () => rows
            })
        }
        if (this.op === 'delete') {
            const unbound = this.db.rows.filter((r) => r.hostId === null)
            this.db.rows = this.db.rows.filter((r) => r.hostId !== null)
            return { returning: async () => unbound.map((r) => ({ id: r.id })) }
        }
        return this
    }
    limit(_n: number) {
        return Promise.resolve(this.db.rows.slice())
    }
}

test('mint returns an ldt_-prefixed token, unbound by default', async () => {
    const db = new FakeDb()
    const svc = new DaemonTokenService(db as unknown as Database)
    const minted = await svc.mint({ userId: 'u1', name: 'laptop' })
    assert.match(minted.plaintext, /^ldt_[A-Za-z0-9_-]+$/)
    assert.equal(db.rows.length, 1)
    assert.equal(db.rows[0].tokenHash, hashToken(minted.plaintext))
    assert.equal(db.rows[0].userId, 'u1')
    assert.equal(db.rows[0].hostId, null)
    assert.equal(minted.hostId, null)
})

test('verify round-trips a freshly minted token with its binding', async () => {
    const db = new FakeDb()
    const svc = new DaemonTokenService(db as unknown as Database)
    const minted = await svc.mint({ userId: 'u1', name: 'laptop' })
    const auth = await svc.verify(minted.plaintext)
    assert.equal(auth.userId, 'u1')
    assert.equal(auth.tokenId, minted.tokenId)
    assert.equal(auth.hostId, null)
    assert.ok(db.rows[0].lastUsedAt instanceof Date)
})

// The whole trust boundary (ADR-0037 R5): only provisioning code passes a
// host, and the register path trusts the binding, never anything the
// daemon says. A request-shaped mint carries no host whatever its name.
test('only an explicit mint argument binds a token to a host', async () => {
    const userDb = new FakeDb()
    await new DaemonTokenService(userDb as unknown as Database).mint({
        userId: 'u1',
        name: 'daemon:sbx_abc'
    })
    assert.equal(userDb.rows[0].hostId, null)

    const hostedDb = new FakeDb()
    const svc = new DaemonTokenService(hostedDb as unknown as Database)
    const bound = await svc.mint({
        userId: 'u1',
        name: 'daemon:sbx_abc',
        hostId: 'sbx_abc'
    })
    assert.equal(bound.hostId, 'sbx_abc')
    assert.equal((await svc.verify(bound.plaintext)).hostId, 'sbx_abc')
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

// A bound token authenticates every websocket connect its daemon makes;
// deleting one because a register LOOKED failed would brick a live daemon.
test('deleteUnbound never removes a token bound to a host', async () => {
    const db = new FakeDb()
    const svc = new DaemonTokenService(db as unknown as Database)
    const bound = await svc.mint({ userId: 'u1', name: 'a', hostId: 'h1' })
    assert.equal(
        await svc.deleteUnbound({ tokenId: bound.tokenId, userId: 'u1' }),
        false
    )
    assert.equal(db.rows.length, 1)

    const loose = new FakeDb()
    const loosely = new DaemonTokenService(loose as unknown as Database)
    const unbound = await loosely.mint({ userId: 'u1', name: 'b' })
    assert.equal(
        await loosely.deleteUnbound({ tokenId: unbound.tokenId, userId: 'u1' }),
        true
    )
    assert.equal(loose.rows.length, 0)
})

test('revoke reports the host the token was bound to', async () => {
    const db = new FakeDb()
    const svc = new DaemonTokenService(db as unknown as Database)
    const minted = await svc.mint({ userId: 'u1', name: 'a', hostId: 'h1' })
    assert.equal(
        await svc.revoke({ tokenId: minted.tokenId, userId: 'u1' }),
        'h1'
    )
    assert.ok(db.rows[0].revokedAt instanceof Date)
})
