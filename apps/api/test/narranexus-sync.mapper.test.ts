import assert from 'node:assert/strict'
import test from 'node:test'
import { LarkChannelProvider } from '../src/modules/channels/providers/lark.provider'
import {
    mapChannel,
    mapJob
} from '../src/modules/narranexus-sync/narranexus-sync.mapper'
import type {
    NarraNexusChannelBinding,
    NarraNexusJob
} from '../src/modules/narranexus-sync/narranexus-sync.types'

const NOW = new Date('2026-07-16T12:00:00.000Z')

const job = (overrides: Partial<NarraNexusJob> = {}): NarraNexusJob => ({
    job_id: 'job_1',
    agent_id: 'nx_agent_1',
    title: 'Daily brief',
    status: 'active',
    job_type: 'scheduled',
    next_run_time: '2026-07-16T15:00:00.000Z',
    updated_at: null,
    ...overrides
})

test('mapJob mirrors an active job as an armed one-shot alarm', () => {
    const mapped = mapJob('rt_1', job(), NOW)
    assert.ok(mapped)
    assert.equal(mapped.status, 'active')
    assert.equal(mapped.prompt, '[[nx:run_job job_1 v1]]')
    assert.equal(mapped.nextRunAt?.toISOString(), '2026-07-16T15:00:00.000Z')
    assert.deepEqual(
        { ...mapped.origin, contentHash: 'x' },
        { kind: 'narranexus', runtimeId: 'rt_1', jobId: 'job_1', contentHash: 'x' }
    )
})

test('mapJob clamps an overdue fire time without changing the hash', () => {
    const overdue = job({ next_run_time: '2026-07-16T11:00:00.000Z' })
    const mapped = mapJob('rt_1', overdue, NOW)
    assert.ok(mapped)
    assert.ok(mapped.nextRunAt!.getTime() === NOW.getTime() + 5_000)
    const later = mapJob('rt_1', overdue, new Date(NOW.getTime() + 60_000))
    assert.equal(mapped.contentHash, later!.contentHash)
})

test('mapJob arms cooling retries but not paused/blocked/running states', () => {
    const armed = mapJob('rt_1', job({ status: 'cooling' }), NOW)
    assert.equal(armed?.status, 'active')
    assert.ok(armed?.nextRunAt)
    for (const status of [
        'paused',
        'paused_no_quota',
        'blocked',
        'blocked_failed',
        'running',
        'failed'
    ]) {
        const mapped = mapJob('rt_1', job({ status }), NOW)
        assert.equal(mapped?.status, 'paused', status)
        assert.equal(mapped?.nextRunAt, null, status)
    }
})

test('mapJob disarms when next_run_time is missing and rejects bad rows', () => {
    const mapped = mapJob('rt_1', job({ next_run_time: null }), NOW)
    assert.equal(mapped?.status, 'paused')
    assert.equal(mapped?.nextRunAt, null)
    assert.equal(mapJob('rt_1', job({ job_id: ' ' }), NOW), null)
    assert.equal(mapJob('rt_1', job({ agent_id: '' }), NOW), null)
})

test('mapJob hash changes with schedule or title, stable otherwise', () => {
    const a = mapJob('rt_1', job(), NOW)!
    const b = mapJob('rt_1', job(), NOW)!
    assert.equal(a.contentHash, b.contentHash)
    const retitled = mapJob('rt_1', job({ title: 'Renamed' }), NOW)!
    assert.notEqual(a.contentHash, retitled.contentHash)
    const rescheduled = mapJob(
        'rt_1',
        job({ next_run_time: '2026-07-17T15:00:00.000Z' }),
        NOW
    )!
    assert.notEqual(a.contentHash, rescheduled.contentHash)
})

const binding = (
    overrides: Partial<NarraNexusChannelBinding> = {}
): NarraNexusChannelBinding => ({
    provider: 'telegram',
    agent_id: 'nx_agent_1',
    enabled: true,
    external_id: '42',
    credentials: { bot_token: '123456:ABCDEF' },
    config: { bot_username: 'nx_bot' },
    ...overrides
})

test('mapChannel translates telegram/discord/wechat bot-token bindings', () => {
    const tg = mapChannel('rt_1', binding())!
    assert.equal(tg.provider, 'telegram')
    assert.deepEqual(tg.credentials, { botToken: '123456:ABCDEF' })
    assert.equal(tg.externalId, '42')
    assert.equal(tg.origin.nxAgentId, 'nx_agent_1')

    const discord = mapChannel(
        'rt_1',
        binding({ provider: 'discord', credentials: { bot_token: 'd'.repeat(60) } })
    )!
    assert.equal(discord.provider, 'discord')

    const weixin = mapChannel(
        'rt_1',
        binding({
            provider: 'wechat',
            credentials: { bot_token: 'ilink-token', base_url: 'https://ilink.example' },
            config: { bot_wx_id: 'wx_1' }
        })
    )!
    assert.equal(weixin.provider, 'weixin')
    assert.deepEqual(weixin.credentials, {
        botToken: 'ilink-token',
        baseUrl: 'https://ilink.example'
    })
})

test('mapChannel falls back to mention-all for lark without a bot name', () => {
    const lark = mapChannel(
        'rt_1',
        binding({
            provider: 'lark',
            credentials: { app_secret: 's3cret' },
            config: { app_id: 'cli_abc', brand: 'lark' },
            external_id: 'cli_abc'
        })
    )!
    assert.equal(lark.provider, 'lark')
    assert.deepEqual(lark.config, {
        appId: 'cli_abc',
        subscriptionMode: 'websocket',
        appRegion: 'lark',
        mentionOnly: false,
        agentManagedReply: true
    })
    assert.deepEqual(lark.credentials, { appSecret: 's3cret' })
})

test('mapChannel keeps @-mention gating for lark once bot_name is known', () => {
    const lark = mapChannel(
        'rt_1',
        binding({
            provider: 'lark',
            credentials: { app_secret: 's3cret' },
            config: { app_id: 'cli_abc', brand: 'feishu', bot_name: 'NX Bot' },
            external_id: 'cli_abc'
        })
    )!
    assert.deepEqual(lark.config, {
        appId: 'cli_abc',
        subscriptionMode: 'websocket',
        appRegion: 'feishu',
        botName: 'NX Bot',
        mentionOnly: true,
        agentManagedReply: true
    })
})

test('mapChannel lark output passes the provider strict validation', () => {
    const provider = new LarkChannelProvider({
        get: () => 'https://open.feishu.cn'
    } as never)
    for (const config of [
        { app_id: 'cli_abc', brand: 'lark' },
        { app_id: 'cli_abc', brand: 'feishu', bot_name: 'NX Bot' }
    ]) {
        const lark = mapChannel(
            'rt_1',
            binding({
                provider: 'lark',
                credentials: { app_secret: 's3cret' },
                config
            })
        )!
        assert.doesNotThrow(() =>
            provider.validateConfig(lark.config, { strict: true })
        )
    }
})

test('mapChannel accepts only matrix-mode narramessenger bindings', () => {
    const matrix = mapChannel(
        'rt_1',
        binding({
            provider: 'narramessenger',
            connection_mode: 'matrix',
            credentials: { matrix_access_token: 'syt_token' },
            config: {
                matrix_homeserver_url: 'https://matrix.example',
                matrix_user_id: '@bot:matrix.example'
            }
        })
    )!
    assert.equal(matrix.provider, 'matrix')
    assert.deepEqual(matrix.config, {
        homeserver: 'https://matrix.example',
        agentManagedReply: true
    })
    const gateway = mapChannel(
        'rt_1',
        binding({ provider: 'narramessenger', connection_mode: 'gateway' })
    )
    assert.equal(gateway, null)
})

// The switch is the gate every other channel_context field sits behind, and a
// mirrored channel exists because NarraNexus asked for it — so it defaults on
// and the binding turns it off, not the other way round. Getting this backwards
// silently returns every hosted channel to Manyfold-delivers-the-reply.
test('mapChannel turns agentManagedReply on by default and off only when the binding says so', () => {
    const configFor = (agentManagedReply: unknown): Record<string, unknown> =>
        mapChannel(
            'rt_1',
            binding({
                provider: 'telegram',
                credentials: { bot_token: 'tg-token' },
                config:
                    agentManagedReply === undefined
                        ? {}
                        : { agent_managed_reply: agentManagedReply }
            })
        )!.config

    assert.deepEqual(
        configFor(undefined),
        { agentManagedReply: true },
        'a binding that says nothing gets the hosted behaviour'
    )
    assert.deepEqual(configFor(true), { agentManagedReply: true })
    assert.deepEqual(
        configFor(false),
        {},
        'explicit false is the per-channel rollback and must clear the key, not just set it false'
    )
    assert.deepEqual(
        configFor('false'),
        {},
        'a stringified boolean must still disable — reading "false" as truthy would make rollback impossible'
    )
    assert.deepEqual(configFor('0'), {})
    assert.deepEqual(configFor('true'), { agentManagedReply: true })
})

// channels.service rejects agentManagedReply on a provider NarraNexus cannot
// deliver through, and the reconcile loop swallows that rejection as a warn —
// so a flag the guard would refuse does not disable one channel, it stops the
// channel from syncing at all. The mapper must never emit one.
test('mapChannel never emits agentManagedReply for a provider NarraNexus cannot deliver through', () => {
    const slack = mapChannel('rt_1', binding({ provider: 'slack' }))
    assert.equal(slack, null, 'slack has no Manyfold mirror to begin with')

    const deliverable: NarraNexusChannelBinding[] = [
        binding({ provider: 'telegram' }),
        binding({
            provider: 'discord',
            credentials: { bot_token: 'discord-token' }
        }),
        binding({
            provider: 'lark',
            credentials: { app_secret: 's3cret' },
            config: { app_id: 'cli_abc', brand: 'lark' }
        }),
        binding({
            provider: 'wechat',
            credentials: { bot_token: 'ilink-token' },
            config: {}
        }),
        binding({
            provider: 'narramessenger',
            connection_mode: 'matrix',
            credentials: { matrix_access_token: 'syt_token' },
            config: { matrix_homeserver_url: 'https://matrix.example' }
        })
    ]
    for (const b of deliverable) {
        const mapped = mapChannel('rt_1', b)
        assert.ok(mapped, `${b.provider} must still map`)
        assert.equal(
            (mapped.config as { agentManagedReply?: unknown })
                .agentManagedReply,
            true,
            `${b.provider} maps to a NarraNexus WorkingSource, so the flag is safe to set`
        )
    }
})

test('mapChannel rejects slack, disabled rows, and missing credentials', () => {
    assert.equal(
        mapChannel('rt_1', binding({ provider: 'slack' })),
        null
    )
    assert.equal(mapChannel('rt_1', binding({ enabled: false })), null)
    assert.equal(
        mapChannel('rt_1', binding({ credentials: {} })),
        null
    )
    assert.equal(mapChannel('rt_1', binding({ provider: 'unknown' })), null)
})

test('mapChannel hash tracks credential and config changes', () => {
    const a = mapChannel('rt_1', binding())!
    const b = mapChannel('rt_1', binding())!
    assert.equal(a.contentHash, b.contentHash)
    const rotated = mapChannel(
        'rt_1',
        binding({ credentials: { bot_token: '999999:ROTATED' } })
    )!
    assert.notEqual(a.contentHash, rotated.contentHash)
})
