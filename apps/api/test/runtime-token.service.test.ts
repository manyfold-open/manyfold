import assert from 'node:assert/strict'
import test from 'node:test'
import {
    agentRuntimeTokens,
    tokenCredentials,
    type Database
} from '@manyfold/db'
import { RuntimeTokenService } from '../src/modules/auth/runtime-token.service'

class RtFakeDb {
    credentials: Record<string, unknown>[] = []
    runtimeTokens: Record<string, unknown>[] = []
    revoked: unknown[] = []
    selectRows: Record<string, unknown>[] = []
    transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
        return fn(this)
    }
    insert(table: unknown) {
        return new RtQuery(this, table)
    }
    update(table: unknown) {
        return new RtQuery(this, table, true)
    }
    select() {
        return new RtSelectQuery(this)
    }
    execute() {
        return Promise.resolve()
    }
}

class RtSelectQuery {
    constructor(private readonly db: RtFakeDb) {}
    from() {
        return this
    }
    where() {
        return this
    }
    limit() {
        return Promise.resolve(this.db.selectRows)
    }
}

class RtQuery {
    constructor(
        private readonly db: RtFakeDb,
        private readonly table: unknown,
        private readonly isUpdate = false
    ) {}
    set() {
        return this
    }
    where() {
        if (this.isUpdate) this.db.revoked.push(this.table)
        return Promise.resolve()
    }
    values(value: Record<string, unknown>) {
        if (this.table === tokenCredentials) this.db.credentials.push(value)
        if (this.table === agentRuntimeTokens) this.db.runtimeTokens.push(value)
        return Promise.resolve()
    }
}

test('mintRuntimeIdentity writes a runtime credential + identity row and revokes any prior', async () => {
    const db = new RtFakeDb()
    const crypto = {
        encrypt: (plain: string) => ({
            ciphertext: `enc:${plain}`,
            keyVersion: 7
        })
    }
    const svc = new RuntimeTokenService(
        db as unknown as Database,
        crypto as never
    )

    const minted = await svc.mintRuntimeIdentity({
        userId: 'user-1',
        agentId: 'agt_A',
        runtimeKind: 'sprites'
    })

    // identity token carries the distinct runtime prefix, no scopes
    assert.ok(minted.plaintext.startsWith('nca_rt_'))
    assert.equal(minted.agentId, 'agt_A')
    assert.equal(minted.runtimeKind, 'sprites')

    // parent credential is kind=runtime and shares the child's hash
    assert.equal(db.credentials.length, 1)
    assert.equal(db.credentials[0].kind, 'runtime')
    assert.equal(db.runtimeTokens.length, 1)
    assert.equal(db.runtimeTokens[0].runtimeKind, 'sprites')
    assert.equal(db.runtimeTokens[0].agentId, 'agt_A')
    assert.equal(db.runtimeTokens[0].userId, 'user-1')
    assert.equal(db.credentials[0].tokenHash, db.runtimeTokens[0].tokenHash)

    // encrypted copy of the plaintext is stored for per-exec identity injection
    assert.equal(db.runtimeTokens[0].tokenCiphertext, `enc:${minted.plaintext}`)
    assert.equal(db.runtimeTokens[0].tokenKeyVersion, 7)

    // prior active row for (agent, kind) is revoked first (partial-unique safety)
    assert.deepEqual(db.revoked, [agentRuntimeTokens])
})

test('ensureRuntimeIdentity does not rotate an already encrypted identity', async () => {
    const db = new RtFakeDb()
    db.selectRows = [{ tokenCiphertext: 'enc:existing', tokenKeyVersion: 7 }]
    const crypto = {
        encrypt: (plain: string) => ({
            ciphertext: `enc:${plain}`,
            keyVersion: 7
        }),
        decrypt: () => 'nca_rt_existing'
    }
    const svc = new RuntimeTokenService(
        db as unknown as Database,
        crypto as never
    )

    const result = await svc.ensureRuntimeIdentity({
        userId: 'user-1',
        agentId: 'agt_A',
        runtimeKind: 'sprites'
    })

    assert.deepEqual(result, { created: false, plaintext: 'nca_rt_existing' })
    assert.equal(db.credentials.length, 0)
    assert.equal(db.runtimeTokens.length, 0)
    assert.equal(db.revoked.length, 0)
})

// The pod's read-through. A pod runs on the identity its Secret was
// provisioned with, so the one thing this path may never do is rotate an
// active row it cannot decrypt — that revokes the token inside the pod.
test('readOrMintRuntimeIdentity returns an encrypted active identity without rotating', async () => {
    const db = new RtFakeDb()
    db.selectRows = [
        {
            id: 'art_tok_1',
            tokenCiphertext: 'enc:mfr_active',
            tokenKeyVersion: 1
        }
    ]
    const svc = new RuntimeTokenService(
        db as unknown as Database,
        {
            encrypt: () => ({ ciphertext: 'enc:new', keyVersion: 1 }),
            decrypt: ({ ciphertext }: { ciphertext: string }) =>
                ciphertext.replace(/^enc:/, '')
        } as never
    )
    const plaintext = await svc.readOrMintRuntimeIdentity({
        userId: 'user_1',
        agentId: 'agt_1',
        runtimeKind: 'k8s'
    })
    assert.equal(plaintext, 'mfr_active')
    assert.equal(db.revoked.length, 0, 'nothing revoked')
    assert.equal(db.runtimeTokens.length, 0, 'nothing minted')
})

test('readOrMintRuntimeIdentity leaves an undecryptable active identity alone', async () => {
    // A legacy row with no ciphertext. ensureRuntimeIdentity would mint a
    // replacement here and revoke this one — and this one is the plaintext the
    // pod Secret carries. The honest answer is "no per-exec token"; the daemon
    // inherits the Secret's.
    const db = new RtFakeDb()
    db.selectRows = [
        { id: 'art_tok_legacy', tokenCiphertext: null, tokenKeyVersion: null }
    ]
    const svc = new RuntimeTokenService(
        db as unknown as Database,
        {
            encrypt: () => ({ ciphertext: 'enc:new', keyVersion: 1 }),
            decrypt: () => {
                throw new Error('must not decrypt a row with no ciphertext')
            }
        } as never
    )
    const plaintext = await svc.readOrMintRuntimeIdentity({
        userId: 'user_1',
        agentId: 'agt_1',
        runtimeKind: 'k8s'
    })
    assert.equal(plaintext, null)
    assert.equal(db.revoked.length, 0, 'the active row must survive')
    assert.equal(db.runtimeTokens.length, 0, 'no replacement minted')
})

test('readOrMintRuntimeIdentity mints only when no active identity exists', async () => {
    // A purchased container is provisioned before any agent exists, so the
    // agent attached to it later has no k8s identity at all until first use.
    const db = new RtFakeDb()
    db.selectRows = []
    const svc = new RuntimeTokenService(
        db as unknown as Database,
        {
            encrypt: () => ({ ciphertext: 'enc:new', keyVersion: 1 }),
            decrypt: () => 'unused'
        } as never
    )
    const plaintext = await svc.readOrMintRuntimeIdentity({
        userId: 'user_1',
        agentId: 'agt_1',
        runtimeKind: 'k8s'
    })
    assert.equal(typeof plaintext, 'string')
    assert.ok((plaintext ?? '').length > 20, 'a freshly minted token')
    assert.equal(db.runtimeTokens.length, 1)
    assert.equal(db.runtimeTokens[0].runtimeKind, 'k8s')
})
