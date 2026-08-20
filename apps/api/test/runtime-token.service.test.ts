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
    transaction<T>(fn: (tx: this) => Promise<T>): Promise<T> {
        return fn(this)
    }
    insert(table: unknown) {
        return new RtQuery(this, table)
    }
    update(table: unknown) {
        return new RtQuery(this, table, true)
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
    assert.equal(
        db.runtimeTokens[0].tokenCiphertext,
        `enc:${minted.plaintext}`
    )
    assert.equal(db.runtimeTokens[0].tokenKeyVersion, 7)

    // prior active row for (agent, kind) is revoked first (partial-unique safety)
    assert.deepEqual(db.revoked, [agentRuntimeTokens])
})
