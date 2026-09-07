import type { MsTeamsChannelConfig } from '@manyfold/shared'
import { MSTEAMS_DEFAULT_SERVICE_URL, describeChannelScope } from '@manyfold/shared'
import assert from 'node:assert/strict'
import { createSign, generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import type { ChannelRow } from '@manyfold/db'
import { UnsupportedEventError } from '../src/modules/channels/channel-provider'
import { ChannelSendError } from '../src/modules/channels/channel-send-error'
import {
    markdownToMsTeams,
    stripMsTeamsMentions
} from '../src/modules/channels/providers/msteams-format'
import {
    normalizeMsTeamsServiceUrl,
    resetMsTeamsJwksCache,
    resetMsTeamsTokenCache
} from '../src/modules/channels/providers/msteams-auth'
import {
    MsTeamsChannelProvider,
    classifyMsTeamsError,
    msTeamsTargetFromScopeKey,
    splitConversationId
} from '../src/modules/channels/providers/msteams.provider'

const OPENID_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration'
const JWKS_URL = 'https://login.botframework.com/v1/.well-known/keys'
const APP_ID = '11111111-2222-3333-4444-555555555555'
const TENANT_ID = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
const TOKEN_URL = `https://login.microsoftonline.com/${TENANT_ID}/oauth2/v2.0/token`
const CHANNEL_CONV = '19:abc123def@thread.tacv2'
const DM_CONV = 'a:1kZxQwErTy'
const SENDER_AAD = '99999999-8888-7777-6666-555555555555'

// One keypair for the whole file: signing is the slow part and every test wants
// the same "Bot Connector" identity behind the stubbed key set.
const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048
})
const KID = 'test-kid-1'

const signingJwk = (): Record<string, unknown> => ({
    ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
    kid: KID,
    alg: 'RS256',
    use: 'sig'
})

const b64url = (value: string): string =>
    Buffer.from(value, 'utf8').toString('base64url')

const signJwt = (
    claims: Record<string, unknown> = {},
    header: Record<string, unknown> = {}
): string => {
    const head = b64url(
        JSON.stringify({ alg: 'RS256', typ: 'JWT', kid: KID, ...header })
    )
    const now = Math.floor(Date.now() / 1000)
    const payload = b64url(
        JSON.stringify({
            iss: 'https://api.botframework.com',
            aud: APP_ID,
            serviceurl: MSTEAMS_DEFAULT_SERVICE_URL,
            iat: now - 10,
            exp: now + 600,
            ...claims
        })
    )
    const data = `${head}.${payload}`
    const sig = createSign('RSA-SHA256')
        .update(data)
        .sign(privateKey)
        .toString('base64url')
    return `${data}.${sig}`
}

const makeChannel = (overrides: Partial<ChannelRow> = {}): ChannelRow => ({
    id: 'chn-teams-1',
    userId: 'user-1',
    agentId: 'agent-1',
    provider: 'msteams',
    label: 'msteams test',
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
    overrides: Partial<MsTeamsChannelConfig> = {}
): MsTeamsChannelConfig => ({
    botId: APP_ID,
    botName: 'Manyfold',
    serviceUrl: MSTEAMS_DEFAULT_SERVICE_URL,
    allowedUserIds: [],
    operatorUserIds: [],
    allowedConversationIds: [],
    mentionOnly: true,
    shareSessionInChannel: false,
    threadIsolation: true,
    progressMode: 'preview',
    ...overrides
})

const CREDENTIALS = {
    appId: APP_ID,
    appPassword: 'super-secret',
    tenantId: TENANT_ID
}

const makeCtx = (
    config: MsTeamsChannelConfig = baseConfig(),
    credentials: unknown = CREDENTIALS,
    channel: ChannelRow = makeChannel()
) => ({ channel, config, credentials }) as never

const activity = (
    overrides: Record<string, unknown> = {}
): Record<string, unknown> => ({
    type: 'message',
    id: '1700000000001',
    serviceUrl: MSTEAMS_DEFAULT_SERVICE_URL,
    text: 'hello',
    from: { id: '29:sender', name: 'Ada', aadObjectId: SENDER_AAD },
    recipient: { id: APP_ID, name: 'Manyfold' },
    conversation: { id: DM_CONV, conversationType: 'personal' },
    channelData: { tenant: { id: TENANT_ID } },
    ...overrides
})

const request = (body: Record<string, unknown>, token = signJwt()) => ({
    headers: { Authorization: `Bearer ${token}` },
    body,
    rawBody: JSON.stringify(body)
})

type FetchHandler = (
    url: string,
    init?: RequestInit
) => { status?: number; body?: unknown } | Promise<{ status?: number; body?: unknown }>

const withFetch = async (
    handler: FetchHandler,
    fn: (calls: Array<{ url: string; init?: RequestInit }>) => Promise<void>
): Promise<void> => {
    const original = globalThis.fetch
    const calls: Array<{ url: string; init?: RequestInit }> = []
    globalThis.fetch = (async (input: string, init?: RequestInit) => {
        const url = String(input)
        calls.push({ url, init })
        const { status = 200, body = {} } = await handler(url, init)
        const text = typeof body === 'string' ? body : JSON.stringify(body)
        return new Response(text, { status })
    }) as typeof globalThis.fetch
    try {
        await fn(calls)
    } finally {
        globalThis.fetch = original
    }
}

// Serves the OpenID document, the key set and a token mint, so a test only has
// to describe the Bot Connector call it actually cares about.
const teamsBackend =
    (
        connector: (url: string, init?: RequestInit) => {
            status?: number
            body?: unknown
        } = () => ({ body: {} })
    ): FetchHandler =>
    (url, init) => {
        if (url === OPENID_URL) return { body: { jwks_uri: JWKS_URL } }
        if (url === JWKS_URL) return { body: { keys: [signingJwk()] } }
        if (url === TOKEN_URL)
            return { body: { access_token: 'bf.test', expires_in: 3600 } }
        return connector(url, init)
    }

const resetCaches = (): void => {
    resetMsTeamsJwksCache()
    resetMsTeamsTokenCache()
}

test('msteams validateConfig normalizes lists and keeps the default connector', () => {
    const provider = new MsTeamsChannelProvider()
    const config = provider.validateConfig({
        botId: `  ${APP_ID}  `,
        allowedUserIds: [`  ${SENDER_AAD} `, SENDER_AAD, '', 'other-id'],
        allowedConversationIds: [`  ${CHANNEL_CONV}  `],
        mentionOnly: false,
        shareSessionInChannel: true
    })
    assert.equal(config.botId, APP_ID)
    assert.deepEqual(config.allowedUserIds, [SENDER_AAD, 'other-id'])
    assert.deepEqual(config.allowedConversationIds, [CHANNEL_CONV])
    assert.equal(config.mentionOnly, false)
    assert.equal(config.shareSessionInChannel, true)
    // Teams supports activity edit, so unlike Google Chat there is no reason to
    // downgrade the default away from a streaming preview.
    assert.equal(config.progressMode, 'preview')
    assert.equal(config.threadIsolation, true)
    // Left null so register() can fill in the public connector; a stored null
    // and the default must not diverge.
    assert.equal(config.serviceUrl, null)
})

test('msteams validateConfig rejects a serviceUrl outside the Bot Connector', () => {
    const provider = new MsTeamsChannelProvider()
    assert.throws(
        () =>
            provider.validateConfig({
                serviceUrl: 'https://evil.example.com/teams'
            }),
        /not a Bot Connector endpoint/
    )
})

test('msteams validateCredentials requires the full app registration triple', () => {
    const provider = new MsTeamsChannelProvider()
    assert.throws(
        () => provider.validateCredentials({ appId: APP_ID }),
        /appPassword is required/
    )
    assert.throws(
        () =>
            provider.validateCredentials({
                appId: APP_ID,
                appPassword: 'x'
            }),
        /tenantId is required/
    )
    assert.deepEqual(provider.validateCredentials(CREDENTIALS), CREDENTIALS)
})

test('msteams normalizeMsTeamsServiceUrl pins the connector host and keeps the region path', () => {
    assert.equal(
        normalizeMsTeamsServiceUrl('https://smba.trafficmanager.net/emea'),
        'https://smba.trafficmanager.net/emea/'
    )
    // Trailing slash and none must collapse to one base, or the same tenant
    // would produce two different stored endpoints.
    assert.equal(
        normalizeMsTeamsServiceUrl('https://smba.trafficmanager.net/teams/'),
        normalizeMsTeamsServiceUrl('https://smba.trafficmanager.net/teams')
    )
    assert.equal(normalizeMsTeamsServiceUrl('https://evil.example.com/teams'), null)
    assert.equal(
        normalizeMsTeamsServiceUrl('http://smba.trafficmanager.net/teams'),
        null
    )
    assert.equal(normalizeMsTeamsServiceUrl('not a url'), null)
})

test('msteams verifySignature accepts a Bot Connector token', async () => {
    resetCaches()
    const provider = new MsTeamsChannelProvider()
    await withFetch(teamsBackend(), async () => {
        const check = await provider.verifySignature(
            request(activity()),
            makeCtx()
        )
        assert.deepEqual(check, { ok: true })
    })
})

test('msteams verifySignature rejects a token minted for another bot', async () => {
    resetCaches()
    const provider = new MsTeamsChannelProvider()
    await withFetch(teamsBackend(), async () => {
        const check = await provider.verifySignature(
            request(activity(), signJwt({ aud: 'someone-else' })),
            makeCtx()
        )
        assert.equal(check.ok, false)
        assert.match(check.reason ?? '', /token_verification_failed/)
    })
})

test('msteams verifySignature rejects a foreign issuer and an expired token', async () => {
    resetCaches()
    const provider = new MsTeamsChannelProvider()
    await withFetch(teamsBackend(), async () => {
        const wrongIssuer = await provider.verifySignature(
            request(activity(), signJwt({ iss: 'https://evil.example.com' })),
            makeCtx()
        )
        assert.equal(wrongIssuer.ok, false)
        const now = Math.floor(Date.now() / 1000)
        const expired = await provider.verifySignature(
            request(activity(), signJwt({ iat: now - 900, exp: now - 600 })),
            makeCtx()
        )
        assert.equal(expired.ok, false)
    })
})

test('msteams verifySignature rejects an unknown signing key', async () => {
    resetCaches()
    const provider = new MsTeamsChannelProvider()
    await withFetch(teamsBackend(), async () => {
        const check = await provider.verifySignature(
            request(activity(), signJwt({}, { kid: 'rotated-away' })),
            makeCtx()
        )
        assert.deepEqual(check, { ok: false, reason: 'unknown_signing_key' })
    })
})

test('msteams verifySignature rejects a serviceUrl the token does not authorize', async () => {
    resetCaches()
    const provider = new MsTeamsChannelProvider()
    await withFetch(teamsBackend(), async () => {
        // A token captured from one bot's traffic must not authenticate an
        // activity that redirects the reply somewhere else.
        const mismatch = await provider.verifySignature(
            request(
                activity({
                    serviceUrl: 'https://smba.trafficmanager.net/emea/'
                })
            ),
            makeCtx()
        )
        assert.deepEqual(mismatch, { ok: false, reason: 'service_url_mismatch' })
        const offConnector = await provider.verifySignature(
            request(activity({ serviceUrl: 'https://evil.example.com/teams' })),
            makeCtx()
        )
        assert.deepEqual(offConnector, {
            ok: false,
            reason: 'service_url_rejected'
        })
    })
})

test('msteams verifySignature rejects an activity from another tenant', async () => {
    resetCaches()
    const provider = new MsTeamsChannelProvider()
    await withFetch(teamsBackend(), async () => {
        const check = await provider.verifySignature(
            request(
                activity({ channelData: { tenant: { id: 'some-other-tenant' } } })
            ),
            makeCtx()
        )
        assert.deepEqual(check, { ok: false, reason: 'tenant_mismatch' })
    })
})

test('msteams verifySignature fails closed when the key set cannot be fetched', async () => {
    resetCaches()
    const provider = new MsTeamsChannelProvider()
    await withFetch(
        (url) => (url === OPENID_URL ? { status: 503, body: {} } : { body: {} }),
        async () => {
            const check = await provider.verifySignature(
                request(activity()),
                makeCtx()
            )
            assert.equal(check.ok, false)
        }
    )
})

test('msteams verifySignature requires a bearer token', async () => {
    const provider = new MsTeamsChannelProvider()
    const check = await provider.verifySignature(
        { headers: {}, body: activity(), rawBody: '{}' },
        makeCtx()
    )
    assert.deepEqual(check, { ok: false, reason: 'missing_bearer_token' })
})

test('msteams parseInbound reads a personal chat message', () => {
    const provider = new MsTeamsChannelProvider()
    const event = provider.parseInbound(request(activity()), makeCtx())
    assert.equal(event.providerEventId, 'msteams-1700000000001')
    assert.equal(event.chatId, DM_CONV)
    assert.equal(event.chatType, 'private')
    // The Entra object id is the stable identity; the '29:…' Teams id is
    // per-app and would break an allowlist across bots.
    assert.equal(event.senderId, SENDER_AAD)
    assert.equal(event.senderName, 'Ada')
    assert.equal(event.text, 'hello')
    // A DM is always directed at the bot, so it never needs a mention.
    assert.equal(event.isMention, true)
    assert.equal(event.threadId, null)
})

test('msteams parseInbound resolves a channel mention by entity id, not display name', () => {
    const provider = new MsTeamsChannelProvider()
    const mentioned = provider.parseInbound(
        request(
            activity({
                text: '<at>Manyfold</at> deploy the thing',
                conversation: {
                    id: CHANNEL_CONV,
                    conversationType: 'channel'
                },
                entities: [
                    {
                        type: 'mention',
                        text: '<at>Manyfold</at>',
                        mentioned: { id: APP_ID, name: 'Manyfold' }
                    }
                ]
            })
        ),
        makeCtx()
    )
    assert.equal(mentioned.isMention, true)
    assert.equal(mentioned.chatType, 'group')
    assert.equal(mentioned.text, 'deploy the thing')

    // A group member who renames themselves to the bot's name must not be able
    // to fake a mention: the entity id is what decides.
    const spoofed = provider.parseInbound(
        request(
            activity({
                text: '<at>Manyfold</at> deploy the thing',
                conversation: {
                    id: CHANNEL_CONV,
                    conversationType: 'channel'
                },
                entities: [
                    {
                        type: 'mention',
                        text: '<at>Manyfold</at>',
                        mentioned: { id: '29:impostor', name: 'Manyfold' }
                    }
                ]
            })
        ),
        makeCtx()
    )
    assert.equal(spoofed.isMention, false)
    // Someone else's mention is information the agent needs, so it is flattened
    // to the name rather than dropped.
    assert.equal(spoofed.text, 'Manyfold deploy the thing')
})

test('msteams parseInbound splits the thread out of a channel conversation id', () => {
    const provider = new MsTeamsChannelProvider()
    const event = provider.parseInbound(
        request(
            activity({
                conversation: {
                    id: `${CHANNEL_CONV};messageid=1699999999999`,
                    conversationType: 'channel'
                }
            })
        ),
        makeCtx()
    )
    // Teams has no thread field: the ;messageid= suffix is the thread, and
    // leaving it on the conversation id would fork a session per reply.
    assert.equal(event.chatId, CHANNEL_CONV)
    assert.equal(event.threadId, '1699999999999')
})

test('msteams parseInbound rejects non-message activities and the bot echo', () => {
    const provider = new MsTeamsChannelProvider()
    assert.throws(
        () =>
            provider.parseInbound(
                request(activity({ type: 'conversationUpdate' })),
                makeCtx()
            ),
        UnsupportedEventError
    )
    assert.throws(
        () =>
            provider.parseInbound(
                request(
                    activity({
                        from: { id: APP_ID, name: 'Manyfold' }
                    })
                ),
                makeCtx()
            ),
        UnsupportedEventError
    )
    assert.throws(
        () =>
            provider.parseInbound(
                request(activity({ text: '   ' })),
                makeCtx()
            ),
        UnsupportedEventError
    )
})

test('msteams parseInbound keeps DM attachments and drops the channel HTML stub', () => {
    const provider = new MsTeamsChannelProvider()
    const event = provider.parseInbound(
        request(
            activity({
                text: 'see attached',
                attachments: [
                    {
                        contentType: 'text/html',
                        content: '<div>stub</div>'
                    },
                    {
                        contentType:
                            'application/vnd.microsoft.teams.file.download.info',
                        name: 'report.pdf',
                        content: {
                            downloadUrl:
                                'https://contoso.sharepoint.com/x/report.pdf',
                            fileType: 'pdf'
                        }
                    }
                ]
            })
        ),
        makeCtx()
    )
    // In a channel Teams strips the file reference and sends only the HTML
    // stub; keeping it would surface an unfetchable attachment to the agent.
    assert.equal(event.attachments?.length, 1)
    assert.equal(event.attachments?.[0].name, 'report.pdf')
    assert.match(
        event.attachments?.[0].url ?? '',
        /contoso\.sharepoint\.com/
    )
})

test('msteams computeScopeKey percent-encodes the conversation id', () => {
    const provider = new MsTeamsChannelProvider()
    const dm = provider.computeScopeKey(
        provider.parseInbound(request(activity()), makeCtx()),
        baseConfig()
    )
    // Teams ids contain ':' — the scope key's own separator — so an unencoded
    // id would shift every later segment.
    assert.equal(dm.scopeKey, `msteams:dm:${encodeURIComponent(DM_CONV)}:${SENDER_AAD}`)
    assert.equal(msTeamsTargetFromScopeKey(dm.scopeKey).conversationId, DM_CONV)

    const channelEvent = provider.parseInbound(
        request(
            activity({
                conversation: {
                    id: `${CHANNEL_CONV};messageid=1699999999999`,
                    conversationType: 'channel'
                },
                channelData: {
                    tenant: { id: TENANT_ID },
                    team: { id: 'team-1', name: 'Platform' },
                    channel: { id: 'chan-1', name: 'General' }
                }
            })
        ),
        makeCtx()
    )
    const threaded = provider.computeScopeKey(channelEvent, baseConfig())
    assert.equal(
        threaded.scopeKey,
        `msteams:conv:${encodeURIComponent(CHANNEL_CONV)}:thread:1699999999999`
    )
    assert.equal(threaded.scopeName, 'Platform / General')

    const shared = provider.computeScopeKey(
        channelEvent,
        baseConfig({ threadIsolation: false, shareSessionInChannel: true })
    )
    assert.equal(shared.scopeKey, `msteams:conv:${encodeURIComponent(CHANNEL_CONV)}`)
})

test('msteams scope keys round-trip through the shared descriptor', () => {
    const dm = describeChannelScope(
        'msteams',
        `msteams:dm:${encodeURIComponent(DM_CONV)}:${SENDER_AAD}`
    )
    assert.equal(dm.kind, 'dm')
    assert.equal(dm.channelId, DM_CONV)
    assert.equal(dm.userId, SENDER_AAD)

    const thread = describeChannelScope(
        'msteams',
        `msteams:conv:${encodeURIComponent(CHANNEL_CONV)}:thread:1699999999999`
    )
    assert.equal(thread.kind, 'thread')
    assert.equal(thread.channelId, CHANNEL_CONV)
    assert.equal(thread.threadId, '1699999999999')

    const channel = describeChannelScope(
        'msteams',
        `msteams:conv:${encodeURIComponent(CHANNEL_CONV)}`
    )
    assert.equal(channel.kind, 'channel')
    assert.equal(channel.channelId, CHANNEL_CONV)
})

test('msteams evaluateInboundActor gates on Entra object ids', () => {
    const provider = new MsTeamsChannelProvider()
    const event = provider.parseInbound(request(activity()), makeCtx())

    assert.deepEqual(provider.evaluateInboundActor(event, baseConfig()), {
        allowed: true,
        operator: false
    })
    assert.deepEqual(
        provider.evaluateInboundActor(
            event,
            baseConfig({ allowedUserIds: ['someone-else'] })
        ),
        { allowed: false, reason: 'sender_not_allowed', operator: false }
    )
    // Matching is case-insensitive: Entra renders the same GUID either way.
    assert.deepEqual(
        provider.evaluateInboundActor(
            event,
            baseConfig({ allowedUserIds: [SENDER_AAD.toUpperCase()] })
        ),
        { allowed: true, operator: false }
    )
    // An operator must pass the chat gate too, or /model would be dropped
    // before dispatch could check operator rights.
    assert.deepEqual(
        provider.evaluateInboundActor(
            event,
            baseConfig({
                allowedUserIds: ['someone-else'],
                operatorUserIds: [SENDER_AAD]
            })
        ),
        { allowed: true, operator: true }
    )
})

test('msteams evaluateInboundActor tolerates a pasted conversation id with a thread suffix', () => {
    const provider = new MsTeamsChannelProvider()
    const event = provider.parseInbound(
        request(
            activity({
                conversation: {
                    id: CHANNEL_CONV,
                    conversationType: 'channel'
                }
            })
        ),
        makeCtx()
    )
    // Copying a conversation id out of a Teams deep link brings the suffix
    // along; an allowlist that only matched the exact string would silently
    // reject the channel it was meant to allow.
    assert.equal(
        provider.evaluateInboundActor(
            event,
            baseConfig({
                allowedConversationIds: [`${CHANNEL_CONV};messageid=17000`]
            })
        ).allowed,
        true
    )
    assert.deepEqual(
        provider.evaluateInboundActor(
            event,
            baseConfig({ allowedConversationIds: ['19:other@thread.tacv2'] })
        ),
        { allowed: false, reason: 'conversation_not_allowed', operator: false }
    )
})

test('msteams sendText posts to the conversation and reassembles the thread', async () => {
    resetCaches()
    const provider = new MsTeamsChannelProvider()
    await withFetch(
        teamsBackend(() => ({ body: { id: 'activity-9' } })),
        async (calls) => {
            const res = await provider.sendText(
                makeCtx(),
                `msteams:conv:${encodeURIComponent(CHANNEL_CONV)}:thread:1699999999999`,
                '# Heading\n\nbody'
            )
            assert.equal(res.providerMessageId, 'activity-9')
            const post = calls.find((c) => c.init?.method === 'POST' && c.url.includes('/v3/conversations/'))
            assert.ok(post)
            // Posting back into a thread means putting the suffix back on.
            assert.equal(
                post.url,
                `${MSTEAMS_DEFAULT_SERVICE_URL}/v3/conversations/${encodeURIComponent(`${CHANNEL_CONV};messageid=1699999999999`)}/activities`
            )
            const body = JSON.parse(String(post.init?.body))
            assert.equal(body.textFormat, 'markdown')
            // Teams drops the leading '#', so a heading has to arrive as bold
            // or it reads as body text.
            assert.equal(body.text, '**Heading**\n\nbody')
        }
    )
})

test('msteams send classifies platform failures into the retry taxonomy', async () => {
    resetCaches()
    const provider = new MsTeamsChannelProvider()
    await withFetch(
        teamsBackend(() => ({
            status: 403,
            body: { error: { code: 'BotNotInConversationRoster', message: 'nope' } }
        })),
        async () => {
            await assert.rejects(
                provider.sendText(
                    makeCtx(),
                    `msteams:dm:${encodeURIComponent(DM_CONV)}:${SENDER_AAD}`,
                    'hi'
                ),
                (err: unknown) =>
                    err instanceof ChannelSendError && err.kind === 'forbidden'
            )
        }
    )
    resetCaches()
    await withFetch(
        teamsBackend(() => ({ status: 500, body: { error: { message: 'boom' } } })),
        async () => {
            // An unclassified status stays a plain Error so the ladder retries
            // rather than dead-lettering the delivery.
            await assert.rejects(
                provider.sendText(
                    makeCtx(),
                    `msteams:dm:${encodeURIComponent(DM_CONV)}:${SENDER_AAD}`,
                    'hi'
                ),
                (err: unknown) =>
                    err instanceof Error && !(err instanceof ChannelSendError)
            )
        }
    )
})

test('msteams re-mints after a 401 rather than reusing the rejected token', async () => {
    resetCaches()
    const provider = new MsTeamsChannelProvider()
    await withFetch(
        teamsBackend(() => ({ status: 401, body: {} })),
        async (calls) => {
            const scope = `msteams:dm:${encodeURIComponent(DM_CONV)}:${SENDER_AAD}`
            await assert.rejects(provider.sendText(makeCtx(), scope, 'hi'))
            await assert.rejects(provider.sendText(makeCtx(), scope, 'hi'))
            const mints = calls.filter((c) => c.url === TOKEN_URL)
            // A stale token outlives a credential rotation; without the
            // invalidation the second attempt would replay the same 401.
            assert.equal(mints.length, 2)
        }
    )
})

test('msteams sendDirect refuses targets Teams cannot address', async () => {
    const provider = new MsTeamsChannelProvider()
    await assert.rejects(
        provider.sendDirect(makeCtx(), { kind: 'user', userId: SENDER_AAD }, 'hi'),
        /conversation id/
    )
    await assert.rejects(
        provider.sendDirect(makeCtx(), { kind: 'reply', messageId: 'm1' }, 'hi'),
        /single message/
    )
})

test('msteams preview edits in place and falls back to a fresh post', async () => {
    resetCaches()
    const provider = new MsTeamsChannelProvider()
    const scope = `msteams:dm:${encodeURIComponent(DM_CONV)}:${SENDER_AAD}`
    await withFetch(
        teamsBackend((_url, init) =>
            init?.method === 'PUT'
                ? { status: 400, body: { error: { message: 'too late' } } }
                : { body: { id: 'activity-1' } }
        ),
        async (calls) => {
            const handle = await provider.sendPreviewStart(makeCtx(), scope)
            assert.equal(handle.providerMessageId, 'activity-1')
            // A failed edit must still deliver the answer, not lose it.
            await provider.finishPreview(makeCtx(), handle, 'final answer')
            const posts = calls.filter(
                (c) => c.init?.method === 'POST' && c.url.includes('/activities')
            )
            assert.equal(posts.length, 2)
            assert.equal(
                JSON.parse(String(posts[1].init?.body)).text,
                'final answer'
            )
        }
    )
})

test('msteams downloadAttachment sends the bot token only to the Bot Connector', async () => {
    resetCaches()
    const provider = new MsTeamsChannelProvider()
    await withFetch(teamsBackend(() => ({ body: 'PNGDATA' })), async (calls) => {
        await provider.downloadAttachment(
            makeCtx(),
            {
                url: 'https://smba.trafficmanager.net/amer/v3/attachments/1/views/original',
                name: 'shot.png',
                contentType: 'image/png'
            },
            { maxBytes: 1024 }
        )
        const fetched = calls[calls.length - 1]
        assert.ok(
            (fetched.init?.headers as Record<string, string>).Authorization
        )
    })
    resetCaches()
    await withFetch(teamsBackend(() => ({ body: 'PDFDATA' })), async (calls) => {
        await provider.downloadAttachment(
            makeCtx(),
            {
                url: 'https://contoso.sharepoint.com/x/report.pdf',
                name: 'report.pdf',
                contentType: 'application/pdf'
            },
            { maxBytes: 1024 }
        )
        const fetched = calls[calls.length - 1]
        // A file-consent url is already pre-authorized; sending the bot token
        // to SharePoint would leak it for no gain.
        assert.equal(
            (fetched.init?.headers as Record<string, string>).Authorization,
            undefined
        )
    })
})

test('msteams downloadAttachment refuses an unknown host and enforces the size cap', async () => {
    resetCaches()
    const provider = new MsTeamsChannelProvider()
    await withFetch(teamsBackend(() => ({ body: 'x'.repeat(4096) })), async () => {
        await assert.rejects(
            provider.downloadAttachment(
                makeCtx(),
                {
                    url: 'https://evil.example.com/payload.bin',
                    name: 'payload.bin',
                    contentType: 'application/octet-stream'
                },
                { maxBytes: 1024 }
            ),
            /host not allowed/
        )
        await assert.rejects(
            provider.downloadAttachment(
                makeCtx(),
                {
                    url: 'https://contoso.sharepoint.com/x/big.bin',
                    name: 'big.bin',
                    contentType: 'application/octet-stream'
                },
                { maxBytes: 1024 }
            ),
            /exceeds 1024 bytes/
        )
    })
})

test('msteams register proves the credentials and captures the bot identity', async () => {
    resetCaches()
    const provider = new MsTeamsChannelProvider()
    const inboundUrl =
        'https://api.example.com/api/channels/hooks/msteams/chn-teams-1'
    await withFetch(teamsBackend(), async () => {
        const result = await provider.register(
            makeCtx(baseConfig({ botId: null, serviceUrl: null })),
            inboundUrl
        )
        assert.equal(result.ok, true)
        // Teams has no verification handshake, so register() is the only way
        // out of draft.
        assert.equal(result.activate, true)
        const patch = result.configPatch as MsTeamsChannelConfig
        assert.equal(patch.botId, APP_ID)
        assert.equal(patch.serviceUrl, MSTEAMS_DEFAULT_SERVICE_URL)
        assert.match(result.message ?? '', new RegExp(inboundUrl))
    })

    resetCaches()
    await withFetch(
        (url) =>
            url === TOKEN_URL
                ? { status: 401, body: { error: 'invalid_client' } }
                : { body: {} },
        async () => {
            const result = await provider.register(makeCtx(), inboundUrl)
            assert.equal(result.ok, false)
            assert.equal(result.activate, undefined)
            assert.match(result.message ?? '', /credentials rejected/)
        }
    )
})

test('msteams test() reports draft as not ready and never claims reachability', async () => {
    resetCaches()
    const provider = new MsTeamsChannelProvider()
    await withFetch(teamsBackend(), async () => {
        const draft = await provider.test(
            makeCtx(baseConfig(), CREDENTIALS, makeChannel({ status: 'draft' }))
        )
        assert.equal(draft.ok, false)
        assert.match(draft.message, /still draft/)

        const active = await provider.test(makeCtx())
        assert.equal(active.ok, true)
        // Nothing here proves Teams can reach us — the Bot Connector never
        // calls back on demand — so the result must not imply it does.
        assert.match(active.message, /confirm delivery end to end/)
    })
})

test('msteams splitConversationId and error classification', () => {
    assert.deepEqual(splitConversationId(CHANNEL_CONV), {
        conversationId: CHANNEL_CONV,
        threadId: null
    })
    assert.deepEqual(splitConversationId(`${CHANNEL_CONV};messageid=42`), {
        conversationId: CHANNEL_CONV,
        threadId: '42'
    })
    assert.equal(classifyMsTeamsError(429), 'rate_limited')
    assert.equal(classifyMsTeamsError(404), 'not_found')
    // 401 is a stale token, not a permanent rejection: classifying it would
    // dead-letter a delivery a re-mint would have delivered.
    assert.equal(classifyMsTeamsError(401), null)
    assert.equal(classifyMsTeamsError(500), null)
})

test('msteams markdown and mention helpers leave code untouched', () => {
    // A '#' inside a snippet is a shell comment, not a heading.
    assert.equal(
        markdownToMsTeams('```sh\n# not a heading\n```'),
        '```sh\n# not a heading\n```'
    )
    assert.equal(markdownToMsTeams('## Title\n\ntext'), '**Title**\n\ntext')
    // An unmatched tag still must not reach the agent as raw markup.
    assert.equal(stripMsTeamsMentions('<at>Bot</at> hello'), 'hello')
})
