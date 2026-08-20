import assert from 'node:assert/strict'
import test from 'node:test'
import { agents, larkAppRegistrations } from '@manyfold/db'
import type { Database, LarkAppRegistrationRow } from '@manyfold/db'
import { CliAuthRateLimitService } from '../src/modules/auth/cli-auth-rate-limit.service'
import { LarkRegistrationService } from '../src/modules/channels/lark-registration.service'

class FakeDb {
    rows: LarkAppRegistrationRow[] = []
    agentOwned = true
    pendingCount: number | null = null
    failNextPollLock = false
    failNextCreateLock = false

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
    private result: unknown[] | null = null

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

    values(value: Record<string, unknown>) {
        this.valuesInput = value
        return this
    }

    set(value: Record<string, unknown>) {
        this.patch = value
        return this
    }

    where(_condition: unknown) {
        return this
    }

    limit(_limit: number): Promise<unknown[]> {
        if (this.table === agents)
            return Promise.resolve(this.db.agentOwned ? [{ id: 'agt_1' }] : [])
        if (this.table === larkAppRegistrations) {
            if (this.shape && 'value' in this.shape) {
                const pending =
                    this.db.pendingCount ??
                    this.db.rows.filter(
                        (row) =>
                            row.status === 'pending' &&
                            row.expiresAt > new Date()
                    ).length
                return Promise.resolve([{ value: pending }])
            }
            return Promise.resolve(this.db.rows.map((row) => ({ ...row })))
        }
        return Promise.resolve([])
    }

    returning(_shape?: Record<string, unknown>): Promise<unknown[]> {
        return this.execute(true)
    }

    then<TResult1 = unknown[], TResult2 = never>(
        onfulfilled?:
            | ((value: unknown[]) => TResult1 | PromiseLike<TResult1>)
            | null,
        onrejected?:
            | ((reason: unknown) => TResult2 | PromiseLike<TResult2>)
            | null
    ): Promise<TResult1 | TResult2> {
        return this.execute(false).then(onfulfilled, onrejected)
    }

    private execute(returnRows: boolean): Promise<unknown[]> {
        if (this.result) return Promise.resolve(this.result)
        if (this.op === 'select' && this.table === larkAppRegistrations) {
            const pending =
                this.db.pendingCount ??
                this.db.rows.filter(
                    (row) =>
                        row.status === 'pending' && row.expiresAt > new Date()
                ).length
            this.result = this.shape && 'value' in this.shape ? [{ value: pending }] : []
            return Promise.resolve(this.result)
        }
        if (this.op === 'insert' && this.table === larkAppRegistrations) {
            const input = this.valuesInput ?? {}
            const now = new Date()
            const row: LarkAppRegistrationRow = {
                id: input.id as string,
                userId: input.userId as string,
                agentId: input.agentId as string,
                label: input.label as string,
                botName: input.botName as string,
                appRegion: input.appRegion as 'feishu' | 'lark',
                pollRegion: input.pollRegion as 'feishu' | 'lark',
                status: 'pending',
                deviceCodeCiphertext: input.deviceCodeCiphertext as string,
                keyVersion: (input.keyVersion as number | undefined) ?? 1,
                qrUrl: input.qrUrl as string,
                userCode: input.userCode as string,
                intervalSec: (input.intervalSec as number | undefined) ?? 5,
                lastPolledAt: null,
                errorCode: null,
                errorMessage: null,
                channelId: null,
                expiresAt: input.expiresAt as Date,
                createdAt: (input.createdAt as Date | undefined) ?? now,
                updatedAt: (input.updatedAt as Date | undefined) ?? now
            }
            this.db.rows.push(row)
            this.result = returnRows ? [{ ...row }] : []
            return Promise.resolve(this.result)
        }

        if (this.op === 'delete' && this.table === larkAppRegistrations) {
            const cutoff = Date.now() - 60 * 60_000
            const deleted = this.db.rows.filter(
                (row) => row.expiresAt.getTime() < cutoff
            )
            this.db.rows = this.db.rows.filter(
                (row) => row.expiresAt.getTime() >= cutoff
            )
            this.result = returnRows ? deleted : []
            return Promise.resolve(this.result)
        }

        if (this.op !== 'update' || this.table !== larkAppRegistrations) {
            this.result = []
            return Promise.resolve(this.result)
        }

        const row = this.db.rows[0]
        if (!row || !this.canUpdate(row)) {
            this.result = []
            return Promise.resolve(this.result)
        }
        Object.assign(row, this.patch)
        this.result = returnRows ? [{ ...row }] : []
        return Promise.resolve(this.result)
    }

    private canUpdate(row: LarkAppRegistrationRow): boolean {
        if ('lastPolledAt' in this.patch) {
            if (this.db.failNextPollLock) {
                this.db.failNextPollLock = false
                return false
            }
            return row.status === 'pending'
        }
        if (this.patch.status === 'creating') {
            if (this.db.failNextCreateLock) {
                this.db.failNextCreateLock = false
                return false
            }
            return row.status === 'pending'
        }
        if (this.patch.status === 'succeeded') return row.status === 'creating'
        if (this.patch.status === 'cancelled') return row.status === 'pending'
        if (this.patch.status === 'expired') return row.status === 'pending'
        if (this.patch.status === 'failed')
            return row.status === 'pending' || row.status === 'creating'
        if ('intervalSec' in this.patch || 'pollRegion' in this.patch)
            return row.status === 'pending'
        return true
    }
}

const registrationRow = (
    overrides: Partial<LarkAppRegistrationRow> = {}
): LarkAppRegistrationRow => {
    const now = new Date()
    return {
        id: 'lreg_test',
        userId: 'usr_1',
        agentId: 'agt_1',
        label: 'Support',
        botName: 'Support Bot',
        appRegion: 'feishu',
        pollRegion: 'feishu',
        status: 'pending',
        deviceCodeCiphertext: 'encrypted:device-code',
        keyVersion: 1,
        qrUrl: 'https://example.test/qr',
        userCode: 'ABCD',
        intervalSec: 5,
        lastPolledAt: null,
        errorCode: null,
        errorMessage: null,
        channelId: null,
        expiresAt: new Date(now.getTime() + 60 * 60_000),
        createdAt: now,
        updatedAt: now,
        ...overrides
    }
}

interface ServiceHarness {
    service: LarkRegistrationService
    channelCalls: Array<{ userId: string; body: Record<string, unknown> }>
    runtimeCalls: string[]
    cryptoEncryptCalls: string[]
}

const serviceHarness = (
    db: FakeDb,
    options: {
        channelError?: Error
        channelCreate?: () => Promise<{ id: string }>
    } = {}
): ServiceHarness => {
    const channelCalls: ServiceHarness['channelCalls'] = []
    const runtimeCalls: string[] = []
    const cryptoEncryptCalls: string[] = []
    const crypto = {
        encrypt: (plain: string) => {
            cryptoEncryptCalls.push(plain)
            return {
                ciphertext: `encrypted:${plain}`,
                keyVersion: 1
            }
        },
        decrypt: ({ ciphertext }: { ciphertext: string }) =>
            ciphertext.replace(/^encrypted:/, '')
    }
    const runtimeAccess = {
        reserveChannelSlot: async (userId: string) => {
            runtimeCalls.push(userId)
        }
    }
    const channels = {
        create: async (userId: string, body: Record<string, unknown>) => {
            channelCalls.push({ userId, body })
            if (options.channelError) throw options.channelError
            if (options.channelCreate) return options.channelCreate()
            return { id: 'chn_created' }
        }
    }
    return {
        service: new LarkRegistrationService(
            db as unknown as Database,
            crypto as never,
            runtimeAccess as never,
            channels as never,
            new CliAuthRateLimitService()
        ),
        channelCalls,
        runtimeCalls,
        cryptoEncryptCalls
    }
}

interface FetchCall {
    url: string
    init: RequestInit | undefined
}

const withFetch = async (
    handler: (call: FetchCall) => Response | Promise<Response>,
    run: () => Promise<void>
): Promise<void> => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = async (input, init) =>
        handler({ url: String(input), init })
    try {
        await run()
    } finally {
        globalThis.fetch = originalFetch
    }
}

test('start verifies ownership and stores only an encrypted device code', async () => {
    const db = new FakeDb()
    const harness = serviceHarness(db)
    const responses = [
        { supported_auth_methods: ['client_secret'] },
        {
            device_code: 'device-from-lark',
            verification_uri_complete: 'https://example.test/confirm',
            user_code: 'CODE',
            interval: 7,
            expires_in: 3600
        }
    ]
    await withFetch(
        () =>
            new Response(JSON.stringify(responses.shift()), { status: 200 }),
        async () => {
            const result = await harness.service.start('usr_1', {
                agentId: 'agt_1',
                appRegion: 'feishu',
                label: ' Support ',
                botName: ' Support Bot '
            })
            assert.equal(result.status, 'pending')
            assert.equal(result.intervalSec, 7)
            assert.match(result.qrUrl ?? '', /addons=/)
        }
    )
    assert.deepEqual(harness.runtimeCalls, ['usr_1'])
    assert.equal(db.rows[0]?.deviceCodeCiphertext, 'encrypted:device-from-lark')
    assert.deepEqual(harness.cryptoEncryptCalls, ['device-from-lark'])
    assert.equal(db.rows[0]?.label, 'Support')
    assert.equal(db.rows[0]?.botName, 'Support Bot')
})

test('start begins on the Feishu domain even when Lark is requested', async () => {
    const db = new FakeDb()
    const harness = serviceHarness(db)
    const calls: FetchCall[] = []
    const responses = [
        { supported_auth_methods: ['client_secret'] },
        {
            device_code: 'device-from-lark',
            verification_uri_complete: 'https://example.test/confirm',
            user_code: 'CODE',
            interval: 5,
            expires_in: 3600
        }
    ]
    await withFetch(
        (call) => {
            calls.push(call)
            return new Response(JSON.stringify(responses.shift()), {
                status: 200
            })
        },
        async () => {
            const result = await harness.service.start('usr_1', {
                agentId: 'agt_1',
                appRegion: 'lark',
                label: 'Support',
                botName: 'Support Bot'
            })
            assert.equal(result.status, 'pending')
        }
    )
    assert.equal(calls.length, 2)
    for (const call of calls)
        assert.match(call.url, /^https:\/\/accounts\.feishu\.cn\//)
    assert.equal(db.rows[0]?.appRegion, 'lark')
    assert.equal(db.rows[0]?.pollRegion, 'feishu')
})

test('start rejects a fourth live registration before calling Lark', async () => {
    const db = new FakeDb()
    db.pendingCount = 3
    const harness = serviceHarness(db)
    let fetchCalls = 0
    await withFetch(
        () => {
            fetchCalls++
            return new Response('{}', { status: 200 })
        },
        async () => {
            await assert.rejects(
                harness.service.start('usr_1', {
                    agentId: 'agt_1',
                    appRegion: 'feishu',
                    label: 'Support',
                    botName: 'Support Bot'
                }),
                (err: unknown) =>
                    (err as { response?: { code?: string } }).response?.code ===
                    'too_many_pending_registrations'
            )
        }
    )
    assert.equal(fetchCalls, 0)
})

test('start rejects an agent outside the account before reserving quota', async () => {
    const db = new FakeDb()
    db.agentOwned = false
    const harness = serviceHarness(db)
    await assert.rejects(
        harness.service.start('usr_1', {
            agentId: 'agt_other',
            appRegion: 'feishu',
            label: 'Support',
            botName: 'Support Bot'
        }),
        /agent not found/
    )
    assert.deepEqual(harness.runtimeCalls, [])
})

test('poll throttling and a lost optimistic lock make no upstream call', async () => {
    for (const mode of ['throttled', 'lock-loser'] as const) {
        const db = new FakeDb()
        db.rows = [
            registrationRow({
                lastPolledAt: mode === 'throttled' ? new Date() : null
            })
        ]
        db.failNextPollLock = mode === 'lock-loser'
        const harness = serviceHarness(db)
        let fetchCalls = 0
        await withFetch(
            () => {
                fetchCalls++
                return new Response('{}', { status: 200 })
            },
            async () => {
                const result = await harness.service.getAndAdvance(
                    { userId: 'usr_1' },
                    'lreg_test'
                )
                assert.equal(result.status, 'pending')
            }
        )
        assert.equal(fetchCalls, 0, mode)
    }
})

test('slow_down persists a five-second backoff for every API instance', async () => {
    const db = new FakeDb()
    db.rows = [registrationRow({ intervalSec: 5 })]
    const harness = serviceHarness(db)
    await withFetch(
        () =>
            new Response(JSON.stringify({ error: 'slow_down' }), {
                status: 400
            }),
        async () => {
            const result = await harness.service.getAndAdvance(
                { userId: 'usr_1' },
                'lreg_test'
            )
            assert.equal(result.intervalSec, 10)
        }
    )
    assert.equal(db.rows[0]?.intervalSec, 10)
})

test('denial and expiry become stable terminal states', async (t) => {
    for (const [error, status, errorCode] of [
        ['access_denied', 'failed', 'access_denied'],
        ['expired_token', 'expired', null]
    ] as const) {
        await t.test(error, async () => {
            const db = new FakeDb()
            db.rows = [registrationRow()]
            const harness = serviceHarness(db)
            await withFetch(
                () =>
                    new Response(JSON.stringify({ error }), { status: 400 }),
                async () => {
                    const result = await harness.service.getAndAdvance(
                        { userId: 'usr_1' },
                        'lreg_test'
                    )
                    assert.equal(result.status, status)
                    assert.equal(result.errorCode, errorCode)
                    assert.equal(result.qrUrl, null)
                }
            )
        })
    }
})

test('a Lark tenant domain switch immediately retries and creates one channel', async () => {
    const db = new FakeDb()
    db.rows = [registrationRow({ appRegion: 'lark' })]
    const harness = serviceHarness(db)
    const calls: FetchCall[] = []
    const responses = [
        { user_info: { tenant_brand: 'lark' } },
        {
            client_id: 'cli_lark',
            client_secret: 'app-secret',
            user_info: { open_id: 'ou_scanner', tenant_brand: 'lark' }
        }
    ]
    await withFetch(
        (call) => {
            calls.push(call)
            return new Response(JSON.stringify(responses.shift()), {
                status: 200
            })
        },
        async () => {
            const result = await harness.service.getAndAdvance(
                { userId: 'usr_1' },
                'lreg_test'
            )
            assert.equal(result.status, 'succeeded')
            assert.equal(result.channelId, 'chn_created')
        }
    )
    assert.match(calls[0]?.url ?? '', /accounts\.feishu\.cn/)
    assert.match(calls[1]?.url ?? '', /accounts\.larksuite\.com/)
    assert.equal(harness.channelCalls.length, 1)
    const body = harness.channelCalls[0]?.body as {
        provider: string
        config: Record<string, unknown>
        credentials: Record<string, unknown>
    }
    assert.equal(body.provider, 'lark')
    assert.equal(body.config.subscriptionMode, 'websocket')
    assert.equal(body.config.botName, 'Support Bot')
    assert.deepEqual(body.config.operatorUserIds, ['ou_scanner'])
    assert.equal(body.config.appRegion, 'lark')
    assert.deepEqual(body.credentials, { appSecret: 'app-secret' })
})

test('the scanned tenant brand overrides the requested app region', async () => {
    const db = new FakeDb()
    db.rows = [registrationRow({ appRegion: 'lark' })]
    const harness = serviceHarness(db)
    await withFetch(
        () =>
            new Response(
                JSON.stringify({
                    client_id: 'cli_feishu',
                    client_secret: 'app-secret',
                    user_info: {
                        open_id: 'ou_scanner',
                        tenant_brand: 'feishu'
                    }
                }),
                { status: 200 }
            ),
        async () => {
            const result = await harness.service.getAndAdvance(
                { userId: 'usr_1' },
                'lreg_test'
            )
            assert.equal(result.status, 'succeeded')
        }
    )
    const body = harness.channelCalls[0]?.body as {
        config: Record<string, unknown>
    }
    assert.equal(body.config.appRegion, 'feishu')
})

test('a lost channel-create lock discards credentials without creating a channel', async () => {
    const db = new FakeDb()
    db.rows = [registrationRow()]
    db.failNextCreateLock = true
    const harness = serviceHarness(db)
    await withFetch(
        () =>
            new Response(
                JSON.stringify({
                    client_id: 'cli_1',
                    client_secret: 'secret_1'
                }),
                { status: 200 }
            ),
        async () => {
            const result = await harness.service.getAndAdvance(
                { userId: 'usr_1' },
                'lreg_test'
            )
            assert.equal(result.status, 'pending')
        }
    )
    assert.deepEqual(harness.channelCalls, [])
})

test('channel creation failure becomes a retry-by-rescan terminal state', async () => {
    const db = new FakeDb()
    db.rows = [registrationRow()]
    const harness = serviceHarness(db, {
        channelError: new Error('websocket registration failed')
    })
    await withFetch(
        () =>
            new Response(
                JSON.stringify({
                    client_id: 'cli_1',
                    client_secret: 'secret_1'
                }),
                { status: 200 }
            ),
        async () => {
            const result = await harness.service.getAndAdvance(
                { userId: 'usr_1' },
                'lreg_test'
            )
            assert.equal(result.status, 'failed')
            assert.equal(result.errorCode, 'channel_create_failed')
            assert.match(result.errorMessage ?? '', /websocket registration/)
        }
    )
})

test('transient 5xx leaves the session pending for the next interval', async () => {
    const db = new FakeDb()
    db.rows = [registrationRow()]
    const harness = serviceHarness(db)
    await withFetch(
        () => new Response('upstream down', { status: 503 }),
        async () => {
            const result = await harness.service.getAndAdvance(
                { userId: 'usr_1' },
                'lreg_test'
            )
            assert.equal(result.status, 'pending')
            assert.ok(db.rows[0]?.lastPolledAt)
        }
    )
})

test('a stale creating owner fails loud instead of hanging forever', async () => {
    const db = new FakeDb()
    db.rows = [
        registrationRow({
            status: 'creating',
            updatedAt: new Date(Date.now() - 61_000)
        })
    ]
    const harness = serviceHarness(db)
    const result = await harness.service.getAndAdvance(
        { userId: 'usr_1' },
        'lreg_test'
    )
    assert.equal(result.status, 'failed')
    assert.equal(result.errorCode, 'channel_create_failed')
    assert.match(result.errorMessage ?? '', /timed out/)
})

test('a live channel creation renews its lease beyond the stale timeout', async (t) => {
    t.mock.timers.enable({ apis: ['setInterval', 'Date'] })
    const db = new FakeDb()
    db.rows = [registrationRow()]
    let markStarted!: () => void
    let releaseCreate!: () => void
    const started = new Promise<void>((resolve) => {
        markStarted = resolve
    })
    const createReleased = new Promise<void>((resolve) => {
        releaseCreate = resolve
    })
    const harness = serviceHarness(db, {
        channelCreate: async () => {
            markStarted()
            await createReleased
            return { id: 'chn_created' }
        }
    })

    await withFetch(
        () =>
            new Response(
                JSON.stringify({
                    client_id: 'cli_1',
                    client_secret: 'secret_1'
                }),
                { status: 200 }
            ),
        async () => {
            const advancing = harness.service.getAndAdvance(
                { userId: 'usr_1' },
                'lreg_test'
            )
            await started
            for (let elapsed = 0; elapsed < 75_000; elapsed += 15_000) {
                t.mock.timers.tick(15_000)
                await Promise.resolve()
                await Promise.resolve()
            }

            const observed = await harness.service.getAndAdvance(
                { userId: 'usr_1' },
                'lreg_test'
            )
            assert.equal(observed.status, 'creating')

            releaseCreate()
            assert.equal((await advancing).status, 'succeeded')
        }
    )
})

test('cancel is idempotent and bound agents cannot touch another registration', async () => {
    const db = new FakeDb()
    db.rows = [registrationRow()]
    const harness = serviceHarness(db)
    await assert.rejects(
        harness.service.cancel(
            { userId: 'usr_1', boundAgentId: 'agt_other' },
            'lreg_test'
        ),
        /another agent/
    )
    await harness.service.cancel({ userId: 'usr_1' }, 'lreg_test')
    await harness.service.cancel({ userId: 'usr_1' }, 'lreg_test')
    assert.equal(db.rows[0]?.status, 'cancelled')
})

test('cancel cannot hide a channel creation that is already in progress', async () => {
    const db = new FakeDb()
    db.rows = [registrationRow({ status: 'creating' })]
    const harness = serviceHarness(db)

    await harness.service.cancel({ userId: 'usr_1' }, 'lreg_test')

    assert.equal(db.rows[0]?.status, 'creating')
})

test('cleanup removes registrations only after the one-hour retention window', async () => {
    const db = new FakeDb()
    db.rows = [
        registrationRow({
            id: 'lreg_old',
            expiresAt: new Date(Date.now() - 61 * 60_000)
        }),
        registrationRow({
            id: 'lreg_recent',
            expiresAt: new Date(Date.now() - 30 * 60_000)
        })
    ]
    const harness = serviceHarness(db)
    assert.equal(await harness.service.cleanupExpiredRegistrations(), 1)
    assert.deepEqual(
        db.rows.map((row) => row.id),
        ['lreg_recent']
    )
})
