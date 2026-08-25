import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import { ConflictException } from '@nestjs/common'
import { agents } from '@manyfold/db'
import type { AuthenticationState, WASocket } from 'baileys'
import type { Database, WhatsappRegistrationRow } from '@manyfold/db'
import type { ConfigService } from '@nestjs/config'
import type { CryptoService } from '../src/modules/secrets/crypto.service'
import type { RuntimeAccessService } from '../src/modules/runtime-access/runtime-access.service'
import type { ChannelsService } from '../src/modules/channels/channels.service'
import type { ChannelsRepository } from '../src/modules/channels/channels.repository'
import {
    WhatsappRegistrationService,
    normalizeSelfJid
} from '../src/modules/channels/whatsapp-registration.service'
import { deserializeWhatsappAuth } from '../src/modules/channels/providers/whatsapp-baileys'

// Single-row in-memory stand-in for the drizzle query builder, matching the
// shape the weixin registration suite uses: where-clauses are ignored and the
// tests drive row state directly.
class FakeDb {
    row: WhatsappRegistrationRow | null = null
    agentOwned = true
    pendingCount = 0
    deleted: WhatsappRegistrationRow[] = []

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
            this.db.row = {
                status: 'pending',
                refreshCount: 0,
                qrContent: null,
                holderId: null,
                errorCode: null,
                errorMessage: null,
                channelId: null,
                createdAt: now,
                updatedAt: now,
                ...(this.valuesInput ?? {})
            } as WhatsappRegistrationRow
            return Promise.resolve([{ ...this.db.row }])
        }
        if (this.op === 'update') {
            if (!this.db.row) return Promise.resolve([])
            this.db.row = {
                ...this.db.row,
                ...this.patch
            } as WhatsappRegistrationRow
            return Promise.resolve([{ ...this.db.row }])
        }
        if (this.op === 'delete') {
            const row = this.db.row
            if (!row) return Promise.resolve([])
            this.db.deleted.push(row)
            this.db.row = null
            return Promise.resolve([{ id: row.id }])
        }
        return Promise.resolve([])
    }
}

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

const fakeConfig = { get: () => 'test-holder' } as unknown as ConfigService

// A Baileys socket stub: only the event surface plus end() the service uses.
class FakeSocket extends EventEmitter {
    ended = false
    ev = {
        on: (event: string, handler: (...args: unknown[]) => void): void => {
            this.on(event, handler)
        }
    }
    end(): void {
        this.ended = true
    }
    emitUpdate(update: Record<string, unknown>): void {
        this.emit('connection.update', update)
    }
}

interface Harness {
    svc: WhatsappRegistrationService
    db: FakeDb
    sockets: FakeSocket[]
    states: AuthenticationState[]
    created: Array<Record<string, unknown>>
    updated: Array<Record<string, unknown>>
    providerStates: Array<Record<string, unknown>>
}

const makeHarness = (
    opts: {
        onCreate?: (body: Record<string, unknown>) => Promise<{ id: string }>
    } = {}
): Harness => {
    const db = new FakeDb()
    const sockets: FakeSocket[] = []
    const states: AuthenticationState[] = []
    const created: Array<Record<string, unknown>> = []
    const updated: Array<Record<string, unknown>> = []
    const providerStates: Array<Record<string, unknown>> = []

    const channels = {
        create: async (
            _userId: string,
            body: Record<string, unknown>,
            optsArg: Record<string, unknown>
        ) => {
            created.push({ ...body, ...optsArg })
            if (opts.onCreate) return opts.onCreate(body)
            return { id: 'chn_1' }
        },
        update: async (
            _userId: string,
            id: string,
            body: Record<string, unknown>
        ) => {
            updated.push({ id, ...body })
            return { id }
        }
    } as unknown as ChannelsService

    const repo = {
        upsertProviderState: async (row: Record<string, unknown>) => {
            providerStates.push(row)
            return row
        }
    } as unknown as ChannelsRepository

    class TestService extends WhatsappRegistrationService {
        protected createPairingSocket(
            state: AuthenticationState
        ): Promise<WASocket> {
            states.push(state)
            const socket = new FakeSocket()
            sockets.push(socket)
            return Promise.resolve(socket as unknown as WASocket)
        }
    }

    const svc = new TestService(
        db as unknown as Database,
        fakeCrypto,
        fakeRuntimeAccess,
        channels,
        repo,
        fakeConfig
    )
    return { svc, db, sockets, states, created, updated, providerStates }
}

const owner = { userId: 'user-1' }

const startPending = async (h: Harness) => {
    const summary = await h.svc.start('user-1', {
        agentId: 'agt_1',
        label: 'wa'
    })
    return summary
}

// Drives the socket to the state WhatsApp leaves it in after a successful
// scan: creds carry the linked identity, then the connection closes with 515.
const completeScan = async (
    h: Harness,
    socketIndex = 0,
    me = { id: '15550001111:12@s.whatsapp.net', name: 'Agent' }
): Promise<void> => {
    const state = h.states[socketIndex]
    Object.assign(state.creds, { me, registered: true })
    await state.keys.set({
        session: { s1: { data: new Uint8Array([7, 7]) } }
    } as never)
    h.sockets[socketIndex].emitUpdate({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 515 } } }
    })
    // The handler runs in a floating promise; yield until it settles.
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
    await new Promise((resolve) => setImmediate(resolve))
}

test('start refuses an agent the caller does not own', async () => {
    const h = makeHarness()
    h.db.agentOwned = false
    await assert.rejects(startPending(h), /agent not found/)
    assert.equal(h.sockets.length, 0)
})

test('start refuses once too many registrations are already pending', async () => {
    const h = makeHarness()
    h.db.pendingCount = 3
    await assert.rejects(startPending(h), ConflictException)
    // No socket may be opened when the guard trips, or the cap would leak
    // WhatsApp connections.
    assert.equal(h.sockets.length, 0)
})

test('start opens exactly one pairing socket and reports pending', async () => {
    const h = makeHarness()
    const summary = await startPending(h)
    assert.equal(summary.status, 'pending')
    assert.equal(summary.qrContent, null)
    assert.equal(h.sockets.length, 1)
    h.svc.onModuleDestroy()
})

test('QR rotations land on the row so the client polls a live code', async () => {
    const h = makeHarness()
    await startPending(h)
    h.sockets[0].emitUpdate({ qr: 'QR-CODE-1' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal((await h.svc.get(owner, h.db.row!.id)).qrContent, 'QR-CODE-1')

    h.sockets[0].emitUpdate({ qr: 'QR-CODE-2' })
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal((await h.svc.get(owner, h.db.row!.id)).qrContent, 'QR-CODE-2')
    h.svc.onModuleDestroy()
})

test('an unscanned socket close reopens a new one, up to the refresh cap', async () => {
    const h = makeHarness()
    await startPending(h)
    for (let attempt = 1; attempt <= 3; attempt += 1) {
        h.sockets[h.sockets.length - 1].emitUpdate({
            connection: 'close',
            lastDisconnect: { error: { output: { statusCode: 428 } } }
        })
        for (let i = 0; i < 20; i += 1) await Promise.resolve()
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(h.db.row?.refreshCount, attempt)
        assert.equal(h.sockets.length, attempt + 1)
    }
    // Cap reached: the next close expires the registration instead of opening
    // a fifth socket that nobody is waiting on.
    h.sockets[h.sockets.length - 1].emitUpdate({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 428 } } }
    })
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.db.row?.status, 'expired')
    assert.equal(h.sockets.length, 4)
})

test('a successful scan creates the channel, stores auth, then activates', async () => {
    const h = makeHarness()
    await startPending(h)
    await completeScan(h)

    assert.equal(h.db.row?.status, 'succeeded')
    assert.equal(h.db.row?.channelId, 'chn_1')
    assert.equal(h.db.row?.qrContent, null)

    assert.equal(h.created.length, 1)
    const create = h.created[0]
    // The device suffix must be stripped, or the same phone could be bound
    // twice past the (provider, external_id) unique index.
    assert.equal(create.externalId, '15550001111@s.whatsapp.net')
    assert.equal(create.provider, 'whatsapp')
    assert.equal(create.credentials, null)
    assert.equal(
        (create.config as { botJid: string }).botJid,
        '15550001111@s.whatsapp.net'
    )
    assert.equal((create.config as { mentionOnly: boolean }).mentionOnly, true)

    // Auth has to be durable before the channel goes active, or the manager
    // starts a socket with no session to resume.
    assert.equal(h.providerStates.length, 1)
    assert.deepEqual(h.updated, [{ id: 'chn_1', status: 'active' }])

    const stored = h.providerStates[0].stateJson as {
        authCiphertext: string
        botJid: string
    }
    const snapshot = await deserializeWhatsappAuth(
        Buffer.from(stored.authCiphertext, 'base64').toString('utf8')
    )
    assert.equal(snapshot.creds.me?.id, '15550001111:12@s.whatsapp.net')
    // The Signal keys collected during pairing must travel with the creds;
    // without them the resumed socket cannot decrypt anything.
    assert.ok(snapshot.keys.session.s1)
})

test('a scan whose channel is already bound reports already_bound', async () => {
    const h = makeHarness({
        onCreate: async () => {
            throw new ConflictException({
                code: 'external_account_already_bound',
                message: 'taken'
            })
        }
    })
    await startPending(h)
    await completeScan(h)
    assert.equal(h.db.row?.status, 'failed')
    assert.equal(h.db.row?.errorCode, 'already_bound')
    // Nothing may be activated when the binding was refused.
    assert.equal(h.updated.length, 0)
})

test('any other create failure reports channel_create_failed', async () => {
    const h = makeHarness({
        onCreate: async () => {
            throw new Error('database unreachable')
        }
    })
    await startPending(h)
    await completeScan(h)
    assert.equal(h.db.row?.status, 'failed')
    assert.equal(h.db.row?.errorCode, 'channel_create_failed')
    assert.equal(h.db.row?.errorMessage, 'database unreachable')
})

test('a close before any scan never creates a channel', async () => {
    const h = makeHarness()
    await startPending(h)
    h.sockets[0].emitUpdate({
        connection: 'close',
        lastDisconnect: { error: { output: { statusCode: 401 } } }
    })
    for (let i = 0; i < 20; i += 1) await Promise.resolve()
    await new Promise((resolve) => setImmediate(resolve))
    assert.equal(h.created.length, 0)
    assert.equal(h.db.row?.status, 'pending')
    h.svc.onModuleDestroy()
})

test('an expired pending registration flips to expired on read', async () => {
    const h = makeHarness()
    await startPending(h)
    h.db.row = {
        ...h.db.row!,
        expiresAt: new Date(Date.now() - 1000)
    }
    const summary = await h.svc.get(owner, h.db.row.id)
    assert.equal(summary.status, 'expired')
    assert.equal(summary.qrContent, null)
    // The socket nobody is waiting on must be released with the row.
    assert.equal(h.sockets[0].ended, true)
})

test('cancel closes the pairing socket and marks the row cancelled', async () => {
    const h = makeHarness()
    await startPending(h)
    await h.svc.cancel(owner, h.db.row!.id)
    assert.equal(h.db.row?.status, 'cancelled')
    assert.equal(h.db.row?.qrContent, null)
    assert.equal(h.sockets[0].ended, true)
})

test('cancel is a no-op once the registration already succeeded', async () => {
    const h = makeHarness()
    await startPending(h)
    await completeScan(h)
    await h.svc.cancel(owner, h.db.row!.id)
    assert.equal(h.db.row?.status, 'succeeded')
})

// Owner scoping itself lives in the query's where clause, which this fake
// ignores; the agent binding is the part enforced in code and asserted here.
test('a token bound to another agent cannot read this registration', async () => {
    const h = makeHarness()
    await startPending(h)
    await assert.rejects(
        h.svc.get({ userId: 'user-1', boundAgentId: 'agt_other' }, h.db.row!.id),
        /another agent/
    )
    h.svc.onModuleDestroy()
})

test('cleanup deletes rows past retention and releases their sockets', async () => {
    const h = makeHarness()
    await startPending(h)
    const deleted = await h.svc.cleanupExpiredRegistrations()
    assert.equal(deleted, 1)
    assert.equal(h.sockets[0].ended, true)
})

test('normalizeSelfJid strips the device suffix but keeps the domain', () => {
    assert.equal(
        normalizeSelfJid('15550001111:12@s.whatsapp.net'),
        '15550001111@s.whatsapp.net'
    )
    assert.equal(
        normalizeSelfJid('15550001111@s.whatsapp.net'),
        '15550001111@s.whatsapp.net'
    )
    assert.equal(normalizeSelfJid('15550001111'), '15550001111')
})
