import assert from 'node:assert/strict'
import test from 'node:test'
import {
    buildProviderRequest,
    formatMessage,
    larkSign
} from '../src/modules/notifications/notification-formatters'
import { NotificationsService } from '../src/modules/notifications/notifications.service'

type Row = Record<string, unknown>

const parseBody = (init: RequestInit | undefined): Record<string, unknown> =>
    JSON.parse(String(init?.body ?? '{}'))

// ---- pure formatters ----

test('formatMessage renders English copy per event', () => {
    assert.match(
        formatMessage('user.registered', { email: 'a@b.com' }),
        /New user registered: a@b\.com/
    )
    assert.match(
        formatMessage('subscription.activated', {
            planId: 'pro',
            userId: 'usr_1'
        }),
        /Subscription activated: pro \(user usr_1\)/
    )
    assert.match(
        formatMessage('payment.credited', {
            creditedAmount: 12.5,
            userId: 'usr_1'
        }),
        /Top-up credited: \$12\.50/
    )
})

test('buildProviderRequest shapes each provider payload', () => {
    const slack = buildProviderRequest(
        'slack',
        { webhookUrl: 'https://s' },
        'hi',
        1000
    )
    assert.equal(slack.url, 'https://s')
    assert.deepEqual(parseBody(slack.init), { text: 'hi' })

    const discord = buildProviderRequest(
        'discord',
        { webhookUrl: 'https://d' },
        'hi',
        1000
    )
    assert.equal(discord.url, 'https://d')
    assert.deepEqual(parseBody(discord.init), { content: 'hi' })

    const tg = buildProviderRequest(
        'telegram',
        { botToken: '42:ABC', chatId: '-100' },
        'hi',
        1000
    )
    assert.equal(tg.url, 'https://api.telegram.org/bot42:ABC/sendMessage')
    assert.deepEqual(parseBody(tg.init), { chat_id: '-100', text: 'hi' })
})

test('lark request signs only when a secret is configured', () => {
    const plain = buildProviderRequest(
        'lark',
        { webhookUrl: 'https://l' },
        'hi',
        5000
    )
    const plainBody = parseBody(plain.init)
    assert.equal(plainBody.msg_type, 'text')
    assert.deepEqual(plainBody.content, { text: 'hi' })
    assert.equal('sign' in plainBody, false)

    const signed = buildProviderRequest(
        'lark',
        { webhookUrl: 'https://l', secret: 's3cr3t' },
        'hi',
        5000
    )
    const signedBody = parseBody(signed.init)
    assert.equal(signedBody.timestamp, '5')
    assert.equal(signedBody.sign, larkSign('5', 's3cr3t'))
})

// ---- dispatcher targeting + fault isolation ----

class FakeDb {
    readonly updates: Array<{ set: Row }> = []

    constructor(private readonly rows: Row[]) {}

    select() {
        return {
            from: () => ({
                where: () => {
                    const rows = this.rows
                    const p = Promise.resolve(rows) as Promise<Row[]> & {
                        limit: (n: number) => Promise<Row[]>
                    }
                    p.limit = async () => rows
                    return p
                }
            })
        }
    }

    update() {
        return {
            set: (set: Row) => ({
                where: async () => {
                    this.updates.push({ set })
                }
            })
        }
    }
}

const fakeCrypto = {
    decrypt: ({ ciphertext }: { ciphertext: string }) => ciphertext,
    encrypt: (plain: string) => ({ ciphertext: plain, keyVersion: 1 })
} as never

const webhookRow = (
    id: string,
    events: string[],
    webhookUrl: string
): Row => ({
    id,
    provider: 'slack',
    label: id,
    enabled: true,
    events,
    configCiphertext: JSON.stringify({ webhookUrl }),
    keyVersion: 1
})

const runDispatch = (
    service: NotificationsService,
    eventKey: string,
    payload: Row,
    handler: (url: string) => { ok: boolean; status: number }
): Promise<string[]> => {
    const urls: string[] = []
    const original = globalThis.fetch
    globalThis.fetch = (async (url: string): Promise<unknown> => {
        urls.push(String(url))
        const r = handler(String(url))
        return { ok: r.ok, status: r.status, text: async () => '' }
    }) as never
    const run = (
        service as unknown as {
            run: (k: string, p: Row) => Promise<void>
        }
    ).run.bind(service)
    return run(eventKey, payload)
        .then(() => urls)
        .finally(() => {
            globalThis.fetch = original
        })
}

test('dispatch delivers only to webhooks subscribed to the event', async () => {
    const db = new FakeDb([
        webhookRow('nwh_1', ['user.registered'], 'https://a'),
        webhookRow('nwh_2', ['payment.credited'], 'https://b')
    ])
    const service = new NotificationsService(db as never, fakeCrypto)

    const urls = await runDispatch(
        service,
        'user.registered',
        { email: 'a@b.com' },
        () => ({ ok: true, status: 200 })
    )

    assert.deepEqual(urls, ['https://a'])
    assert.equal(db.updates.length, 1)
    assert.ok(db.updates[0].set.lastDeliveryAt instanceof Date)
})

test('dispatch isolates a failing webhook from its siblings', async () => {
    const db = new FakeDb([
        webhookRow('nwh_1', ['user.registered'], 'https://fail'),
        webhookRow('nwh_2', ['user.registered'], 'https://ok')
    ])
    const service = new NotificationsService(db as never, fakeCrypto)

    // run resolving (not rejecting) is itself the fault-isolation assertion.
    const urls = await runDispatch(
        service,
        'user.registered',
        { email: 'a@b.com' },
        (url) => {
            if (url.includes('fail')) throw new Error('boom')
            return { ok: true, status: 200 }
        }
    )

    assert.equal(urls.length, 2)
    const errored = db.updates.filter(
        (u) => typeof u.set.lastErrorMessage === 'string'
    )
    const delivered = db.updates.filter(
        (u) => u.set.lastDeliveryAt instanceof Date
    )
    assert.equal(errored.length, 1)
    assert.equal(delivered.length, 1)
})

test('dispatch never throws at the call site even if the query fails', () => {
    const brokenDb = {
        select() {
            throw new Error('db down')
        }
    }
    const service = new NotificationsService(brokenDb as never, fakeCrypto)
    assert.doesNotThrow(() =>
        service.dispatch('user.registered', { email: 'a@b.com' })
    )
})