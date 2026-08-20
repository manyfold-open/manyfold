import type { DiscordChannelConfig } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChannelRow } from '@manyfold/db'
import {
    DiscordChannelProvider,
    findBotManagedRoleId,
    normalizeInteraction
} from '../src/modules/channels/providers/discord.provider'
import { CHANNEL_PROVIDER_HTTP_TIMEOUT_MS } from '../src/modules/channels/providers/channel-http'
import type { NormalizedInboundEvent } from '../src/modules/channels/channel-provider'
import { SLASH_COMMAND_SPECS } from '../src/modules/channels/slash/commands'

const makeChannel = (overrides: Partial<ChannelRow> = {}): ChannelRow => ({
    id: 'chn-discord-1',
    userId: 'user-1',
    agentId: 'agent-1',
    provider: 'discord',
    label: 'discord test',
    status: 'active',
    configJson: {},
    credentialsCiphertext: null,
    keyVersion: 1,
    externalId: null,
    origin: null,
    lastConnectedAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
    reconnectAttempts: 0,
    nextReconnectAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides
})

const baseConfig = (
    overrides: Partial<DiscordChannelConfig> = {}
): DiscordChannelConfig => ({
    botUserId: '111111111111111111',
    botName: 'TestBot',
    applicationId: '222222222222222222',
    allowedGuildIds: [],
    mentionOnly: true,
    shareSessionInChannel: false,
    threadIsolation: true,
    autoThread: false,
    progressMode: 'preview',
    finalMessageMode: 'edit',
    ...overrides
})

const makeCredentials = (
    botToken = 'MTIzNDU2Nzg5MDEyMzQ1Njc4OTAuYWJjZGVmZ2hpams.QQ_QQ_QQ_QQ_QQ_QQ_QQ_QQ_QQ_QQ_QQ'
) => ({
    botToken
})

const discordMessage = (overrides: Record<string, unknown> = {}): unknown => ({
    id: 'MSG1',
    channel_id: 'C1',
    content: 'hello',
    author: {
        id: 'U1',
        username: 'Alice',
        bot: false
    },
    mentions: [],
    mention_roles: [],
    ...overrides
})

interface TestIdentity {
    botUserId: string | null
    managedRoleIds: Map<string, string>
}

type DiscordCommandBody = Array<{
    name: string
    description: string
    options?: Array<{ name: string; required: boolean }>
}>

const normalize = (
    provider: DiscordChannelProvider,
    data: unknown,
    config: DiscordChannelConfig,
    identity: TestIdentity
): NormalizedInboundEvent | null =>
    (
        provider as unknown as {
            normalizeMessage: (
                data: unknown,
                config: DiscordChannelConfig,
                identity: TestIdentity
            ) => NormalizedInboundEvent | null
        }
    ).normalizeMessage(data, config, identity)

test('discord validateCredentials rejects empty/short tokens', () => {
    const provider = new DiscordChannelProvider()
    assert.throws(
        () => provider.validateCredentials({ botToken: 'short' }),
        /botToken/
    )
    const longWithSpace = `${'a'.repeat(40)} ${'b'.repeat(20)}`
    assert.throws(
        () => provider.validateCredentials({ botToken: longWithSpace }),
        /whitespace/
    )
    const ok = provider.validateCredentials(makeCredentials())
    assert.equal(ok?.botToken, makeCredentials().botToken)
})

test('discord validateConfig coerces allowedGuildIds and defaults', () => {
    const provider = new DiscordChannelProvider()
    const out = provider.validateConfig({
        allowedGuildIds: ['111', '', '  222  ', 33, null]
    })
    assert.deepEqual(out.allowedGuildIds, ['111', '222'])
    assert.equal(out.mentionOnly, true)
    assert.equal(out.threadIsolation, true)
    assert.equal(out.shareSessionInChannel, false)
    assert.equal(out.progressMode, 'preview')
    assert.equal(out.botUserId, null)
    assert.equal(out.finalMessageMode, 'edit')
    assert.equal(
        provider.validateConfig({ finalMessageMode: 'fresh' }).finalMessageMode,
        'fresh'
    )
    assert.equal(out.historyBackfill, true)
    assert.equal(out.historyBackfillLimit, 50)
    assert.equal(
        provider.validateConfig({ historyBackfill: false }).historyBackfill,
        false
    )
    assert.equal(
        provider.validateConfig({ historyBackfillLimit: 250 })
            .historyBackfillLimit,
        100
    )
    assert.equal(
        provider.validateConfig({ historyBackfillLimit: 0 })
            .historyBackfillLimit,
        1
    )
    assert.equal(out.contextProjection, true)
    assert.equal(
        provider.validateConfig({ contextProjection: false }).contextProjection,
        false
    )
})

test('discord deleteMessage removes the message from the resolved channel', async () => {
    const provider = new DiscordChannelProvider()
    const calls: Array<{ channelId: string; messageId: string }> = []
    const fakeApi = {
        channels: {
            deleteMessage: async (channelId: string, messageId: string) => {
                calls.push({ channelId, messageId })
            }
        }
    }
    const internal = provider as unknown as { apiFor: () => unknown }
    const origApiFor = internal.apiFor
    internal.apiFor = () => fakeApi
    try {
        await provider.deleteMessage(
            {
                channel: makeChannel(),
                config: baseConfig(),
                credentials: makeCredentials()
            },
            'discord:guild:G1:channel:C9:user:U2',
            'MSG-DEAD'
        )
        assert.deepEqual(calls, [{ channelId: 'C9', messageId: 'MSG-DEAD' }])
    } finally {
        internal.apiFor = origApiFor
    }
})

test('discord verifySignature is rejected (Gateway-only)', () => {
    const provider = new DiscordChannelProvider()
    const result = provider.verifySignature()
    assert.equal(result.ok, false)
    assert.equal(result.reason, 'discord_uses_gateway_only')
})

test('discord parseInbound throws UnsupportedEventError', () => {
    const provider = new DiscordChannelProvider()
    assert.throws(() => provider.parseInbound(), /unsupported event type/)
})

test('discord normalizeMessage sets replyTargetId for guild, null for DM', () => {
    const provider = new DiscordChannelProvider()
    const identity = { botUserId: 'BOT', managedRoleIds: new Map() }
    const guild = normalize(
        provider,
        discordMessage({ id: 'MSG9', guild_id: 'G1', content: 'hey <@BOT>' }),
        baseConfig(),
        identity
    )
    assert.equal(guild?.replyTargetId, 'MSG9')
    assert.equal(guild?.messageId, 'MSG9')
    assert.equal(guild?.replyToMessageId, null)
    const dm = normalize(
        provider,
        discordMessage({ id: 'MSG9', content: 'hey' }),
        baseConfig(),
        identity
    )
    assert.equal(dm?.replyTargetId, null)
    assert.equal(dm?.messageId, 'MSG9')
})

test('discord normalizeMessage records the referenced message as replyToMessageId', () => {
    const provider = new DiscordChannelProvider()
    const identity = { botUserId: 'BOT', managedRoleIds: new Map() }
    const event = normalize(
        provider,
        discordMessage({
            id: 'MSG10',
            guild_id: 'G1',
            content: 'hey <@BOT>',
            referenced_message: {
                id: 'MSG2',
                content: 'earlier question',
                author: { id: 'U2', username: 'Bob', bot: false }
            }
        }),
        baseConfig(),
        identity
    )
    assert.equal(event?.replyToMessageId, 'MSG2')
    assert.equal(event?.messageId, 'MSG10')
})

test('discord sendText references the triggering message on the first chunk only', async () => {
    const provider = new DiscordChannelProvider()
    const calls: Array<{ content: string; message_reference?: unknown }> = []
    const fakeApi = {
        channels: {
            createMessage: async (
                _channelId: string,
                body: { content: string; message_reference?: unknown }
            ) => {
                calls.push({
                    content: body.content,
                    message_reference: body.message_reference
                })
                return { id: `msg-${calls.length}` }
            }
        }
    }
    const internal = provider as unknown as { apiFor: () => unknown }
    const origApiFor = internal.apiFor
    internal.apiFor = () => fakeApi
    try {
        await provider.sendText(
            {
                channel: makeChannel(),
                config: baseConfig(),
                credentials: makeCredentials()
            },
            'discord:guild:G1:channel:C9:user:U2',
            `${'a'.repeat(1900)}\n\n${'b'.repeat(1900)}`,
            { replyToProviderMessageId: 'TRIGGER' }
        )
        assert.equal(calls.length, 2)
        assert.deepEqual(calls[0]?.message_reference, {
            message_id: 'TRIGGER',
            fail_if_not_exists: false
        })
        assert.equal(calls[1]?.message_reference, undefined)
    } finally {
        internal.apiFor = origApiFor
    }
})

test('discord sendText skips the reference when target channel is the referenced message (thread starter)', async () => {
    const provider = new DiscordChannelProvider()
    const calls: Array<{ message_reference?: unknown }> = []
    const fakeApi = {
        channels: {
            createMessage: async (
                _channelId: string,
                body: { message_reference?: unknown }
            ) => {
                calls.push({ message_reference: body.message_reference })
                return { id: 'm1' }
            }
        }
    }
    const internal = provider as unknown as { apiFor: () => unknown }
    const origApiFor = internal.apiFor
    internal.apiFor = () => fakeApi
    try {
        // scopeKey targets thread C9; the auto-thread's id equals the starter
        // message id, so a self-reference must be suppressed.
        await provider.sendText(
            {
                channel: makeChannel(),
                config: baseConfig(),
                credentials: makeCredentials()
            },
            'discord:guild:G1:channel:C1:thread:C9',
            'in thread',
            { replyToProviderMessageId: 'C9' }
        )
        assert.equal(calls.length, 1)
        assert.equal(calls[0]?.message_reference, undefined)
    } finally {
        internal.apiFor = origApiFor
    }
})

test('discord computeScopeKey: DM scope', () => {
    const provider = new DiscordChannelProvider()
    const result = provider.computeScopeKey(
        {
            providerEventId: 'discord-1',
            chatId: 'C_DM',
            chatType: 'private',
            senderId: 'U1',
            senderName: 'Alice',
            text: 'hi',
            threadId: null,
            isMention: true,
            raw: {}
        },
        baseConfig()
    )
    assert.equal(result.scopeKey, 'discord:dm:user:U1')
    assert.equal(result.scopeName, 'Alice')
})

test('discord computeScopeKey: guild channel per-user (default)', () => {
    const provider = new DiscordChannelProvider()
    const result = provider.computeScopeKey(
        {
            providerEventId: 'discord-2',
            chatId: 'G1:C1',
            chatType: 'group',
            senderId: 'U2',
            senderName: 'Bob',
            text: 'yo',
            threadId: null,
            isMention: true,
            raw: {}
        },
        baseConfig()
    )
    assert.equal(result.scopeKey, 'discord:guild:G1:channel:C1:user:U2')
})

test('discord computeScopeKey: shareSessionInChannel collapses to channel', () => {
    const provider = new DiscordChannelProvider()
    const result = provider.computeScopeKey(
        {
            providerEventId: 'discord-3',
            chatId: 'G1:C1',
            chatType: 'group',
            senderId: 'U2',
            senderName: 'Bob',
            text: 'yo',
            threadId: null,
            isMention: true,
            raw: {}
        },
        baseConfig({ shareSessionInChannel: true })
    )
    assert.equal(result.scopeKey, 'discord:guild:G1:channel:C1')
    assert.equal(result.scopeName, null)
})

test('discord sendText posts to the resolved channel id', async () => {
    const provider = new DiscordChannelProvider()
    const calls: Array<{
        channelId: string
        content: string
        allowed_mentions?: unknown
    }> = []
    const fakeApi = {
        channels: {
            createMessage: async (
                channelId: string,
                body: { content: string; allowed_mentions?: unknown }
            ) => {
                calls.push({
                    channelId,
                    content: body.content,
                    allowed_mentions: body.allowed_mentions
                })
                return { id: `msg-${calls.length}` }
            }
        }
    }
    type Internal = {
        apiFor: () => unknown
    }
    const internal = provider as unknown as Internal
    const origApiFor = internal.apiFor
    internal.apiFor = () => fakeApi
    try {
        const result = await provider.sendText(
            {
                channel: makeChannel(),
                config: baseConfig(),
                credentials: makeCredentials()
            },
            'discord:guild:G1:channel:C9:user:U2',
            'hello world'
        )
        assert.equal(result.providerMessageId, 'msg-1')
        assert.equal(calls.length, 1)
        assert.equal(calls[0]?.channelId, 'C9')
        assert.equal(calls[0]?.content, 'hello world')
        assert.deepEqual(calls[0]?.allowed_mentions, { parse: [] })
    } finally {
        internal.apiFor = origApiFor
    }
})

// DM scopes are valid automation delivery destinations: sendText must open
// (or reuse) the DM channel from the scope's user id, not require a live
// inbound context.
test('discord sendText resolves a dm scope via createDM', async () => {
    const provider = new DiscordChannelProvider()
    const createMessageCalls: Array<{ channelId: string; content: string }> = []
    const createDMCalls: string[] = []
    const fakeApi = {
        channels: {
            createMessage: async (
                channelId: string,
                body: { content: string }
            ) => {
                createMessageCalls.push({ channelId, content: body.content })
                return { id: `msg-${createMessageCalls.length}` }
            }
        },
        users: {
            createDM: async (userId: string) => {
                createDMCalls.push(userId)
                return { id: 'D-DM1' }
            }
        }
    }
    type Internal = {
        apiFor: () => unknown
    }
    const internal = provider as unknown as Internal
    const origApiFor = internal.apiFor
    internal.apiFor = () => fakeApi
    try {
        const result = await provider.sendText(
            {
                channel: makeChannel(),
                config: baseConfig(),
                credentials: makeCredentials()
            },
            'discord:dm:user:U7',
            'nightly report'
        )
        assert.equal(result.providerMessageId, 'msg-1')
        assert.deepEqual(createDMCalls, ['U7'])
        assert.equal(createMessageCalls[0]?.channelId, 'D-DM1')
        assert.equal(createMessageCalls[0]?.content, 'nightly report')
    } finally {
        internal.apiFor = origApiFor
    }
})

test('discord sendText keeps code fences balanced across chunks', async () => {
    const provider = new DiscordChannelProvider()
    const calls: string[] = []
    const fakeApi = {
        channels: {
            createMessage: async (
                _channelId: string,
                body: { content: string }
            ) => {
                calls.push(body.content)
                return { id: `msg-${calls.length}` }
            }
        }
    }
    const internal = provider as unknown as { apiFor: () => unknown }
    const origApiFor = internal.apiFor
    internal.apiFor = () => fakeApi
    try {
        const code = Array.from(
            { length: 400 },
            (_, i) => `const value${i} = ${i}`
        ).join('\n')
        await provider.sendText(
            {
                channel: makeChannel(),
                config: baseConfig(),
                credentials: makeCredentials()
            },
            'discord:guild:G1:channel:C9:user:U2',
            `here is the code:\n\`\`\`ts\n${code}\n\`\`\``
        )
        assert.ok(calls.length > 1)
        for (const content of calls) {
            assert.ok(content.length <= 2000)
            const fences = content.match(/^```/gm) ?? []
            assert.equal(fences.length % 2, 0)
        }
    } finally {
        internal.apiFor = origApiFor
    }
})

test('discord preview sends and edits with mentions disabled', async () => {
    const provider = new DiscordChannelProvider()
    const creates: Array<{ content: string; allowed_mentions?: unknown }> = []
    const edits: Array<{ content: string; allowed_mentions?: unknown }> = []
    const fakeApi = {
        channels: {
            createMessage: async (
                _channelId: string,
                body: { content: string; allowed_mentions?: unknown }
            ) => {
                creates.push(body)
                return { id: `msg-${creates.length}` }
            },
            editMessage: async (
                _channelId: string,
                _messageId: string,
                body: { content: string; allowed_mentions?: unknown }
            ) => {
                edits.push(body)
                return { id: _messageId }
            }
        }
    }
    type Internal = {
        apiFor: () => unknown
    }
    const internal = provider as unknown as Internal
    const origApiFor = internal.apiFor
    internal.apiFor = () => fakeApi
    try {
        const ctx = {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: makeCredentials()
        }
        const handle = await provider.sendPreviewStart(
            ctx,
            'discord:guild:G1:channel:C9:user:U2'
        )
        await provider.finishPreview(ctx, handle, '@everyone done')
        assert.deepEqual(creates[0]?.allowed_mentions, { parse: [] })
        assert.deepEqual(edits[0]?.allowed_mentions, { parse: [] })
    } finally {
        internal.apiFor = origApiFor
    }
})

test('discord REST cache is invalidated when credentials rotate', () => {
    const provider = new DiscordChannelProvider()
    type Internal = {
        restFor: (
            channelId: string,
            credentials: { botToken: string }
        ) => unknown
    }
    const internal = provider as unknown as Internal
    const tokenA = 'a'.repeat(60)
    const tokenB = 'b'.repeat(60)

    const first = internal.restFor('chn-discord-1', makeCredentials(tokenA))
    const cached = internal.restFor('chn-discord-1', makeCredentials(tokenA))
    const rotated = internal.restFor('chn-discord-1', makeCredentials(tokenB))

    assert.equal(cached, first)
    assert.notEqual(rotated, first)
    assert.equal(
        (first as { options: { timeout: number } }).options.timeout,
        CHANNEL_PROVIDER_HTTP_TIMEOUT_MS
    )
})

test('discord allowedGuildIds rejects DMs and non-allowed guilds', () => {
    const provider = new DiscordChannelProvider()
    type Internal = {
        acceptanceFor: (
            data: unknown,
            config: DiscordChannelConfig
        ) =>
            | 'accept'
            | 'bot_author'
            | 'self'
            | 'guild_not_allowed'
            | 'dm_blocked'
    }
    const internal = provider as unknown as Internal
    const restricted = baseConfig({ allowedGuildIds: ['G1'] })

    assert.equal(
        internal.acceptanceFor(discordMessage(), restricted),
        'dm_blocked'
    )
    assert.equal(
        internal.acceptanceFor(discordMessage({ guild_id: 'G2' }), restricted),
        'guild_not_allowed'
    )
    assert.equal(
        internal.acceptanceFor(discordMessage({ guild_id: 'G1' }), restricted),
        'accept'
    )
    assert.equal(
        internal.acceptanceFor(
            discordMessage(),
            baseConfig({ allowedGuildIds: [] })
        ),
        'accept'
    )
})

test('discord isMention: managed-role mention counts as a bot mention', () => {
    // Discord's @ autocomplete often inserts the bot's managed role instead of
    // the bot user (<@&role> with mentions=[]). If that doesn't count, real
    // @mentions get dropped as mention_required and mention-only groups are
    // unusable — the exact prod bug this guards against.
    const provider = new DiscordChannelProvider()
    const identity: TestIdentity = {
        botUserId: '111111111111111111',
        managedRoleIds: new Map([['G1', 'R_BOT']])
    }
    const roleMention = normalize(
        provider,
        discordMessage({
            guild_id: 'G1',
            content: '<@&R_BOT> hi',
            mention_roles: ['R_BOT']
        }),
        baseConfig(),
        identity
    )
    assert.equal(roleMention?.isMention, true)

    const unrelatedRole = normalize(
        provider,
        discordMessage({
            guild_id: 'G1',
            content: '<@&R_OTHER> hi',
            mention_roles: ['R_OTHER']
        }),
        baseConfig(),
        identity
    )
    assert.equal(unrelatedRole?.isMention, false)

    const otherGuildRole = normalize(
        provider,
        discordMessage({
            guild_id: 'G2',
            content: '<@&R_BOT> hi',
            mention_roles: ['R_BOT']
        }),
        baseConfig(),
        identity
    )
    assert.equal(otherGuildRole?.isMention, false)
})

test('discord isMention: gateway identity beats stale config botUserId', () => {
    // Ready reports the token's real bot user; a channel whose stored
    // botUserId is stale (or never registered) must still detect mentions.
    const provider = new DiscordChannelProvider()
    const identity: TestIdentity = {
        botUserId: 'BOT_REAL',
        managedRoleIds: new Map()
    }
    const event = normalize(
        provider,
        discordMessage({
            guild_id: 'G1',
            content: '<@BOT_REAL> hi',
            mentions: [{ id: 'BOT_REAL' }]
        }),
        baseConfig({ botUserId: 'BOT_STALE' }),
        identity
    )
    assert.equal(event?.isMention, true)

    const configFallback = normalize(
        provider,
        discordMessage({
            guild_id: 'G1',
            content: '<@111111111111111111> hi',
            mentions: [{ id: '111111111111111111' }]
        }),
        baseConfig(),
        { botUserId: null, managedRoleIds: new Map() }
    )
    assert.equal(configFallback?.isMention, true)

    const otherBot = normalize(
        provider,
        discordMessage({
            guild_id: 'G1',
            content: '<@SOMEONE_ELSE> hi',
            mentions: [{ id: 'SOMEONE_ELSE' }]
        }),
        baseConfig(),
        identity
    )
    assert.equal(otherBot?.isMention, false)
})

test('discord normalizeMessage strips the bot own mention markup', () => {
    const provider = new DiscordChannelProvider()
    const identity: TestIdentity = {
        botUserId: '111111111111111111',
        managedRoleIds: new Map([['G1', 'R_BOT']])
    }
    const userMention = normalize(
        provider,
        discordMessage({
            guild_id: 'G1',
            content: '<@111111111111111111> /help',
            mentions: [{ id: '111111111111111111' }]
        }),
        baseConfig(),
        identity
    )
    assert.equal(userMention?.text, '/help')
    assert.equal(userMention?.isMention, true)

    const roleMention = normalize(
        provider,
        discordMessage({
            guild_id: 'G1',
            content: '<@&R_BOT> /list 2',
            mention_roles: ['R_BOT']
        }),
        baseConfig(),
        identity
    )
    assert.equal(roleMention?.text, '/list 2')

    const otherUser = normalize(
        provider,
        discordMessage({
            guild_id: 'G1',
            content: '<@999999999999999999> hi',
            mentions: [{ id: '999999999999999999' }]
        }),
        baseConfig(),
        identity
    )
    assert.equal(otherUser?.text, '<@999999999999999999> hi')

    const bareMention = normalize(
        provider,
        discordMessage({
            guild_id: 'G1',
            content: '<@111111111111111111>',
            mentions: [{ id: '111111111111111111' }]
        }),
        baseConfig(),
        identity
    )
    assert.equal(bareMention, null)
})

const appCommandInteraction = (
    overrides: Record<string, unknown> = {}
): unknown => ({
    id: 'INT1',
    application_id: 'APP1',
    token: 'tok-secret',
    type: 2,
    data: { type: 1, name: 'help' },
    ...overrides
})

test('discord normalizeInteraction reconstructs a guild slash command', () => {
    const event = normalizeInteraction(
        appCommandInteraction({
            guild_id: 'G1',
            channel: { id: 'C1' },
            member: { nick: 'Bobby', user: { id: 'U1', username: 'bob' } },
            data: {
                type: 1,
                name: 'switch',
                options: [{ type: 3, name: 'target', value: '2' }]
            }
        }) as never
    )
    assert.ok(event)
    assert.equal(event?.text, '/switch 2')
    assert.equal(event?.chatId, 'G1:C1')
    assert.equal(event?.chatType, 'group')
    assert.equal(event?.senderId, 'U1')
    assert.equal(event?.senderName, 'Bobby')
    assert.equal(event?.isMention, true)
    assert.equal(event?.providerEventId, 'discord-interaction-INT1')
    const raw = event?.raw as Record<string, unknown>
    assert.equal(raw.commandName, 'switch')
    assert.equal('token' in raw, false)
})

test('discord normalizeInteraction handles DM commands and non-commands', () => {
    const dm = normalizeInteraction(
        appCommandInteraction({
            channel: { id: 'DM1' },
            user: { id: 'U9', username: 'zoe' },
            data: { type: 1, name: 'current' }
        }) as never
    )
    assert.equal(dm?.chatType, 'private')
    assert.equal(dm?.chatId, 'DM1')
    assert.equal(dm?.text, '/current')
    assert.equal(
        normalizeInteraction(appCommandInteraction({ type: 3 }) as never),
        null
    )
})

test('discord handleInteraction defers, forwards, and stashes a pending reply', async () => {
    const provider = new DiscordChannelProvider()
    const deferCalls: string[] = []
    const inbound: NormalizedInboundEvent[] = []
    const fakeApi = {
        interactions: {
            defer: async (id: string) => {
                deferCalls.push(id)
            },
            reply: async () => {}
        }
    }
    const ctx = {
        channel: makeChannel(),
        config: baseConfig(),
        credentials: makeCredentials()
    }
    const data = appCommandInteraction({
        guild_id: 'G1',
        channel: { id: 'C1' },
        member: { user: { id: 'U1', username: 'bob' } },
        data: { type: 1, name: 'list' }
    })
    await (
        provider as unknown as {
            handleInteraction: (
                ctx: unknown,
                config: DiscordChannelConfig,
                api: unknown,
                data: unknown,
                onInbound: (e: NormalizedInboundEvent) => Promise<void>
            ) => Promise<void>
        }
    ).handleInteraction(ctx, baseConfig(), fakeApi, data, async (e) => {
        inbound.push(e)
    })
    assert.deepEqual(deferCalls, ['INT1'])
    assert.equal(inbound.length, 1)
    assert.equal(inbound[0]?.text, '/list')
    const scopeKey = provider.computeScopeKey(
        inbound[0]!,
        baseConfig()
    ).scopeKey
    const pending = (
        provider as unknown as {
            pendingFor: (c: string) => Map<string, unknown>
        }
    ).pendingFor('chn-discord-1')
    assert.ok(pending.has(scopeKey))
})

test('discord handleInteraction rejects a disallowed guild without forwarding', async () => {
    const provider = new DiscordChannelProvider()
    const replies: Array<{ flags?: number }> = []
    const inbound: NormalizedInboundEvent[] = []
    let deferred = 0
    const fakeApi = {
        interactions: {
            defer: async () => {
                deferred += 1
            },
            reply: async (
                _id: string,
                _token: string,
                body: { flags?: number }
            ) => {
                replies.push(body)
            }
        }
    }
    const restricted = baseConfig({ allowedGuildIds: ['GX'] })
    const ctx = {
        channel: makeChannel(),
        config: restricted,
        credentials: makeCredentials()
    }
    const data = appCommandInteraction({
        guild_id: 'G1',
        channel: { id: 'C1' },
        member: { user: { id: 'U1', username: 'bob' } },
        data: { type: 1, name: 'help' }
    })
    await (
        provider as unknown as {
            handleInteraction: (
                ctx: unknown,
                config: DiscordChannelConfig,
                api: unknown,
                data: unknown,
                onInbound: (e: NormalizedInboundEvent) => Promise<void>
            ) => Promise<void>
        }
    ).handleInteraction(ctx, restricted, fakeApi, data, async (e) => {
        inbound.push(e)
    })
    assert.equal(replies.length, 1)
    assert.equal(replies[0]?.flags, 64)
    assert.equal(deferred, 0)
    assert.equal(inbound.length, 0)
})

test('discord sendText edits a pending interaction reply then falls back', async () => {
    const provider = new DiscordChannelProvider()
    const scopeKey = 'discord:guild:G1:channel:C1:user:U1'
    const setPending = (expiresAt: number) =>
        (
            provider as unknown as {
                pendingFor: (c: string) => Map<string, unknown>
            }
        )
            .pendingFor('chn-discord-1')
            .set(scopeKey, { applicationId: 'APP1', token: 'tok', expiresAt })
    const edits: Array<{ content: string }> = []
    const creates: Array<{ content: string }> = []
    const fakeApi = {
        interactions: {
            editReply: async (
                _appId: string,
                _token: string,
                body: { content: string }
            ) => {
                edits.push(body)
                return { id: 'edited-1' }
            }
        },
        channels: {
            createMessage: async (_cid: string, body: { content: string }) => {
                creates.push(body)
                return { id: `msg-${creates.length}` }
            }
        }
    }
    const internal = provider as unknown as { apiFor: () => unknown }
    const origApiFor = internal.apiFor
    internal.apiFor = () => fakeApi
    try {
        const ctx = {
            channel: makeChannel(),
            config: baseConfig(),
            credentials: makeCredentials()
        }
        setPending(Date.now() + 10_000)
        const first = await provider.sendText(ctx, scopeKey, 'done')
        assert.equal(first.providerMessageId, 'edited-1')
        assert.equal(edits.length, 1)
        assert.equal(creates.length, 0)

        const second = await provider.sendText(ctx, scopeKey, 'again')
        assert.equal(edits.length, 1)
        assert.equal(creates.length, 1)
        assert.equal(second.providerMessageId, 'msg-1')

        setPending(Date.now() - 1)
        await provider.sendText(ctx, scopeKey, 'expired')
        assert.equal(edits.length, 1)
        assert.equal(creates.length, 2)
    } finally {
        internal.apiFor = origApiFor
    }
})

test('discord register bulk-overwrites global slash commands', async () => {
    const provider = new DiscordChannelProvider()
    let overwrote: { appId: string; body: DiscordCommandBody } | null = null
    const fakeApi = {
        users: {
            getCurrent: async () => ({ id: 'BOT1', username: 'TestBot' })
        },
        applications: {
            getCurrent: async () => ({ id: 'APP1', flags: 1 << 18 })
        },
        applicationCommands: {
            bulkOverwriteGlobalCommands: async (
                appId: string,
                body: DiscordCommandBody
            ) => {
                overwrote = { appId, body }
                return body
            }
        }
    }
    const internal = provider as unknown as { apiFor: () => unknown }
    const origApiFor = internal.apiFor
    internal.apiFor = () => fakeApi
    try {
        const result = await provider.register({
            channel: makeChannel(),
            config: baseConfig(),
            credentials: makeCredentials()
        })
        assert.equal(result.ok, true)
        const capturedOverwrite = overwrote as {
            appId: string
            body: DiscordCommandBody
        } | null
        assert.ok(capturedOverwrite)
        assert.equal(capturedOverwrite.appId, 'APP1')
        assert.equal(capturedOverwrite.body.length, SLASH_COMMAND_SPECS.length)
        const byName = Object.fromEntries(
            capturedOverwrite.body.map((c) => [c.name, c])
        )
        assert.equal(byName.switch?.options?.[0]?.required, true)
        assert.equal(byName.delete?.options?.[0]?.required, true)
        assert.equal(byName.new?.options?.[0]?.required, false)
        assert.equal(byName.current?.options, undefined)
        assert.equal(byName.stop?.options, undefined)
        assert.equal(byName.help?.options, undefined)
    } finally {
        internal.apiFor = origApiFor
    }
})

test('discord register survives a command registration failure', async () => {
    const provider = new DiscordChannelProvider()
    const fakeApi = {
        users: {
            getCurrent: async () => ({ id: 'BOT1', username: 'TestBot' })
        },
        applications: {
            getCurrent: async () => ({ id: 'APP1', flags: 1 << 18 })
        },
        applicationCommands: {
            bulkOverwriteGlobalCommands: async () => {
                throw new Error('missing applications.commands scope')
            }
        }
    }
    const internal = provider as unknown as { apiFor: () => unknown }
    const origApiFor = internal.apiFor
    internal.apiFor = () => fakeApi
    try {
        const result = await provider.register({
            channel: makeChannel(),
            config: baseConfig(),
            credentials: makeCredentials()
        })
        assert.equal(result.ok, true)
        assert.match(result.message ?? '', /slash command registration failed/)
    } finally {
        internal.apiFor = origApiFor
    }
})

test('discord findBotManagedRoleId matches roles by bot or application id', () => {
    const roles = [
        { id: 'R1', tags: {} },
        { id: 'R2', tags: { bot_id: 'OTHER_APP' } },
        { id: 'R3', tags: { bot_id: 'BOT1' } }
    ] as never
    assert.equal(findBotManagedRoleId(roles, 'BOT1', null), 'R3')
    assert.equal(findBotManagedRoleId(roles, null, 'OTHER_APP'), 'R2')
    assert.equal(findBotManagedRoleId(roles, null, null), null)
    assert.equal(findBotManagedRoleId(undefined, 'BOT1', 'BOT1'), null)
})

test('discord test() reports MESSAGE_CONTENT intent disabled', async () => {
    const provider = new DiscordChannelProvider()
    const fakeApi = {
        users: {
            getCurrent: async () => ({
                id: 'BOT1',
                username: 'TestBot'
            })
        },
        applications: {
            getCurrent: async () => ({
                id: 'APP1',
                flags: 0
            })
        }
    }
    type Internal = {
        apiFor: () => unknown
    }
    const internal = provider as unknown as Internal
    const origApiFor = internal.apiFor
    internal.apiFor = () => fakeApi
    try {
        const result = await provider.test({
            channel: makeChannel(),
            config: baseConfig(),
            credentials: makeCredentials()
        })
        assert.equal(result.ok, false)
        assert.match(result.message, /MESSAGE_CONTENT intent disabled/)
        assert.match(result.message, /TestBot \(BOT1\)/)
    } finally {
        internal.apiFor = origApiFor
    }
})

test('discord test() reports OK when MESSAGE_CONTENT bit set', async () => {
    const provider = new DiscordChannelProvider()
    const fakeApi = {
        users: {
            getCurrent: async () => ({
                id: 'BOT1',
                username: 'TestBot'
            })
        },
        applications: {
            getCurrent: async () => ({
                id: 'APP1',
                flags: 1 << 18
            })
        }
    }
    type Internal = {
        apiFor: () => unknown
    }
    const internal = provider as unknown as Internal
    const origApiFor = internal.apiFor
    internal.apiFor = () => fakeApi
    try {
        const result = await provider.test({
            channel: makeChannel(),
            config: baseConfig(),
            credentials: makeCredentials()
        })
        assert.equal(result.ok, true)
        assert.match(result.message, /MESSAGE_CONTENT intent enabled/)
    } finally {
        internal.apiFor = origApiFor
    }
})

const discordAttachment = (
    overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
    id: 'A1',
    filename: 'pic.png',
    content_type: 'image/png',
    size: 1024,
    url: 'https://cdn.discordapp.com/attachments/1/2/pic.png',
    proxy_url: 'https://media.discordapp.net/attachments/1/2/pic.png',
    ...overrides
})

test('discord normalizeMessage maps own attachments to descriptors', () => {
    const provider = new DiscordChannelProvider()
    const identity: TestIdentity = {
        botUserId: null,
        managedRoleIds: new Map()
    }
    const event = normalize(
        provider,
        discordMessage({
            attachments: [
                discordAttachment(),
                discordAttachment({
                    id: 'A2',
                    filename: 'notes.txt',
                    content_type: 'text/plain',
                    size: 42,
                    url: 'https://cdn.discordapp.com/attachments/1/2/notes.txt'
                })
            ]
        }),
        baseConfig(),
        identity
    )
    assert.equal(event?.text, 'hello')
    assert.deepEqual(event?.attachments, [
        {
            url: 'https://cdn.discordapp.com/attachments/1/2/pic.png',
            name: 'pic.png',
            contentType: 'image/png',
            size: 1024
        },
        {
            url: 'https://cdn.discordapp.com/attachments/1/2/notes.txt',
            name: 'notes.txt',
            contentType: 'text/plain',
            size: 42
        }
    ])
})

test('discord normalizeMessage keeps attachment-only messages', () => {
    // A pure image message has empty content; before attachments existed it
    // was silently dropped, which is the exact gap this feature closes.
    const provider = new DiscordChannelProvider()
    const identity: TestIdentity = {
        botUserId: null,
        managedRoleIds: new Map()
    }
    const event = normalize(
        provider,
        discordMessage({
            content: '',
            attachments: [discordAttachment()]
        }),
        baseConfig(),
        identity
    )
    assert.notEqual(event, null)
    assert.equal(event?.text, '')
    assert.equal(event?.attachments?.length, 1)
})

test('discord normalizeMessage keeps bare bot mention with attachment', () => {
    const provider = new DiscordChannelProvider()
    const identity: TestIdentity = {
        botUserId: '111111111111111111',
        managedRoleIds: new Map()
    }
    const event = normalize(
        provider,
        discordMessage({
            guild_id: 'G1',
            content: '<@111111111111111111>',
            mentions: [{ id: '111111111111111111' }],
            attachments: [discordAttachment()]
        }),
        baseConfig(),
        identity
    )
    assert.equal(event?.text, '')
    assert.equal(event?.isMention, true)
    assert.equal(event?.attachments?.length, 1)
})

test('discord normalizeMessage still drops empty text without attachments', () => {
    const provider = new DiscordChannelProvider()
    const identity: TestIdentity = {
        botUserId: null,
        managedRoleIds: new Map()
    }
    const event = normalize(
        provider,
        discordMessage({ content: '   ' }),
        baseConfig(),
        identity
    )
    assert.equal(event, null)
})

test('discord normalizeMessage prepends reply context', () => {
    const provider = new DiscordChannelProvider()
    const identity: TestIdentity = {
        botUserId: null,
        managedRoleIds: new Map()
    }
    const event = normalize(
        provider,
        discordMessage({
            content: 'sure',
            referenced_message: {
                id: 'REF1',
                content: 'hey\ncan you check this?',
                author: { id: 'U2', username: 'alice', global_name: 'Alice' },
                attachments: []
            }
        }),
        baseConfig(),
        identity
    )
    assert.equal(
        event?.text,
        '[replying to Alice: hey can you check this?]\nsure'
    )
})

test('discord normalizeMessage truncates long reply context', () => {
    const provider = new DiscordChannelProvider()
    const identity: TestIdentity = {
        botUserId: null,
        managedRoleIds: new Map()
    }
    const event = normalize(
        provider,
        discordMessage({
            content: 'ok',
            referenced_message: {
                id: 'REF1',
                content: 'x'.repeat(600),
                author: { id: 'U2', username: 'alice', global_name: null },
                attachments: []
            }
        }),
        baseConfig(),
        identity
    )
    assert.ok(event)
    const firstLine = event.text.split('\n')[0] ?? ''
    assert.ok(firstLine.length <= '[replying to alice: ]'.length + 500)
    assert.match(firstLine, /…\]$/)
})

test('discord normalizeMessage pulls only images from the replied-to message', () => {
    const provider = new DiscordChannelProvider()
    const identity: TestIdentity = {
        botUserId: null,
        managedRoleIds: new Map()
    }
    const event = normalize(
        provider,
        discordMessage({
            content: 'what is in this?',
            attachments: [discordAttachment({ id: 'OWN' })],
            referenced_message: {
                id: 'REF1',
                content: '',
                author: { id: 'U2', username: 'alice', global_name: null },
                attachments: [
                    discordAttachment({
                        id: 'REFIMG',
                        filename: 'shot.png',
                        url: 'https://cdn.discordapp.com/attachments/9/9/shot.png'
                    }),
                    discordAttachment({
                        id: 'REFZIP',
                        filename: 'big.zip',
                        content_type: 'application/zip',
                        url: 'https://cdn.discordapp.com/attachments/9/9/big.zip'
                    })
                ]
            }
        }),
        baseConfig(),
        identity
    )
    assert.equal(event?.text, '[replying to alice]\nwhat is in this?')
    assert.deepEqual(
        event?.attachments?.map((a) => a.name),
        ['pic.png', 'shot.png']
    )
})

test('discord normalizeMessage skips reply prefix for slash commands', () => {
    const provider = new DiscordChannelProvider()
    const identity: TestIdentity = {
        botUserId: null,
        managedRoleIds: new Map()
    }
    const event = normalize(
        provider,
        discordMessage({
            content: '/list 2',
            referenced_message: {
                id: 'REF1',
                content: 'earlier reply',
                author: { id: 'U2', username: 'alice', global_name: null },
                attachments: []
            }
        }),
        baseConfig(),
        identity
    )
    assert.equal(event?.text, '/list 2')
})

test('discord normalizeMessage ignores a null referenced message', () => {
    const provider = new DiscordChannelProvider()
    const identity: TestIdentity = {
        botUserId: null,
        managedRoleIds: new Map()
    }
    const event = normalize(
        provider,
        discordMessage({ content: 'hi', referenced_message: null }),
        baseConfig(),
        identity
    )
    assert.equal(event?.text, 'hi')
})

test('discord validateConfig parses autoThread and activity progress mode', () => {
    const provider = new DiscordChannelProvider()
    const defaults = provider.validateConfig({})
    assert.equal(defaults.autoThread, false)
    assert.equal(defaults.progressMode, 'preview')
    const enabled = provider.validateConfig({
        autoThread: true,
        progressMode: 'activity'
    })
    assert.equal(enabled.autoThread, true)
    assert.equal(enabled.progressMode, 'activity')
    const junk = provider.validateConfig({
        autoThread: 'yes',
        progressMode: 'cards'
    })
    assert.equal(junk.autoThread, false)
    assert.equal(junk.progressMode, 'preview')
})

test('discord computeScopeKey: thread isolation scopes by thread', () => {
    const provider = new DiscordChannelProvider()
    const event: NormalizedInboundEvent = {
        providerEventId: 'discord-t1',
        chatId: 'G1:C1',
        chatType: 'group',
        senderId: 'U2',
        senderName: 'Bob',
        text: 'yo',
        threadId: 'T1',
        isMention: true,
        raw: {}
    }
    const isolated = provider.computeScopeKey(event, baseConfig())
    assert.equal(isolated.scopeKey, 'discord:guild:G1:channel:C1:thread:T1')
    const flat = provider.computeScopeKey(
        event,
        baseConfig({ threadIsolation: false })
    )
    assert.equal(flat.scopeKey, 'discord:guild:G1:channel:C1:user:U2')
})

const normalizeWithThread = (
    provider: DiscordChannelProvider,
    data: unknown,
    config: DiscordChannelConfig,
    identity: TestIdentity,
    threadParentId: string | null
): NormalizedInboundEvent | null =>
    (
        provider as unknown as {
            normalizeMessage: (
                data: unknown,
                config: DiscordChannelConfig,
                identity: TestIdentity,
                threadParentId: string | null
            ) => NormalizedInboundEvent | null
        }
    ).normalizeMessage(data, config, identity, threadParentId)

test('discord normalizeMessage keys thread messages by parent channel', () => {
    const provider = new DiscordChannelProvider()
    const identity: TestIdentity = {
        botUserId: null,
        managedRoleIds: new Map()
    }
    const inThread = normalizeWithThread(
        provider,
        discordMessage({ guild_id: 'G1', channel_id: 'T1' }),
        baseConfig(),
        identity,
        'C1'
    )
    assert.equal(inThread?.chatId, 'G1:C1')
    assert.equal(inThread?.threadId, 'T1')

    const notThread = normalizeWithThread(
        provider,
        discordMessage({ guild_id: 'G1' }),
        baseConfig(),
        identity,
        null
    )
    assert.equal(notThread?.chatId, 'G1:C1')
    assert.equal(notThread?.threadId, null)
})

interface ThreadParentInternal {
    threadParentFor: (
        ctx: unknown,
        api: unknown,
        discordChannelId: string
    ) => Promise<string | null>
}

test('discord threadParentFor caches lookups but not failures', async () => {
    const provider = new DiscordChannelProvider()
    const ctx = {
        channel: makeChannel(),
        config: baseConfig(),
        credentials: makeCredentials()
    }
    let calls = 0
    const fakeApi = {
        channels: {
            get: async () => {
                calls += 1
                return { id: 'T1', type: 11, parent_id: 'C1' }
            }
        }
    }
    const internal = provider as unknown as ThreadParentInternal
    assert.equal(await internal.threadParentFor(ctx, fakeApi, 'T1'), 'C1')
    assert.equal(await internal.threadParentFor(ctx, fakeApi, 'T1'), 'C1')
    assert.equal(calls, 1)

    let failCalls = 0
    const failingApi = {
        channels: {
            get: async () => {
                failCalls += 1
                if (failCalls === 1) throw new Error('rest down')
                return { id: 'T2', type: 11, parent_id: 'C1' }
            }
        }
    }
    assert.equal(await internal.threadParentFor(ctx, failingApi, 'T2'), null)
    assert.equal(await internal.threadParentFor(ctx, failingApi, 'T2'), 'C1')
    assert.equal(failCalls, 2)
})

test('discord sendText posts into the thread for thread scope keys', async () => {
    const provider = new DiscordChannelProvider()
    const calls: Array<{ channelId: string }> = []
    const fakeApi = {
        channels: {
            createMessage: async (channelId: string) => {
                calls.push({ channelId })
                return { id: `msg-${calls.length}` }
            }
        }
    }
    const internal = provider as unknown as { apiFor: () => unknown }
    const origApiFor = internal.apiFor
    internal.apiFor = () => fakeApi
    try {
        await provider.sendText(
            {
                channel: makeChannel(),
                config: baseConfig(),
                credentials: makeCredentials()
            },
            'discord:guild:G1:channel:C1:thread:T9',
            'into the thread'
        )
        assert.equal(calls[0]?.channelId, 'T9')
    } finally {
        internal.apiFor = origApiFor
    }
})

interface HandleMessageInternal {
    handleMessage: (
        ctx: unknown,
        config: DiscordChannelConfig,
        api: unknown,
        identity: TestIdentity,
        dmEntries: Map<string, { channelId: string }>,
        data: unknown,
        onInbound: (event: NormalizedInboundEvent) => Promise<void>
    ) => Promise<void>
}

const driveHandleMessage = async (opts: {
    config: DiscordChannelConfig
    data: unknown
    channelGet?: () => Promise<unknown>
    createThread?: (
        channelId: string,
        body: { name: string; auto_archive_duration: number },
        messageId: string
    ) => Promise<unknown>
}): Promise<{
    events: NormalizedInboundEvent[]
    createThreadCalls: Array<{
        channelId: string
        name: string
        messageId: string
    }>
}> => {
    const provider = new DiscordChannelProvider()
    const events: NormalizedInboundEvent[] = []
    const createThreadCalls: Array<{
        channelId: string
        name: string
        messageId: string
    }> = []
    const fakeApi = {
        channels: {
            get:
                opts.channelGet ??
                (async () => ({ id: 'C1', type: 0, parent_id: null })),
            createThread: async (
                channelId: string,
                body: { name: string; auto_archive_duration: number },
                messageId: string
            ) => {
                createThreadCalls.push({
                    channelId,
                    name: body.name,
                    messageId
                })
                if (opts.createThread)
                    return opts.createThread(channelId, body, messageId)
                return { id: 'T_NEW' }
            }
        }
    }
    const ctx = {
        channel: makeChannel(),
        config: opts.config,
        credentials: makeCredentials()
    }
    const identity: TestIdentity = {
        botUserId: '111111111111111111',
        managedRoleIds: new Map()
    }
    await (provider as unknown as HandleMessageInternal).handleMessage(
        ctx,
        opts.config,
        fakeApi,
        identity,
        new Map(),
        opts.data,
        async (event) => {
            events.push(event)
        }
    )
    return { events, createThreadCalls }
}

test('discord autoThread creates a public thread from the triggering message', async () => {
    const { events, createThreadCalls } = await driveHandleMessage({
        config: baseConfig({ autoThread: true }),
        data: discordMessage({
            guild_id: 'G1',
            content: '<@111111111111111111> please investigate this failure',
            mentions: [{ id: '111111111111111111' }]
        })
    })
    assert.equal(createThreadCalls.length, 1)
    assert.equal(createThreadCalls[0]?.channelId, 'C1')
    assert.equal(createThreadCalls[0]?.messageId, 'MSG1')
    assert.equal(createThreadCalls[0]?.name, 'please investigate this failure')
    assert.equal(events[0]?.threadId, 'T_NEW')
    assert.equal(events[0]?.chatId, 'G1:C1')
})

test('discord autoThread truncates long thread names', async () => {
    const longText = `<@111111111111111111> ${'x'.repeat(200)}`
    const { createThreadCalls } = await driveHandleMessage({
        config: baseConfig({ autoThread: true }),
        data: discordMessage({
            guild_id: 'G1',
            content: longText,
            mentions: [{ id: '111111111111111111' }]
        })
    })
    const name = createThreadCalls[0]?.name ?? ''
    assert.ok(name.length <= 91)
    assert.match(name, /…$/)
})

test('discord autoThread skips ineligible messages', async () => {
    const mentioned = (content: string) =>
        discordMessage({
            guild_id: 'G1',
            content,
            mentions: [{ id: '111111111111111111' }]
        })

    const alreadyThreaded = await driveHandleMessage({
        config: baseConfig({ autoThread: true }),
        data: mentioned('<@111111111111111111> hi'),
        channelGet: async () => ({ id: 'T1', type: 11, parent_id: 'C1' })
    })
    assert.equal(alreadyThreaded.createThreadCalls.length, 0)
    assert.equal(alreadyThreaded.events[0]?.threadId, 'C1')

    const dm = await driveHandleMessage({
        config: baseConfig({ autoThread: true }),
        data: discordMessage({ content: 'hi' })
    })
    assert.equal(dm.createThreadCalls.length, 0)

    const noMention = await driveHandleMessage({
        config: baseConfig({ autoThread: true }),
        data: discordMessage({ guild_id: 'G1', content: 'no mention here' })
    })
    assert.equal(noMention.createThreadCalls.length, 0)

    const slash = await driveHandleMessage({
        config: baseConfig({ autoThread: true }),
        data: mentioned('<@111111111111111111> /list 2')
    })
    assert.equal(slash.createThreadCalls.length, 0)

    const disabled = await driveHandleMessage({
        config: baseConfig(),
        data: mentioned('<@111111111111111111> hi')
    })
    assert.equal(disabled.createThreadCalls.length, 0)

    const noIsolation = await driveHandleMessage({
        config: baseConfig({ autoThread: true, threadIsolation: false }),
        data: mentioned('<@111111111111111111> hi')
    })
    assert.equal(noIsolation.createThreadCalls.length, 0)
})

test('discord autoThread falls back to the channel when creation fails', async () => {
    const { events } = await driveHandleMessage({
        config: baseConfig({ autoThread: true }),
        data: discordMessage({
            guild_id: 'G1',
            content: '<@111111111111111111> hi',
            mentions: [{ id: '111111111111111111' }]
        }),
        createThread: async () => {
            throw new Error('Missing Permissions')
        }
    })
    assert.equal(events.length, 1)
    assert.equal(events[0]?.threadId, null)
    assert.equal(events[0]?.chatId, 'G1:C1')
})

test('discord normalizeInteraction detects thread channels inline', () => {
    const event = normalizeInteraction(
        appCommandInteraction({
            guild_id: 'G1',
            channel: { id: 'T1', type: 11, parent_id: 'C1' },
            member: { user: { id: 'U1', username: 'bob' } },
            data: { type: 1, name: 'current' }
        }) as never
    )
    assert.equal(event?.chatId, 'G1:C1')
    assert.equal(event?.threadId, 'T1')
})

test('discord startTyping fires immediately and stop is idempotent', async () => {
    const provider = new DiscordChannelProvider()
    let typingCalls = 0
    const fakeApi = {
        channels: {
            showTyping: async () => {
                typingCalls += 1
            }
        }
    }
    const internal = provider as unknown as { apiFor: () => unknown }
    const origApiFor = internal.apiFor
    internal.apiFor = () => fakeApi
    try {
        const stop = await provider.startTyping(
            {
                channel: makeChannel(),
                config: baseConfig(),
                credentials: makeCredentials()
            },
            'discord:guild:G1:channel:C1:thread:T9'
        )
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(typingCalls, 1)
        stop()
        stop()
        await new Promise((resolve) => setImmediate(resolve))
        assert.equal(typingCalls, 1)
    } finally {
        internal.apiFor = origApiFor
    }
})

// --- history backfill ---

interface FakeMsgSpec {
    id: string
    authorId: string
    username?: string
    globalName?: string | null
    bot?: boolean
    content?: string
    attachments?: unknown[]
    type?: number
    referencedMessage?: Record<string, unknown> | null
}

const BOT_ID = '111111111111111111'

const fakeMsg = (m: FakeMsgSpec): Record<string, unknown> => ({
    id: m.id,
    type: m.type ?? 0,
    content: m.content ?? '',
    attachments: m.attachments ?? [],
    author: {
        id: m.authorId,
        username: m.username ?? 'user',
        global_name: m.globalName ?? null,
        bot: m.bot ?? false
    },
    ...(m.referencedMessage !== undefined
        ? { referenced_message: m.referencedMessage }
        : {})
})

interface HistoryApiOpts {
    messages?: Array<Record<string, unknown>>
    getMessagesError?: Error
    createId?: string
    editSucceeds?: boolean
    onGetMessages?: (channelId: string, query: unknown) => void
}

const makeHistoryApi = (opts: HistoryApiOpts = {}) => {
    let called = false
    let getMessagesCount = 0
    const api = {
        channels: {
            getMessages: async (channelId: string, query: unknown) => {
                called = true
                getMessagesCount += 1
                opts.onGetMessages?.(channelId, query)
                if (opts.getMessagesError) throw opts.getMessagesError
                return opts.messages ?? []
            },
            createMessage: async () => ({ id: opts.createId ?? 'gen-1' }),
            editMessage: async () => {
                if (opts.editSucceeds === false) throw new Error('edit failed')
                return { id: 'edited' }
            }
        }
    }
    return {
        api,
        get called() {
            return called
        },
        get getMessagesCount() {
            return getMessagesCount
        }
    }
}

const textOf = (history: { text: string } | null): string | null =>
    history?.text ?? null

const historyCtx = (config = baseConfig()) => ({
    channel: makeChannel({ id: 'chn-hist' }),
    config,
    credentials: makeCredentials()
})

const historyEvent = (
    overrides: Partial<NormalizedInboundEvent> = {}
): NormalizedInboundEvent => ({
    providerEventId: 'discord-5000',
    chatId: '100:200',
    chatType: 'group',
    senderId: '300',
    senderName: 'Trigger',
    text: 'summarize',
    threadId: null,
    isMention: true,
    raw: { id: '5000' },
    ...overrides
})

const CHANNEL_SCOPE = 'discord:guild:100:channel:200:user:300'

const withApi = async <T>(
    provider: DiscordChannelProvider,
    api: unknown,
    fn: () => Promise<T>
): Promise<T> => {
    const internal = provider as unknown as { apiFor: () => unknown }
    const orig = internal.apiFor
    internal.apiFor = () => api
    try {
        return await fn()
    } finally {
        internal.apiFor = orig
    }
}

test('discord backfill returns messages after the bot boundary, chronological', async () => {
    const provider = new DiscordChannelProvider()
    const fake = makeHistoryApi({
        messages: [
            fakeMsg({
                id: '4002',
                authorId: '300',
                username: 'alice',
                content: 'second human'
            }),
            fakeMsg({
                id: '4001',
                authorId: '301',
                username: 'bob',
                content: 'first human'
            }),
            fakeMsg({ id: '4000', authorId: BOT_ID, content: 'old reply' }),
            fakeMsg({
                id: '3999',
                authorId: '300',
                username: 'alice',
                content: 'ancient'
            })
        ]
    })
    const block = textOf(
        await withApi(provider, fake.api, () =>
            provider.fetchHistoryContext(historyCtx(), historyEvent(), {
                scopeKey: CHANNEL_SCOPE,
                limit: 50
            })
        )
    )
    assert.ok(block)
    assert.match(block, /\[Recent channel messages\]/)
    assert.match(block, /Backfilled messages are background context/)
    // chronological: bob's "first human" precedes alice's "second human"
    const bobIdx = block.indexOf('[bob] first human')
    const aliceIdx = block.indexOf('[alice] second human')
    assert.ok(bobIdx >= 0 && aliceIdx > bobIdx)
    assert.doesNotMatch(block, /old reply/)
    assert.doesNotMatch(block, /ancient/)
})

test('discord backfill asks getMessages for the page before the trigger', async () => {
    const provider = new DiscordChannelProvider()
    let seenQuery: Record<string, unknown> | null = null
    const fake = makeHistoryApi({
        messages: [fakeMsg({ id: '4900', authorId: '300', content: 'hi' })],
        onGetMessages: (_c, q) => {
            seenQuery = q as Record<string, unknown>
        }
    })
    await withApi(provider, fake.api, () =>
        provider.fetchHistoryContext(historyCtx(), historyEvent(), {
            scopeKey: CHANNEL_SCOPE,
            limit: 37
        })
    )
    assert.deepEqual(seenQuery, { before: '5000', limit: 37 })
})

test('discord backfill skips non-conversational bot ids but breaks at conversational ones', async () => {
    const provider = new DiscordChannelProvider()
    const fake = makeHistoryApi({ createId: '4500' })
    await withApi(provider, fake.api, () =>
        provider.sendText(historyCtx(), CHANNEL_SCOPE, 'slash reply', {
            nonConversational: true
        })
    )
    const fake2 = makeHistoryApi({
        messages: [
            fakeMsg({
                id: '4600',
                authorId: '300',
                username: 'alice',
                content: 'newer'
            }),
            fakeMsg({ id: '4500', authorId: BOT_ID, content: 'slash reply' }),
            fakeMsg({
                id: '4400',
                authorId: '300',
                username: 'alice',
                content: 'middle'
            }),
            fakeMsg({ id: '4000', authorId: BOT_ID, content: 'real reply' }),
            fakeMsg({ id: '3000', authorId: '300', content: 'ancient' })
        ]
    })
    const block = textOf(
        await withApi(provider, fake2.api, () =>
            provider.fetchHistoryContext(historyCtx(), historyEvent(), {
                scopeKey: CHANNEL_SCOPE,
                limit: 50
            })
        )
    )
    assert.ok(block)
    assert.match(block, /newer/)
    assert.match(block, /middle/)
    assert.doesNotMatch(block, /slash reply/)
    assert.doesNotMatch(block, /ancient/)
})

test('discord backfill cutoff narrows to messages after the last reply', async () => {
    const provider = new DiscordChannelProvider()
    await withApi(provider, makeHistoryApi({ createId: '4400' }).api, () =>
        provider.sendText(historyCtx(), CHANNEL_SCOPE, 'prior reply')
    )
    const fake = makeHistoryApi({
        messages: [
            fakeMsg({ id: '4600', authorId: '300', content: 'after' }),
            fakeMsg({ id: '4500', authorId: '300', content: 'after2' }),
            fakeMsg({ id: '4200', authorId: '300', content: 'before boundary' })
        ]
    })
    const block = textOf(
        await withApi(provider, fake.api, () =>
            provider.fetchHistoryContext(historyCtx(), historyEvent(), {
                scopeKey: CHANNEL_SCOPE,
                limit: 50
            })
        )
    )
    assert.ok(block)
    assert.match(block, /after/)
    assert.match(block, /after2/)
    assert.doesNotMatch(block, /before boundary/)
})

test('discord backfill ignores a boundary newer than the trigger (stale cache)', async () => {
    const provider = new DiscordChannelProvider()
    await withApi(provider, makeHistoryApi({ createId: '6000' }).api, () =>
        provider.sendText(historyCtx(), CHANNEL_SCOPE, 'future reply')
    )
    const fake = makeHistoryApi({
        messages: [
            fakeMsg({ id: '4900', authorId: '300', content: 'kept' }),
            fakeMsg({ id: '4000', authorId: BOT_ID, content: 'reply' })
        ]
    })
    const block = textOf(
        await withApi(provider, fake.api, () =>
            provider.fetchHistoryContext(historyCtx(), historyEvent(), {
                scopeKey: CHANNEL_SCOPE,
                limit: 50
            })
        )
    )
    assert.ok(block)
    assert.match(block, /kept/)
})

test('discord backfill skips other bots and system messages without stopping', async () => {
    const provider = new DiscordChannelProvider()
    const fake = makeHistoryApi({
        messages: [
            fakeMsg({
                id: '4900',
                authorId: '300',
                username: 'alice',
                content: 'real'
            }),
            fakeMsg({
                id: '4800',
                authorId: '999',
                bot: true,
                content: 'bot noise'
            }),
            fakeMsg({
                id: '4700',
                authorId: '300',
                type: 7,
                content: 'joined'
            }),
            fakeMsg({ id: '4000', authorId: BOT_ID, content: 'reply' })
        ]
    })
    const block = textOf(
        await withApi(provider, fake.api, () =>
            provider.fetchHistoryContext(historyCtx(), historyEvent(), {
                scopeKey: CHANNEL_SCOPE,
                limit: 50
            })
        )
    )
    assert.ok(block)
    assert.match(block, /real/)
    assert.doesNotMatch(block, /bot noise/)
    assert.doesNotMatch(block, /joined/)
})

test('discord backfill truncates long lines and labels attachment-only messages', async () => {
    const provider = new DiscordChannelProvider()
    const fake = makeHistoryApi({
        messages: [
            fakeMsg({
                id: '4900',
                authorId: '300',
                username: 'alice',
                content: 'x'.repeat(600)
            }),
            fakeMsg({
                id: '4800',
                authorId: '301',
                username: 'bob',
                content: '',
                attachments: [{ url: 'http://x/pic.png', filename: 'pic.png' }]
            })
        ]
    })
    const block = textOf(
        await withApi(provider, fake.api, () =>
            provider.fetchHistoryContext(historyCtx(), historyEvent(), {
                scopeKey: CHANNEL_SCOPE,
                limit: 50
            })
        )
    )
    assert.ok(block)
    // No anonymous "(attachment)" placeholder: the label carries author,
    // source message and filename.
    assert.doesNotMatch(block, /\(attachment\)/)
    assert.match(
        block,
        /\[historical attachment from bob, message 4800: pic\.png\]/
    )
    const longLine = block.split('\n').find((l) => l.startsWith('[alice]'))
    assert.ok(longLine && longLine.length <= '[alice] '.length + 500)
    assert.ok(longLine?.endsWith('…'))
})

test('discord backfill drops oldest lines past the total budget', async () => {
    const provider = new DiscordChannelProvider()
    const messages = []
    // newest-first: id 5000-i, content marks recency
    for (let i = 0; i < 40; i += 1)
        messages.push(
            fakeMsg({
                id: String(4900 - i),
                authorId: '300',
                username: 'alice',
                content: `${i === 0 ? 'NEWEST' : i === 39 ? 'OLDEST' : 'mid'} ${'y'.repeat(480)}`
            })
        )
    const fake = makeHistoryApi({ messages })
    const block = textOf(
        await withApi(provider, fake.api, () =>
            provider.fetchHistoryContext(historyCtx(), historyEvent(), {
                scopeKey: CHANNEL_SCOPE,
                limit: 50
            })
        )
    )
    assert.ok(block)
    assert.ok(block.length <= 6500)
    assert.match(block, /NEWEST/)
    assert.doesNotMatch(block, /OLDEST/)
})

test('discord backfill fails open when getMessages throws', async () => {
    const provider = new DiscordChannelProvider()
    const fake = makeHistoryApi({
        getMessagesError: new Error('403 Forbidden')
    })
    const block = textOf(
        await withApi(provider, fake.api, () =>
            provider.fetchHistoryContext(historyCtx(), historyEvent(), {
                scopeKey: CHANNEL_SCOPE,
                limit: 50
            })
        )
    )
    assert.equal(block, null)
})

test('discord backfill returns null and skips the fetch for ineligible events', async () => {
    const provider = new DiscordChannelProvider()
    const cases: Array<{
        label: string
        config?: DiscordChannelConfig
        event: NormalizedInboundEvent
    }> = [
        { label: 'dm', event: historyEvent({ chatType: 'private' }) },
        { label: 'fresh thread', event: historyEvent({ threadFresh: true }) },
        {
            label: 'mentionOnly off, no thread',
            config: baseConfig({ mentionOnly: false }),
            event: historyEvent()
        },
        {
            label: 'no bot id',
            config: baseConfig({ botUserId: null }),
            event: historyEvent()
        },
        {
            label: 'non-snowflake trigger',
            event: historyEvent({
                providerEventId: 'discord-abc',
                raw: { id: 'abc' }
            })
        }
    ]
    for (const c of cases) {
        const fake = makeHistoryApi({
            messages: [fakeMsg({ id: '4900', authorId: '300', content: 'x' })]
        })
        const block = textOf(
            await withApi(provider, fake.api, () =>
                provider.fetchHistoryContext(historyCtx(c.config), c.event, {
                    scopeKey: CHANNEL_SCOPE,
                    limit: 50
                })
            )
        )
        assert.equal(block, null, `${c.label} should return null`)
        assert.equal(fake.called, false, `${c.label} should not fetch`)
    }
})

test('discord backfill returns null on an empty page', async () => {
    const provider = new DiscordChannelProvider()
    const fake = makeHistoryApi({ messages: [] })
    const block = textOf(
        await withApi(provider, fake.api, () =>
            provider.fetchHistoryContext(historyCtx(), historyEvent(), {
                scopeKey: CHANNEL_SCOPE,
                limit: 50
            })
        )
    )
    assert.equal(block, null)
})

test('discord backfill treats a live preview as a boundary only after finishPreview', async () => {
    const provider = new DiscordChannelProvider()
    const previewApi = makeHistoryApi({ createId: '4500', editSucceeds: true })
    const handle = await withApi(provider, previewApi.api, () =>
        provider.sendPreviewStart(historyCtx(), CHANNEL_SCOPE)
    )
    const page = [
        fakeMsg({
            id: '4600',
            authorId: '300',
            username: 'alice',
            content: 'newer'
        }),
        fakeMsg({ id: '4500', authorId: BOT_ID, content: 'thinking' }),
        fakeMsg({
            id: '4400',
            authorId: '300',
            username: 'alice',
            content: 'middle'
        }),
        fakeMsg({ id: '4000', authorId: BOT_ID, content: 'reply' })
    ]
    const before = textOf(
        await withApi(provider, makeHistoryApi({ messages: page }).api, () =>
            provider.fetchHistoryContext(historyCtx(), historyEvent(), {
                scopeKey: CHANNEL_SCOPE,
                limit: 50
            })
        )
    )
    assert.ok(before)
    assert.match(before, /newer/)
    assert.match(before, /middle/)

    await withApi(provider, previewApi.api, () =>
        provider.finishPreview(historyCtx(), handle, 'final answer')
    )
    const after = textOf(
        await withApi(provider, makeHistoryApi({ messages: page }).api, () =>
            provider.fetchHistoryContext(historyCtx(), historyEvent(), {
                scopeKey: CHANNEL_SCOPE,
                limit: 50
            })
        )
    )
    assert.ok(after)
    assert.match(after, /newer/)
    assert.doesNotMatch(after, /middle/)
})

// --- thread starter message (thread created from a channel message) ---

const THREAD_SCOPE = 'discord:guild:100:channel:200:thread:900'

const threadEvent = (): NormalizedInboundEvent =>
    historyEvent({ threadId: '900' })

const starterMsg = (
    referencedMessage: Record<string, unknown> | null,
    authorId = '400'
): Record<string, unknown> =>
    fakeMsg({ id: '900', authorId, type: 21, referencedMessage })

test('discord backfill surfaces the thread starter on the first mention', async () => {
    const provider = new DiscordChannelProvider()
    const fake = makeHistoryApi({
        messages: [
            starterMsg(
                fakeMsg({
                    id: '900',
                    authorId: '400',
                    username: 'alice',
                    content: 'original topic'
                })
            )
        ]
    })
    const block = textOf(
        await withApi(provider, fake.api, () =>
            provider.fetchHistoryContext(historyCtx(), threadEvent(), {
                scopeKey: THREAD_SCOPE,
                limit: 50
            })
        )
    )
    assert.ok(block)
    assert.match(block, /\[thread started from alice: original topic\]/)
})

test('discord backfill puts the starter line before the thread chatter', async () => {
    const provider = new DiscordChannelProvider()
    const fake = makeHistoryApi({
        messages: [
            fakeMsg({
                id: '4600',
                authorId: '301',
                username: 'bob',
                content: 'follow-up'
            }),
            starterMsg(
                fakeMsg({
                    id: '900',
                    authorId: '400',
                    username: 'alice',
                    content: 'original topic'
                })
            )
        ]
    })
    const block = textOf(
        await withApi(provider, fake.api, () =>
            provider.fetchHistoryContext(historyCtx(), threadEvent(), {
                scopeKey: THREAD_SCOPE,
                limit: 50
            })
        )
    )
    assert.ok(block)
    const starterIdx = block.indexOf(
        '[thread started from alice: original topic]'
    )
    const chatterIdx = block.indexOf('[bob] follow-up')
    assert.ok(starterIdx >= 0 && chatterIdx > starterIdx)
})

test('discord backfill skips a starter whose source message was deleted', async () => {
    const provider = new DiscordChannelProvider()
    const fake = makeHistoryApi({ messages: [starterMsg(null)] })
    const block = textOf(
        await withApi(provider, fake.api, () =>
            provider.fetchHistoryContext(historyCtx(), threadEvent(), {
                scopeKey: THREAD_SCOPE,
                limit: 50
            })
        )
    )
    assert.equal(block, null)
})

test('discord backfill keeps scanning past a bot-authored starter wrapper', async () => {
    const provider = new DiscordChannelProvider()
    const fake = makeHistoryApi({
        messages: [
            fakeMsg({
                id: '4600',
                authorId: '301',
                username: 'bob',
                content: 'thread talk'
            }),
            starterMsg(
                fakeMsg({
                    id: '900',
                    authorId: BOT_ID,
                    username: 'TestBot',
                    bot: true,
                    content: 'bot announcement'
                }),
                BOT_ID
            )
        ]
    })
    const block = textOf(
        await withApi(provider, fake.api, () =>
            provider.fetchHistoryContext(historyCtx(), threadEvent(), {
                scopeKey: THREAD_SCOPE,
                limit: 50
            })
        )
    )
    assert.ok(block)
    assert.match(block, /\[bob\] thread talk/)
    assert.match(block, /\[thread started from TestBot: bot announcement\]/)
})

test('discord backfill does not re-inject the starter once the bot replied in-thread', async () => {
    const provider = new DiscordChannelProvider()
    const fake = makeHistoryApi({
        messages: [
            fakeMsg({
                id: '4600',
                authorId: '301',
                username: 'bob',
                content: 'newer ask'
            }),
            fakeMsg({
                id: '4500',
                authorId: BOT_ID,
                content: 'first turn reply'
            }),
            starterMsg(
                fakeMsg({
                    id: '900',
                    authorId: '400',
                    username: 'alice',
                    content: 'original topic'
                })
            )
        ]
    })
    const block = textOf(
        await withApi(provider, fake.api, () =>
            provider.fetchHistoryContext(historyCtx(), threadEvent(), {
                scopeKey: THREAD_SCOPE,
                limit: 50
            })
        )
    )
    assert.ok(block)
    assert.match(block, /newer ask/)
    assert.doesNotMatch(block, /original topic/)
    assert.doesNotMatch(block, /first turn reply/)
})

// --- history attachments (issue #545) ---

test('discord backfill returns history attachment descriptors with provenance', async () => {
    const provider = new DiscordChannelProvider()
    const fake = makeHistoryApi({
        messages: [
            fakeMsg({
                id: '4900',
                authorId: '300',
                username: 'zack',
                content: 'bug description',
                attachments: [
                    {
                        url: 'http://x/shot.png',
                        filename: 'shot.png',
                        content_type: 'image/png',
                        size: 1234
                    }
                ]
            })
        ]
    })
    const history = await withApi(provider, fake.api, () =>
        provider.fetchHistoryContext(historyCtx(), historyEvent(), {
            scopeKey: CHANNEL_SCOPE,
            limit: 50
        })
    )
    assert.ok(history)
    assert.deepEqual(history.attachments, [
        {
            url: 'http://x/shot.png',
            name: 'shot.png',
            contentType: 'image/png',
            size: 1234,
            authorName: 'zack',
            providerMessageId: '4900'
        }
    ])
    // The content line and its attachment label stay adjacent, in order.
    assert.match(
        history.text,
        /\[zack\] bug description\n\[historical attachment from zack, message 4900: shot\.png\]/
    )
})

test('discord backfill orders starter attachments ahead of newer history attachments', async () => {
    const provider = new DiscordChannelProvider()
    const fake = makeHistoryApi({
        messages: [
            fakeMsg({
                id: '4600',
                authorId: '301',
                username: 'bob',
                content: 'follow-up',
                attachments: [
                    { url: 'http://x/late.png', filename: 'late.png' }
                ]
            }),
            starterMsg(
                fakeMsg({
                    id: '900',
                    authorId: '400',
                    username: 'alice',
                    content: 'original topic',
                    attachments: [
                        { url: 'http://x/topic.png', filename: 'topic.png' }
                    ]
                })
            )
        ]
    })
    const history = await withApi(provider, fake.api, () =>
        provider.fetchHistoryContext(historyCtx(), threadEvent(), {
            scopeKey: THREAD_SCOPE,
            limit: 50
        })
    )
    assert.ok(history)
    // Starter first despite being the oldest message: it wins the bridge's
    // bounded materialization slots.
    assert.deepEqual(
        history.attachments?.map((a) => a.name),
        ['topic.png', 'late.png']
    )
    assert.equal(history.attachments?.[0]?.providerMessageId, '900')
    assert.match(
        history.text,
        /\[thread started from alice: original topic\]\n\[historical attachment from alice, message 900: topic\.png\]/
    )
})

test('discord backfill labels a content-less starter that carries attachments', async () => {
    const provider = new DiscordChannelProvider()
    const fake = makeHistoryApi({
        messages: [
            starterMsg(
                fakeMsg({
                    id: '900',
                    authorId: '400',
                    username: 'alice',
                    content: '',
                    attachments: [
                        { url: 'http://x/only.png', filename: 'only.png' }
                    ]
                })
            )
        ]
    })
    const history = await withApi(provider, fake.api, () =>
        provider.fetchHistoryContext(historyCtx(), threadEvent(), {
            scopeKey: THREAD_SCOPE,
            limit: 50
        })
    )
    assert.ok(history)
    assert.equal(history.attachments?.length, 1)
    assert.match(
        history.text,
        /\[thread started from alice\]\n\[historical attachment from alice, message 900: only\.png\]/
    )
    assert.doesNotMatch(history.text, /\(attachment\)/)
})

test('discord backfill does not collect attachments behind the bot boundary', async () => {
    const provider = new DiscordChannelProvider()
    const fake = makeHistoryApi({
        messages: [
            fakeMsg({
                id: '4900',
                authorId: '300',
                username: 'alice',
                content: 'recent',
                attachments: [{ url: 'http://x/new.png', filename: 'new.png' }]
            }),
            fakeMsg({ id: '4000', authorId: BOT_ID, content: 'reply' }),
            fakeMsg({
                id: '3999',
                authorId: '300',
                username: 'alice',
                content: 'old',
                attachments: [{ url: 'http://x/old.png', filename: 'old.png' }]
            })
        ]
    })
    const history = await withApi(provider, fake.api, () =>
        provider.fetchHistoryContext(historyCtx(), historyEvent(), {
            scopeKey: CHANNEL_SCOPE,
            limit: 50
        })
    )
    assert.ok(history)
    assert.deepEqual(
        history.attachments?.map((a) => a.name),
        ['new.png']
    )
    assert.doesNotMatch(history.text, /old\.png/)
})

const reconcileCtx = () => ({
    channel: makeChannel(),
    config: baseConfig(),
    credentials: makeCredentials()
})

const withFakeApi = async (
    provider: DiscordChannelProvider,
    fakeApi: unknown,
    run: () => Promise<void>
): Promise<void> => {
    const internal = provider as unknown as { apiFor: () => unknown }
    const origApiFor = internal.apiFor
    internal.apiFor = () => fakeApi
    try {
        await run()
    } finally {
        internal.apiFor = origApiFor
    }
}

const botMessage = (overrides: Record<string, unknown> = {}) => ({
    id: 'M1',
    content: 'late answer',
    author: { id: '111111111111111111', bot: true },
    timestamp: new Date().toISOString(),
    edited_timestamp: null,
    ...overrides
})

test('discord reconcileSend confirms a landed send via recent own messages', async () => {
    const provider = new DiscordChannelProvider()
    const fakeApi = {
        channels: {
            getMessages: async () => [
                botMessage({ id: 'M9' }),
                botMessage({ id: 'M2', content: 'unrelated' })
            ]
        }
    }
    await withFakeApi(provider, fakeApi, async () => {
        const verdict = await provider.reconcileSend(reconcileCtx(), {
            scopeKey: 'discord:guild:G1:channel:C1',
            target: null,
            text: 'late answer',
            attemptStartedAt: new Date(Date.now() - 30_000)
        })
        assert.deepEqual(verdict, { outcome: 'sent', providerMessageId: 'M9' })
    })
})

test('discord reconcileSend counts an in-place preview edit via edited_timestamp', async () => {
    const provider = new DiscordChannelProvider()
    const fakeApi = {
        channels: {
            getMessages: async () => [
                botMessage({
                    id: 'M3',
                    timestamp: new Date(Date.now() - 3600_000).toISOString(),
                    edited_timestamp: new Date().toISOString()
                })
            ]
        }
    }
    await withFakeApi(provider, fakeApi, async () => {
        const verdict = await provider.reconcileSend(reconcileCtx(), {
            scopeKey: 'discord:guild:G1:channel:C1',
            target: null,
            text: 'late answer',
            attemptStartedAt: new Date(Date.now() - 30_000)
        })
        assert.equal(verdict.outcome, 'sent')
    })
})

test('discord reconcileSend reports not_sent when nothing recent matches', async () => {
    const provider = new DiscordChannelProvider()
    const fakeApi = {
        channels: {
            getMessages: async () => [
                botMessage({
                    timestamp: new Date(Date.now() - 3600_000).toISOString()
                }),
                botMessage({
                    id: 'M4',
                    content: 'late answer',
                    author: { id: 'someone-else', bot: false }
                })
            ]
        }
    }
    await withFakeApi(provider, fakeApi, async () => {
        const verdict = await provider.reconcileSend(reconcileCtx(), {
            scopeKey: 'discord:guild:G1:channel:C1',
            target: null,
            text: 'late answer',
            attemptStartedAt: new Date(Date.now() - 30_000)
        })
        assert.equal(verdict.outcome, 'not_sent')
    })
})

test('discord reconcileSend treats a partial chunked send as unknown', async () => {
    const provider = new DiscordChannelProvider()
    const line = 'x'.repeat(100)
    const text = Array.from({ length: 30 }, () => line).join('\n')
    const { chunkText } = await import('../src/modules/channels/text-chunk')
    const chunks = chunkText(text, 1990)
    assert.ok(chunks.length > 1, 'fixture must span multiple chunks')
    const fakeApi = {
        channels: {
            getMessages: async () => [botMessage({ content: chunks[0] })]
        }
    }
    await withFakeApi(provider, fakeApi, async () => {
        const verdict = await provider.reconcileSend(reconcileCtx(), {
            scopeKey: 'discord:guild:G1:channel:C1',
            target: null,
            text,
            attemptStartedAt: new Date(Date.now() - 30_000)
        })
        assert.equal(verdict.outcome, 'unknown')
    })
})

test('discord reconcileSend fails open to unknown on API errors and targets', async () => {
    const provider = new DiscordChannelProvider()
    const fakeApi = {
        channels: {
            getMessages: async () => {
                throw new Error('missing permissions')
            }
        }
    }
    await withFakeApi(provider, fakeApi, async () => {
        const failed = await provider.reconcileSend(reconcileCtx(), {
            scopeKey: 'discord:guild:G1:channel:C1',
            target: null,
            text: 'late answer',
            attemptStartedAt: new Date()
        })
        assert.equal(failed.outcome, 'unknown')
        const targeted = await provider.reconcileSend(reconcileCtx(), {
            scopeKey: 'agent-send:chat:C1',
            target: { kind: 'chat', chatId: 'C1' },
            text: 'late answer',
            attemptStartedAt: new Date()
        })
        assert.equal(targeted.outcome, 'unknown')
    })
})

test('discord ack reactions add eyes then swap to a terminal emoji', async () => {
    const provider = new DiscordChannelProvider()
    const added: Array<{
        channelId: string
        messageId: string
        emoji: string
    }> = []
    const removed: Array<{ emoji: string }> = []
    const fakeApi = {
        channels: {
            addMessageReaction: async (
                channelId: string,
                messageId: string,
                emoji: string
            ) => {
                added.push({ channelId, messageId, emoji })
            },
            deleteOwnMessageReaction: async (
                _channelId: string,
                _messageId: string,
                emoji: string
            ) => {
                removed.push({ emoji })
            }
        }
    }
    await withFakeApi(provider, fakeApi, async () => {
        await provider.setInboundReaction(
            reconcileCtx(),
            'discord:guild:G1:channel:C1',
            'M1',
            'working'
        )
        await provider.setInboundReaction(
            reconcileCtx(),
            'discord:guild:G1:channel:C1',
            'M1',
            'failed'
        )
    })
    assert.deepEqual(added, [
        { channelId: 'C1', messageId: 'M1', emoji: '👀' },
        { channelId: 'C1', messageId: 'M1', emoji: '❌' }
    ])
    assert.deepEqual(removed, [{ emoji: '👀' }])
})
