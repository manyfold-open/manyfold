import assert from 'node:assert/strict'
import test from 'node:test'
import { ConflictException } from '@nestjs/common'
import { agents } from '@manyfold/db'
import type { Database, WeixinRegistrationRow } from '@manyfold/db'
import type { CryptoService } from '../src/modules/secrets/crypto.service'
import type { RuntimeAccessService } from '../src/modules/runtime-access/runtime-access.service'
import type { ChannelsService } from '../src/modules/channels/channels.service'
import { WeixinRegistrationService } from '../src/modules/channels/weixin-registration.service'

// A single-row in-memory stand-in for the drizzle query builder. It ignores
// where-clauses (tests drive the row status directly), which is enough to
// exercise the poll state machine and verify-code handling.
class FakeDb {
    row: WeixinRegistrationRow | null = null
    agentOwned = true
    pendingCount = 0

    select(shape?: Record<string, unknown>) {
        return new FakeQuery(this, 'select', undefined, shape)
    }
    insert(table: unknown) {
        return new FakeQuery(this, 'insert', table)
    }
    update(table: unknown) {
        return new FakeQuery(this, 'update', table)
    }
    delete(table: unknown) {
        return new FakeQuery(this, 'delete', table)
    }
}

class FakeQuery {
    private table: unknown
    private valuesInput: Record<string, unknown> | null = null
    private patch: Record<string, unknown> = {}

    constructor(
        private readonly db: FakeDb,
        private readonly op: 'select' | 'insert' | 'update' | 'delete',
        table?: unknown,
        private readonly shape?: Record<string, unknown>
    ) {
        this.table = table
    }
    from(table: unknown) {
        this.table = table
        return this
    }
    values(v: Record<string, unknown>) {
        this.valuesInput = v
        return this
    }
    set(p: Record<string, unknown>) {
        this.patch = p
        return this
    }
    where() {
        return this
    }
    limit(): Promise<unknown[]> {
        if (this.table === agents)
            return Promise.resolve(this.db.agentOwned ? [{ id: 'agt_1' }] : [])
        return Promise.resolve(this.db.row ? [{ ...this.db.row }] : [])
    }
    returning(): Promise<unknown[]> {
        return this.execute()
    }
    then<T = unknown[]>(
        onfulfilled?: ((value: unknown[]) => T | PromiseLike<T>) | null
    ): Promise<T> {
        return this.execute().then(onfulfilled ?? undefined) as Promise<T>
    }
    private execute(): Promise<unknown[]> {
        if (this.op === 'select' && this.shape && 'value' in this.shape)
            return Promise.resolve([{ value: this.db.pendingCount }])
        if (this.op === 'insert') {
            const now = new Date()
            const v = this.valuesInput ?? {}
            this.db.row = {
                status: 'pending',
                refreshCount: 0,
                lastPolledAt: null,
                verifyCodeCiphertext: null,
                verifyKeyVersion: null,
                errorCode: null,
                errorMessage: null,
                channelId: null,
                createdAt: now,
                updatedAt: now,
                ...v
            } as WeixinRegistrationRow
            return Promise.resolve([{ ...this.db.row }])
        }
        if (this.op === 'update') {
            if (!this.db.row) return Promise.resolve([])
            this.db.row = { ...this.db.row, ...this.patch } as WeixinRegistrationRow
            return Promise.resolve([{ ...this.db.row }])
        }
        return Promise.resolve([])
    }
}

// base64 round-trip stand-in for CryptoService.
const fakeCrypto = {
    encrypt: (plain: string) => ({
        ciphertext: Buffer.from(plain, 'utf8').toString('base64'),
        keyVersion: 1
    }),
    decrypt: (v: { ciphertext: string }) =>
        Buffer.from(v.ciphertext, 'base64').toString('utf8')
} as unknown as CryptoService

const fakeRuntimeAccess = {
    reserveChannelSlot: async () => undefined
} as unknown as RuntimeAccessService

const jsonResponse = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    })

const makeService = (
    db: FakeDb,
    channels: Partial<ChannelsService> = {}
): WeixinRegistrationService =>
    new WeixinRegistrationService(
        db as unknown as Database,
        fakeCrypto,
        fakeRuntimeAccess,
        channels as ChannelsService
    )

const seedPending = (db: FakeDb, over: Partial<WeixinRegistrationRow> = {}) => {
    const now = new Date()
    db.row = {
        id: 'wxr_1',
        userId: 'user-1',
        agentId: 'agt_1',
        label: 'wx',
        status: 'pending',
        qrcodeCiphertext: fakeCrypto.encrypt('qr-handle-1').ciphertext,
        keyVersion: 1,
        qrcodeContent: 'https://liteapp.weixin.qq.com/q/abc',
        pollBaseUrl: 'https://ilinkai.weixin.qq.com',
        verifyCodeCiphertext: null,
        verifyKeyVersion: null,
        refreshCount: 0,
        lastPolledAt: null,
        errorCode: null,
        errorMessage: null,
        channelId: null,
        expiresAt: new Date(now.getTime() + 5 * 60_000),
        createdAt: now,
        updatedAt: now,
        ...over
    } as WeixinRegistrationRow
}

const owner = { userId: 'user-1' }

test('weixin start fetches a QR and stores an encrypted handle', async (t) => {
    const db = new FakeDb()
    const originalFetch = globalThis.fetch
    t.after(() => {
        globalThis.fetch = originalFetch
    })
    globalThis.fetch = (async () =>
        jsonResponse({
            qrcode: 'secret-handle',
            qrcode_img_content: 'https://liteapp.weixin.qq.com/q/xyz'
        })) as typeof fetch

    const svc = makeService(db)
    const summary = await svc.start(owner.userId, {
        agentId: 'agt_1',
        label: 'my wechat'
    })
    assert.equal(summary.status, 'pending')
    assert.equal(summary.qrcodeContent, 'https://liteapp.weixin.qq.com/q/xyz')
    // The polling handle is encrypted, never the raw value.
    assert.notEqual(db.row?.qrcodeCiphertext, 'secret-handle')
    assert.equal(
        fakeCrypto.decrypt({
            ciphertext: db.row!.qrcodeCiphertext,
            keyVersion: 1
        }),
        'secret-handle'
    )
})

test('weixin start rejects when too many pending', async () => {
    const db = new FakeDb()
    db.pendingCount = 3
    const svc = makeService(db)
    await assert.rejects(
        svc.start(owner.userId, { agentId: 'agt_1', label: 'x' }),
        (err: unknown) => err instanceof ConflictException
    )
})

test('weixin getAndAdvance: need_verifycode parks for input', async (t) => {
    const db = new FakeDb()
    seedPending(db)
    const originalFetch = globalThis.fetch
    t.after(() => {
        globalThis.fetch = originalFetch
    })
    globalThis.fetch = (async () =>
        jsonResponse({ status: 'need_verifycode' })) as typeof fetch

    const svc = makeService(db)
    const summary = await svc.getAndAdvance(owner, 'wxr_1')
    assert.equal(summary.status, 'need_verify_code')
    // QR still shown while awaiting the code.
    assert.ok(summary.qrcodeContent)
})

test('weixin submitVerifyCode stores encrypted code and resumes polling', async () => {
    const db = new FakeDb()
    seedPending(db, { status: 'need_verify_code' })
    const svc = makeService(db)
    const summary = await svc.submitVerifyCode(owner, 'wxr_1', '  4821  ')
    assert.equal(summary.status, 'pending')
    assert.equal(db.row?.lastPolledAt, null)
    assert.ok(db.row?.verifyCodeCiphertext)
    // Stored encrypted (trimmed), not the raw typed value.
    assert.equal(
        fakeCrypto.decrypt({
            ciphertext: db.row!.verifyCodeCiphertext!,
            keyVersion: db.row!.verifyKeyVersion!
        }),
        '4821'
    )
})

test('weixin scaned_but_redirect switches the polling host', async (t) => {
    const db = new FakeDb()
    seedPending(db)
    const originalFetch = globalThis.fetch
    t.after(() => {
        globalThis.fetch = originalFetch
    })
    globalThis.fetch = (async () =>
        jsonResponse({
            status: 'scaned_but_redirect',
            redirect_host: 'idc2.ilinkai.weixin.qq.com'
        })) as typeof fetch

    const svc = makeService(db)
    const summary = await svc.getAndAdvance(owner, 'wxr_1')
    assert.equal(summary.status, 'pending')
    assert.equal(db.row?.pollBaseUrl, 'https://idc2.ilinkai.weixin.qq.com')
})

test('weixin confirmed creates a channel with externalId and marks succeeded', async (t) => {
    const db = new FakeDb()
    seedPending(db)
    const originalFetch = globalThis.fetch
    t.after(() => {
        globalThis.fetch = originalFetch
    })
    globalThis.fetch = (async () =>
        jsonResponse({
            status: 'confirmed',
            bot_token: 'bot-token-abc',
            ilink_bot_id: '05f361@im.bot',
            ilink_user_id: 'wxid_owner@im.wechat',
            baseurl: 'https://ilinkai.weixin.qq.com'
        })) as typeof fetch

    let createArgs: unknown
    const channels = {
        create: async (
            _userId: string,
            body: unknown,
            opts?: { externalId?: string }
        ) => {
            createArgs = { body, opts }
            return { id: 'chn_new' } as never
        }
    }
    const svc = makeService(db, channels)
    const summary = await svc.getAndAdvance(owner, 'wxr_1')
    assert.equal(summary.status, 'succeeded')
    assert.equal(summary.channelId, 'chn_new')
    const { body, opts } = createArgs as {
        body: { provider: string; config: { operatorUserIds: string[] } }
        opts: { externalId: string }
    }
    assert.equal(body.provider, 'weixin')
    assert.equal(opts.externalId, '05f361@im.bot')
    // The scanning user seeds the operator/allow lists.
    assert.deepEqual(body.config.operatorUserIds, ['wxid_owner@im.wechat'])
})

test('weixin confirmed maps a duplicate-bot conflict to already_bound', async (t) => {
    const db = new FakeDb()
    seedPending(db)
    const originalFetch = globalThis.fetch
    t.after(() => {
        globalThis.fetch = originalFetch
    })
    globalThis.fetch = (async () =>
        jsonResponse({
            status: 'confirmed',
            bot_token: 'bot-token-abc',
            ilink_bot_id: '05f361@im.bot'
        })) as typeof fetch

    const channels = {
        create: async () => {
            throw new ConflictException({
                code: 'external_account_already_bound',
                message: 'already bound'
            })
        }
    }
    const svc = makeService(db, channels)
    const summary = await svc.getAndAdvance(owner, 'wxr_1')
    assert.equal(summary.status, 'failed')
    assert.equal(summary.errorCode, 'already_bound')
})

test('weixin getAndAdvance rejects a registration owned by another user', async () => {
    const db = new FakeDb()
    seedPending(db, { userId: 'someone-else' })
    // loadOwned filters by userId in the real query; emulate a miss.
    db.row = null
    const svc = makeService(db)
    await assert.rejects(svc.getAndAdvance(owner, 'wxr_1'), /not found/)
})
