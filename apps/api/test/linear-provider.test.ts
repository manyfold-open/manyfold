import type { LinearChannelConfig } from '@manyfold/shared'
import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import test from 'node:test'
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici'
import type { ChannelRow } from '@manyfold/db'
import { ChannelSendError } from '../src/modules/channels/channel-send-error'
import { LinearChannelProvider } from '../src/modules/channels/providers/linear.provider'

const ORG = 'org-1'
const SESSION = 'session-1'
const WEBHOOK_SECRET = 'linear-webhook-secret-0001'

const makeProvider = (
    env: Record<string, string> = { MF_WEB_URL: 'https://app.manyfold.test' }
): LinearChannelProvider =>
    new LinearChannelProvider({
        get: (key: string) => env[key]
    } as never)

const makeChannel = (overrides: Partial<ChannelRow> = {}): ChannelRow =>
    ({
        id: 'chn-1',
        userId: 'user-1',
        agentId: 'agent-1',
        provider: 'linear',
        label: 'linear test',
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
    }) as ChannelRow

const baseConfig = (
    overrides: Partial<LinearChannelConfig> = {}
): LinearChannelConfig => ({
    appUserId: 'app-user-1',
    organizationId: ORG,
    workspaceUrlKey: 'acme',
    allowedUserIds: [],
    progressMode: 'activity',
    ...overrides
})

const makeCredentials = (overrides: Record<string, unknown> = {}) => ({
    clientId: 'client-id-1',
    clientSecret: 'client-secret-1',
    webhookSecret: WEBHOOK_SECRET,
    accessToken: null,
    ...overrides
})

const makeCtx = (
    config: Partial<LinearChannelConfig> = {},
    credentials: Record<string, unknown> | null = makeCredentials(),
    channel: Partial<ChannelRow> = {}
) =>
    ({
        channel: makeChannel(channel),
        config: baseConfig(config),
        credentials
    }) as never

const signLinear = (rawBody: string, secret = WEBHOOK_SECRET): string =>
    createHmac('sha256', secret).update(rawBody).digest('hex')

const createdBody = (overrides: Record<string, unknown> = {}) => ({
    type: 'AgentSessionEvent',
    action: 'created',
    organizationId: ORG,
    appUserId: 'app-user-1',
    webhookTimestamp: Date.now(),
    agentSession: {
        id: SESSION,
        creator: { id: 'user-linear-1', name: 'Ada', displayName: 'Ada L' },
        issue: { id: 'iss-1', identifier: 'ENG-123', title: 'Fix checkout' },
        comment: { id: 'cmt-1', body: '@botcoder please implement this' }
    },
    // Shaped after a real mention payload: Linear marks the thread holding the
    // asker's words as the primary directive. A delegation has no such thread.
    promptContext:
        '<issue identifier="ENG-123"><title>Fix checkout</title></issue>\n\n' +
        '<primary-directive-thread comment-id="cmt-1"><comment author="Ada">' +
        '<user id="app-user-1">botcoder</user> please implement this</comment>' +
        '</primary-directive-thread>',
    ...overrides
})

// Delegating an issue creates a session whose root comment is Linear's own
// boilerplate and whose promptContext has no directive thread.
const delegatedBody = (overrides: Record<string, unknown> = {}) =>
    createdBody({
        agentSession: {
            id: SESSION,
            creator: { id: 'user-linear-1', name: 'Ada' },
            issue: {
                id: 'iss-1',
                identifier: 'ENG-123',
                title: 'Fix checkout'
            },
            comment: {
                id: 'cmt-root',
                body: 'This thread is for an agent session with botcoder.'
            }
        },
        promptContext:
            '<issue identifier="ENG-123"><title>Fix checkout</title>' +
            '<description>Make it screen-reader friendly</description></issue>',
        ...overrides
    })

const promptedBody = (overrides: Record<string, unknown> = {}) => ({
    type: 'AgentSessionEvent',
    action: 'prompted',
    organizationId: ORG,
    appUserId: 'app-user-1',
    webhookTimestamp: Date.now(),
    agentSession: {
        id: SESSION,
        creator: { id: 'user-linear-1', name: 'Ada' },
        issue: { id: 'iss-1', identifier: 'ENG-123', title: 'Fix checkout' }
    },
    // Shaped after a real prompted payload: the activity carries its author
    // (user + userId), who need not be the session creator.
    agentActivity: {
        id: 'act-1',
        user: { id: 'user-linear-2', name: 'Grace H' },
        userId: 'user-linear-2',
        content: { type: 'prompt', body: 'any update?' }
    },
    ...overrides
})

const reqFor = (
    body: unknown,
    opts: { secret?: string; signature?: string } = {}
) => {
    const rawBody = JSON.stringify(body)
    return {
        headers: {
            'Linear-Signature':
                opts.signature ??
                signLinear(rawBody, opts.secret ?? WEBHOOK_SECRET)
        },
        body,
        rawBody
    }
}

interface GqlReply {
    status: number
    body: object
    headers?: Record<string, string>
}

interface LinearMock {
    graphql: Array<{ query: string; variables: Record<string, unknown> }>
    tokenMints: number
}

const withLinearMock = async (
    run: (mock: LinearMock) => Promise<void>,
    setup: { graphql?: GqlReply[]; token?: GqlReply[] } = {}
): Promise<void> => {
    const previous = getGlobalDispatcher()
    const agent = new MockAgent()
    agent.disableNetConnect()
    setGlobalDispatcher(agent)
    const pool = agent.get('https://api.linear.app')
    const mock: LinearMock = { graphql: [], tokenMints: 0 }
    const gqlReplies = setup.graphql ?? [
        {
            status: 200,
            body: {
                data: {
                    agentActivityCreate: {
                        success: true,
                        agentActivity: { id: 'act-out-1' }
                    }
                }
            }
        }
    ]
    const tokenReplies = setup.token ?? [
        {
            status: 200,
            body: { access_token: 'minted-token', expires_in: 2591999 }
        }
    ]
    let gqlIdx = 0
    let tokenIdx = 0
    pool.intercept({ path: '/graphql', method: 'POST' })
        .reply((opts) => {
            const parsed = JSON.parse(String(opts.body)) as {
                query: string
                variables: Record<string, unknown>
            }
            mock.graphql.push({
                query: parsed.query,
                variables: parsed.variables
            })
            const reply = gqlReplies[Math.min(gqlIdx, gqlReplies.length - 1)]
            gqlIdx += 1
            return {
                statusCode: reply.status,
                data: reply.body,
                responseOptions: { headers: reply.headers ?? {} }
            }
        })
        .persist()
    pool.intercept({ path: '/oauth/token', method: 'POST' })
        .reply(() => {
            mock.tokenMints += 1
            const reply =
                tokenReplies[Math.min(tokenIdx, tokenReplies.length - 1)]
            tokenIdx += 1
            return { statusCode: reply.status, data: reply.body }
        })
        .persist()
    try {
        await run(mock)
    } finally {
        setGlobalDispatcher(previous)
    }
}

const activityInput = (
    entry: { variables: Record<string, unknown> } | undefined
): Record<string, unknown> =>
    (entry?.variables.input ?? {}) as Record<string, unknown>

const activityContent = (
    entry: { variables: Record<string, unknown> } | undefined
): Record<string, unknown> =>
    (activityInput(entry).content ?? {}) as Record<string, unknown>

test('linear validateCredentials requires a webhook secret and a token strategy', () => {
    const provider = makeProvider()
    assert.equal(provider.validateCredentials(null), null)
    assert.throws(
        () =>
            provider.validateCredentials({ clientId: 'a', clientSecret: 'b' }),
        /webhookSecret is required/
    )
    assert.throws(
        () => provider.validateCredentials({ webhookSecret: 'short' }),
        /webhookSecret is required/
    )
    assert.throws(
        () =>
            provider.validateCredentials({
                webhookSecret: WEBHOOK_SECRET,
                clientId: 'only-id'
            }),
        /either accessToken, or both clientId and clientSecret/
    )
    assert.deepEqual(
        provider.validateCredentials({
            webhookSecret: `  ${WEBHOOK_SECRET}  `,
            accessToken: ' lin_api_manual '
        }),
        {
            clientId: null,
            clientSecret: null,
            webhookSecret: WEBHOOK_SECRET,
            accessToken: 'lin_api_manual'
        }
    )
})

test('linear validateConfig normalizes progress mode and identity fields', () => {
    const provider = makeProvider()
    // Linear has no message-edit API, so a streaming preview cannot exist.
    assert.equal(
        provider.validateConfig({ progressMode: 'preview' }).progressMode,
        'activity'
    )
    assert.equal(provider.validateConfig({}).progressMode, 'activity')
    assert.equal(
        provider.validateConfig({ progressMode: 'final' }).progressMode,
        'final'
    )
    const parsed = provider.validateConfig({
        appUserId: '  app-1  ',
        organizationId: '',
        allowedUserIds: ['u1', ' u1 ', '', 'u2'],
        contextProjection: false
    })
    assert.equal(parsed.appUserId, 'app-1')
    assert.equal(parsed.organizationId, null)
    assert.deepEqual(parsed.allowedUserIds, ['u1', 'u2'])
    assert.equal(parsed.contextProjection, false)
    assert.throws(
        () => provider.validateConfig('nope'),
        /config must be an object/
    )
})

test('linear verifySignature accepts a valid signature and rejects tampering', () => {
    const provider = makeProvider()
    const ctx = makeCtx()
    const body = createdBody()
    assert.deepEqual(provider.verifySignature(reqFor(body), ctx), { ok: true })

    const tampered = reqFor(body)
    tampered.rawBody = `${tampered.rawBody} `
    assert.equal(
        provider.verifySignature(tampered, ctx).reason,
        'signature_mismatch'
    )
    assert.equal(
        provider.verifySignature(
            reqFor(body, { secret: 'other-secret-value-1' }),
            ctx
        ).reason,
        'signature_mismatch'
    )
    assert.equal(
        provider.verifySignature(
            { headers: {}, body, rawBody: JSON.stringify(body) },
            ctx
        ).reason,
        'missing_signature'
    )
    assert.equal(
        provider.verifySignature(reqFor(body), makeCtx({}, null)).reason,
        'webhook_secret_missing'
    )
})

test('linear verifySignature rejects a replayed timestamp', () => {
    const provider = makeProvider()
    const stale = createdBody({ webhookTimestamp: Date.now() - 5 * 60_000 })
    assert.equal(
        provider.verifySignature(reqFor(stale), makeCtx()).reason,
        'timestamp_out_of_range'
    )
    const missing = createdBody({ webhookTimestamp: 'nope' })
    assert.equal(
        provider.verifySignature(reqFor(missing), makeCtx()).reason,
        'bad_timestamp'
    )
})

test('linear parseInbound maps a created session to a mention-driven turn', () => {
    const provider = makeProvider()
    const body = createdBody()
    const event = provider.parseInbound(reqFor(body), makeCtx())
    assert.equal(event.providerEventId, `created:${SESSION}`)
    assert.equal(event.chatId, `${ORG}:${SESSION}`)
    assert.equal(event.chatType, 'group')
    assert.equal(event.isMention, true)
    assert.equal(event.senderId, 'user-linear-1')
    assert.equal(event.senderName, 'Ada L')
    assert.equal(event.text, 'please implement this')
    assert.equal(event.messageId, 'cmt-1')
})

test('linear parseInbound never hands the agent the thread boilerplate', () => {
    const provider = makeProvider()
    const event = provider.parseInbound(reqFor(delegatedBody()), makeCtx())
    // Regression: using this as the instruction sent the agent off
    // investigating its own name instead of working the issue.
    assert.doesNotMatch(event.text, /This thread is for an agent session/)
    assert.match(event.text, /ENG-123/)
    assert.match(event.text, /Fix checkout/)
})

test('linear parseInbound synthesizes a directive when delegation carries no comment', () => {
    const provider = makeProvider()
    const body = createdBody({
        agentSession: {
            id: SESSION,
            creator: { id: 'user-linear-1', name: 'Ada' },
            issue: {
                id: 'iss-1',
                identifier: 'ENG-123',
                title: 'Fix checkout'
            },
            comment: null
        }
    })
    const event = provider.parseInbound(reqFor(body), makeCtx())
    assert.match(event.text, /ENG-123/)
    assert.match(event.text, /Fix checkout/)
    assert.equal(event.messageId, null)
})

test('linear parseInbound falls back to the app user when automation created the session', () => {
    const provider = makeProvider()
    const body = createdBody({
        agentSession: {
            id: SESSION,
            creator: null,
            issue: { id: 'iss-1', identifier: 'ENG-9', title: 'Nightly' },
            comment: null
        }
    })
    const event = provider.parseInbound(reqFor(body), makeCtx())
    assert.equal(event.senderId, 'app-user-1')
    assert.equal(event.senderName, null)
})

test('linear parseInbound maps a prompt to the follow-up text', () => {
    const provider = makeProvider()
    const event = provider.parseInbound(reqFor(promptedBody()), makeCtx())
    assert.equal(event.providerEventId, 'prompted:act-1')
    assert.equal(event.text, 'any update?')
    assert.equal(event.commandInvocation, undefined)
})

test('linear parseInbound attributes a prompt to its author, not the session creator', () => {
    const provider = makeProvider()
    const event = provider.parseInbound(reqFor(promptedBody()), makeCtx())
    assert.equal(
        event.senderId,
        'user-linear-2',
        'anyone in the thread can prompt; the allowlist must see that person'
    )
    assert.equal(event.senderName, 'Grace H')

    // Older or trimmed payloads without the author fall back to the creator.
    const bare = provider.parseInbound(
        reqFor(
            promptedBody({
                agentActivity: {
                    id: 'act-2',
                    content: { type: 'prompt', body: 'still there?' }
                }
            })
        ),
        makeCtx()
    )
    assert.equal(bare.senderId, 'user-linear-1')
})

test('linear parseInbound turns a stop signal into the /stop command', () => {
    const provider = makeProvider()
    const body = promptedBody({
        agentActivity: {
            id: 'act-stop',
            signal: 'stop',
            user: { id: 'user-linear-2', name: 'Grace H' },
            content: { type: 'prompt', body: 'stop please' }
        }
    })
    const event = provider.parseInbound(reqFor(body), makeCtx())
    assert.equal(event.text, '/stop')
    assert.equal(
        event.commandInvocation,
        true,
        'must reach the slash dispatcher, not the agent'
    )
    assert.equal(
        event.senderId,
        'user-linear-2',
        'a stop is driven by whoever pressed it'
    )
})

test('linear parseInbound rejects foreign and empty events', () => {
    const provider = makeProvider()
    assert.throws(
        () =>
            provider.parseInbound(
                reqFor({ type: 'PermissionChange' }),
                makeCtx()
            ),
        (err: Error & { silent?: boolean }) => {
            assert.equal(err.name, 'UnsupportedEventError')
            assert.equal(err.silent, false)
            return true
        }
    )
    assert.throws(
        () =>
            provider.parseInbound(
                reqFor({ type: 'AppUserNotification' }),
                makeCtx()
            ),
        (err: Error & { silent?: boolean }) => {
            assert.equal(err.silent, true, 'inbox mirrors are pure noise')
            return true
        }
    )
    assert.throws(
        () =>
            provider.parseInbound(
                reqFor(
                    promptedBody({
                        agentActivity: { id: 'a', content: { body: '  ' } }
                    })
                ),
                makeCtx()
            ),
        /empty_prompt/
    )
    assert.throws(
        () =>
            provider.parseInbound(
                reqFor(createdBody({ action: 'archived' })),
                makeCtx()
            ),
        /action:archived/
    )
})

test('linear computeScopeKey pins one agent session and names it after the issue', () => {
    const provider = makeProvider()
    const event = provider.parseInbound(reqFor(createdBody()), makeCtx())
    assert.deepEqual(provider.computeScopeKey(event), {
        scopeKey: `linear:${ORG}:${SESSION}`,
        scopeName: 'ENG-123 Fix checkout'
    })
})

test('linear evaluateInboundActor binds the workspace and the app installation', () => {
    const provider = makeProvider()
    const config = baseConfig()
    const event = provider.parseInbound(reqFor(createdBody()), makeCtx())
    assert.deepEqual(provider.evaluateInboundActor(event, config), {
        allowed: true,
        operator: false
    })

    const foreign = provider.parseInbound(
        reqFor(createdBody({ organizationId: 'org-other' })),
        makeCtx({ organizationId: 'org-other' })
    )
    assert.equal(
        provider.evaluateInboundActor(foreign, config).reason,
        'org_mismatch'
    )

    const otherApp = provider.parseInbound(
        reqFor(createdBody({ appUserId: 'app-user-2' })),
        makeCtx()
    )
    assert.equal(
        provider.evaluateInboundActor(otherApp, config).reason,
        'app_user_mismatch'
    )
})

test('linear evaluateInboundActor enforces the allowlist but never gates itself', () => {
    const provider = makeProvider()
    const gated = baseConfig({ allowedUserIds: ['user-allowed'] })
    const human = provider.parseInbound(reqFor(createdBody()), makeCtx())
    assert.equal(
        provider.evaluateInboundActor(human, gated).reason,
        'sender_not_allowed'
    )

    const automation = provider.parseInbound(
        reqFor(
            createdBody({
                agentSession: { id: SESSION, creator: null, comment: null }
            })
        ),
        makeCtx()
    )
    assert.equal(
        provider.evaluateInboundActor(automation, gated).allowed,
        true,
        'the app acting on its own behalf is not an unlisted human'
    )
})

test('linear allowlist gates each follow-up by its author, not the session creator', () => {
    const provider = makeProvider()
    // The session creator is allowlisted; the person writing the follow-up
    // is not. Allowing it would let anyone in the thread drive the agent by
    // riding an allowlisted user's session.
    const gated = baseConfig({ allowedUserIds: ['user-linear-1'] })
    const followUp = provider.parseInbound(reqFor(promptedBody()), makeCtx())
    assert.equal(
        provider.evaluateInboundActor(followUp, gated).reason,
        'sender_not_allowed'
    )

    const fromCreator = provider.parseInbound(
        reqFor(
            promptedBody({
                agentActivity: {
                    id: 'act-3',
                    user: { id: 'user-linear-1', name: 'Ada' },
                    content: { type: 'prompt', body: 'and now?' }
                }
            })
        ),
        makeCtx()
    )
    assert.equal(
        provider.evaluateInboundActor(fromCreator, gated).allowed,
        true
    )
})

test('linear fetchHistoryContext replays promptContext without a network call', async () => {
    const provider = makeProvider()
    const created = provider.parseInbound(reqFor(createdBody()), makeCtx())
    const block = await provider.fetchHistoryContext(makeCtx(), created)
    assert.match(String(block?.text), /Linear issue context/)
    assert.match(String(block?.text), /ENG-123/)

    const prompted = provider.parseInbound(reqFor(promptedBody()), makeCtx())
    assert.equal(
        await provider.fetchHistoryContext(makeCtx(), prompted),
        null,
        'a follow-up adds no issue context'
    )
})

test('linear sendText maps the turn terminal onto the activity type', async () => {
    const scopeKey = `linear:${ORG}:${SESSION}`
    await withLinearMock(async (mock) => {
        const provider = makeProvider()
        const ctx = makeCtx()
        await provider.sendText(ctx, scopeKey, 'all done', {
            terminal: 'final'
        })
        await provider.sendText(ctx, scopeKey, 'it broke', {
            terminal: 'error'
        })
        await provider.sendText(ctx, scopeKey, 'stopped', {
            terminal: 'cancelled'
        })
        await provider.sendText(ctx, scopeKey, 'queued', {
            nonConversational: true
        })
        await provider.sendText(ctx, scopeKey, 'automation says hi')

        assert.deepEqual(
            mock.graphql.map((entry) => activityContent(entry).type),
            ['response', 'error', 'response', 'thought', 'response']
        )
        assert.equal(activityInput(mock.graphql[0]).agentSessionId, SESSION)
        assert.equal(activityContent(mock.graphql[0]).body, 'all done')
    })
})

test('linear sendText upgrades the stop confirmation to a response', async () => {
    const scopeKey = `linear:${ORG}:${SESSION}`
    await withLinearMock(async (mock) => {
        const provider = makeProvider()
        const ctx = makeCtx()
        // The bridge replies to a native command invocation (Linear's only
        // one is the stop signal) with the invocation as interactionRef, so
        // the reply IS the stop confirmation — no cross-request state.
        await provider.sendText(ctx, scopeKey, 'No response in progress.', {
            nonConversational: true,
            interactionRef: 'prompted:act-stop'
        })
        await provider.sendText(ctx, scopeKey, 'Queued', {
            nonConversational: true
        })
        assert.deepEqual(
            mock.graphql.map((entry) => activityContent(entry).type),
            ['response', 'thought'],
            'only the invocation reply confirms; other housekeeping stays a thought'
        )
    })
})

test('linear sendText chunks a long body into same-type activities', async () => {
    await withLinearMock(async (mock) => {
        const provider = makeProvider()
        const long = 'x'.repeat(9_000)
        const sent = await provider.sendText(
            makeCtx(),
            `linear:${ORG}:${SESSION}`,
            long,
            { terminal: 'final' }
        )
        assert.ok(mock.graphql.length > 1, 'body over the cap must be split')
        assert.deepEqual(
            Array.from(
                new Set(mock.graphql.map((e) => activityContent(e).type))
            ),
            ['response'],
            'a chunk must not change the derived session state'
        )
        assert.equal(sent.providerMessageId, 'act-out-1')
    })
})

test('linear sendText rejects a scope key from another provider', async () => {
    const provider = makeProvider()
    await assert.rejects(
        () => provider.sendText(makeCtx(), 'slack:T1:C1', 'hi'),
        /invalid linear scopeKey/
    )
})

test('linear mints one app token and reuses it across calls', async () => {
    await withLinearMock(async (mock) => {
        const provider = makeProvider()
        const ctx = makeCtx()
        await provider.sendText(ctx, `linear:${ORG}:${SESSION}`, 'one')
        await provider.sendText(ctx, `linear:${ORG}:${SESSION}`, 'two')
        assert.equal(mock.tokenMints, 1)
        assert.equal(mock.graphql.length, 2)
    })
})

test('linear uses a pasted access token verbatim and never mints', async () => {
    await withLinearMock(async (mock) => {
        const provider = makeProvider()
        const ctx = makeCtx(
            {},
            makeCredentials({ accessToken: 'manual-token' })
        )
        await provider.sendText(ctx, `linear:${ORG}:${SESSION}`, 'hello')
        assert.equal(mock.tokenMints, 0)
    })
})

test('linear re-mints once when a minted token is rejected', async () => {
    await withLinearMock(
        async (mock) => {
            const provider = makeProvider()
            await provider.sendText(
                makeCtx(),
                `linear:${ORG}:${SESSION}`,
                'after re-mint'
            )
            assert.equal(mock.tokenMints, 2, 'invalidate then mint again')
            assert.equal(mock.graphql.length, 2, 'the call is retried once')
        },
        {
            graphql: [
                {
                    status: 401,
                    body: { errors: [{ message: 'unauthorized' }] }
                },
                {
                    status: 200,
                    body: {
                        data: {
                            agentActivityCreate: {
                                success: true,
                                agentActivity: { id: 'act-out-1' }
                            }
                        }
                    }
                }
            ]
        }
    )
})

test('linear treats a rejected manual token as permanent', async () => {
    await withLinearMock(
        async (mock) => {
            const provider = makeProvider()
            const ctx = makeCtx(
                {},
                makeCredentials({ accessToken: 'manual-token' })
            )
            await assert.rejects(
                () =>
                    provider.sendText(ctx, `linear:${ORG}:${SESSION}`, 'nope'),
                (err: ChannelSendError) => {
                    assert.equal(err.kind, 'forbidden')
                    return true
                }
            )
            assert.equal(mock.tokenMints, 0, 'nothing to re-mint')
            assert.equal(mock.graphql.length, 1, 'and nothing to retry')
        },
        {
            graphql: [
                { status: 401, body: { errors: [{ message: 'unauthorized' }] } }
            ]
        }
    )
})

test('linear classifies rate limits and graphql error codes', async () => {
    await withLinearMock(
        async () => {
            const provider = makeProvider()
            await assert.rejects(
                () =>
                    provider.sendText(
                        makeCtx(),
                        `linear:${ORG}:${SESSION}`,
                        'hi'
                    ),
                (err: ChannelSendError) => {
                    assert.equal(err.kind, 'rate_limited')
                    assert.equal(err.retryAfterMs, 30_000)
                    return true
                }
            )
        },
        {
            graphql: [
                {
                    status: 429,
                    body: { errors: [{ message: 'slow down' }] },
                    headers: { 'retry-after': '30' }
                }
            ]
        }
    )

    await withLinearMock(
        async () => {
            const provider = makeProvider()
            await assert.rejects(
                () =>
                    provider.sendText(
                        makeCtx(),
                        `linear:${ORG}:${SESSION}`,
                        'hi'
                    ),
                (err: ChannelSendError) => {
                    assert.equal(err.kind, 'bad_format')
                    return true
                }
            )
        },
        {
            graphql: [
                {
                    status: 200,
                    body: {
                        errors: [
                            {
                                message: 'bad input',
                                extensions: { code: 'INVALID_INPUT' }
                            }
                        ]
                    }
                }
            ]
        }
    )
})

test('linear keeps an unknown graphql failure retryable', async () => {
    await withLinearMock(
        async () => {
            const provider = makeProvider()
            await assert.rejects(
                () =>
                    provider.sendText(
                        makeCtx(),
                        `linear:${ORG}:${SESSION}`,
                        'hi'
                    ),
                (err: Error) => {
                    assert.equal(
                        err instanceof ChannelSendError,
                        false,
                        'unknown codes must not dead-letter the reply'
                    )
                    assert.match(err.message, /wobbled/)
                    return true
                }
            )
        },
        {
            graphql: [
                {
                    status: 200,
                    body: {
                        errors: [
                            {
                                message: 'the server wobbled',
                                extensions: { code: 'SOMETHING_NEW' }
                            }
                        ]
                    }
                }
            ]
        }
    )
})

test('linear startTyping acknowledges inside the unresponsive window', async () => {
    await withLinearMock(async (mock) => {
        const provider = makeProvider()
        const stop = await provider.startTyping(
            makeCtx(),
            `linear:${ORG}:${SESSION}`
        )
        // The ack is awaited, so it is always the first call out; the issue
        // claim that follows it is deliberately not awaited, which is why this
        // asserts on the first call rather than on a total count.
        assert.ok(mock.graphql.length >= 1, 'the ack is sent, not scheduled')
        assert.equal(activityContent(mock.graphql[0]).type, 'thought')
        assert.equal(
            activityInput(mock.graphql[0]).ephemeral,
            true,
            'the ack is replaced by real progress'
        )
        stop()
        stop()
    })
})

test('linear register captures the app identity and activates the channel', async () => {
    await withLinearMock(
        async (mock) => {
            const provider = makeProvider()
            const result = await provider.register(
                makeCtx({}, makeCredentials(), { status: 'draft' })
            )
            assert.equal(result.ok, true)
            assert.equal(result.activate, true)
            assert.deepEqual(result.configPatch, {
                appUserId: 'viewer-1',
                organizationId: 'org-real',
                workspaceUrlKey: 'acme',
                allowedUserIds: [],
                progressMode: 'activity'
            })
            assert.equal(mock.tokenMints, 1, 'registering proves minting works')
        },
        {
            graphql: [
                {
                    status: 200,
                    body: {
                        data: {
                            viewer: {
                                id: 'viewer-1',
                                name: 'Bot',
                                displayName: 'Bot'
                            },
                            organization: {
                                id: 'org-real',
                                name: 'Acme',
                                urlKey: 'acme'
                            }
                        }
                    }
                }
            ]
        }
    )
})

test('linear register refuses credentials with no token strategy', async () => {
    const provider = makeProvider()
    const result = await provider.register(
        makeCtx({}, { webhookSecret: WEBHOOK_SECRET })
    )
    assert.equal(result.ok, false)
    assert.match(String(result.message), /accessToken/)
})

test('linear test() reports identity and flags a draft channel', async () => {
    await withLinearMock(
        async () => {
            const provider = makeProvider()
            const draft = await provider.test(
                makeCtx({}, makeCredentials(), { status: 'draft' })
            )
            assert.equal(draft.ok, false)
            assert.match(draft.message, /authenticated as Bot/)
            assert.match(draft.message, /still draft/)

            const active = await provider.test(makeCtx())
            assert.equal(active.ok, true)
            assert.match(active.message, /channel status: active/)
        },
        {
            graphql: [
                {
                    status: 200,
                    body: {
                        data: {
                            viewer: {
                                id: 'viewer-1',
                                name: 'Bot',
                                displayName: 'Bot'
                            },
                            organization: {
                                id: 'org-real',
                                name: 'Acme',
                                urlKey: 'acme'
                            }
                        }
                    }
                }
            ]
        }
    )
})

const SCOPE = `linear:${ORG}:${SESSION}`

const mutationNames = (mock: LinearMock): string[] =>
    mock.graphql.map((entry) => {
        const match = /(?:mutation|query)\s+(\w+)/.exec(entry.query)
        return match?.[1] ?? 'unknown'
    })

test('linear projects a tool call as an action activity', async () => {
    await withLinearMock(async (mock) => {
        const provider = makeProvider()
        await provider.onTurnEvent(
            makeCtx(),
            SCOPE,
            {
                type: 'tool_call',
                toolCallId: 't1',
                toolName: 'Bash',
                args: { command: 'pnpm test' }
            },
            { chatSessionId: 'cs-1' }
        )
        const action = activityContent(mock.graphql[0])
        assert.equal(action.type, 'action')
        assert.equal(action.action, 'Bash')
        assert.match(String(action.parameter), /pnpm test/)
    })
})

test('linear names the thing a tool acted on, not the call arguments', async () => {
    const cases: Array<[string, unknown, string]> = [
        [
            'Bash',
            { command: 'pnpm test', description: 'run tests' },
            'pnpm test'
        ],
        ['WebSearch', { query: 'London weather' }, 'London weather'],
        [
            'Edit',
            { file_path: 'src/a.ts', old_string: 'x', new_string: 'y' },
            'src/a.ts'
        ],
        ['Grep', { pattern: 'TODO', path: 'src' }, 'TODO'],
        ['Bash', { command: 'a \\\n  b\n  c' }, 'a \\ b c'],
        ['mcp__weird', { onlyField: 'the value' }, 'the value'],
        ['mcp__weird', { a: 1, b: 2 }, '{"a":1,"b":2}']
    ]
    for (const [toolName, args, expected] of cases) {
        await withLinearMock(async (mock) => {
            const provider = makeProvider()
            await provider.onTurnEvent(
                makeCtx(),
                SCOPE,
                { type: 'tool_call', toolCallId: 't1', toolName, args },
                { chatSessionId: 'cs-1' }
            )
            assert.equal(
                activityContent(mock.graphql[0]).parameter,
                expected,
                `${toolName} ${JSON.stringify(args)}`
            )
        })
    }
})

const claimReplies = (
    session: Record<string, unknown> | null,
    startedStates: Array<{ id: string; position: number }> = [
        { id: 'state-started-2', position: 2 },
        { id: 'state-started-1', position: 1 }
    ]
): GqlReply[] => [
    { status: 200, body: { data: { agentSession: session } } },
    { status: 200, body: { data: { issueUpdate: { success: true } } } },
    {
        status: 200,
        body: { data: { team: { states: { nodes: startedStates } } } }
    },
    { status: 200, body: { data: { issueUpdate: { success: true } } } }
]

const claimIssue = (
    provider: LinearChannelProvider,
    ctx: unknown,
    sessionId = SESSION
): Promise<void> =>
    (
        provider as unknown as {
            claimDelegatedIssue: (c: unknown, s: string) => Promise<void>
        }
    ).claimDelegatedIssue(ctx, sessionId)

test('linear claims a delegated issue and moves it into work', async () => {
    await withLinearMock(
        async (mock) => {
            const provider = makeProvider()
            await claimIssue(provider, makeCtx())
            assert.deepEqual(mutationNames(mock), [
                'AgentSessionIssue',
                'IssueUpdate',
                'TeamStartedStates',
                'IssueUpdate'
            ])
            assert.deepEqual(mock.graphql[1].variables.input, {
                delegateId: 'app-user-1'
            })
            assert.deepEqual(
                mock.graphql[3].variables.input,
                { stateId: 'state-started-1' },
                'the earliest started status, not the first one returned'
            )
        },
        {
            graphql: claimReplies({
                creator: { id: 'human-1' },
                issue: {
                    id: 'issue-1',
                    delegate: null,
                    state: { id: 'state-triage', type: 'triage' },
                    team: { id: 'team-1' }
                }
            })
        }
    )
})

test('linear leaves an automation-delegated issue in triage for a human', async () => {
    await withLinearMock(
        async (mock) => {
            const provider = makeProvider()
            await claimIssue(provider, makeCtx())
            assert.deepEqual(
                mutationNames(mock),
                ['AgentSessionIssue'],
                'no delegate and no status write without a human creator'
            )
        },
        {
            graphql: claimReplies({
                creator: null,
                issue: {
                    id: 'issue-1',
                    delegate: null,
                    state: { id: 'state-triage', type: 'triage' },
                    team: { id: 'team-1' }
                }
            })
        }
    )
})

test('linear leaves an already started issue and an existing delegate alone', async () => {
    await withLinearMock(
        async (mock) => {
            const provider = makeProvider()
            await claimIssue(provider, makeCtx())
            assert.deepEqual(mutationNames(mock), ['AgentSessionIssue'])
        },
        {
            graphql: claimReplies({
                creator: { id: 'human-1' },
                issue: {
                    id: 'issue-1',
                    delegate: { id: 'someone-else' },
                    state: { id: 'state-doing', type: 'started' },
                    team: { id: 'team-1' }
                }
            })
        }
    )
})

test('linear checks a session for delegation only once', async () => {
    await withLinearMock(
        async (mock) => {
            const provider = makeProvider()
            const ctx = makeCtx()
            await claimIssue(provider, ctx)
            const afterFirst = mock.graphql.length
            await claimIssue(provider, ctx)
            assert.equal(
                mock.graphql.length,
                afterFirst,
                'a follow-up prompt does not pay for the lookup again'
            )
        },
        {
            graphql: claimReplies({
                creator: { id: 'human-1' },
                issue: {
                    id: 'issue-1',
                    delegate: null,
                    state: { id: 'state-triage', type: 'triage' },
                    team: { id: 'team-1' }
                }
            })
        }
    )
})

test('linear survives a workspace that rejects the issue writes', async () => {
    await withLinearMock(
        async () => {
            const provider = makeProvider()
            await claimIssue(provider, makeCtx())
        },
        {
            graphql: [
                {
                    status: 200,
                    body: { errors: [{ message: 'Access denied' }] }
                }
            ]
        }
    )
})

test('linear drops a tool result rather than posting it alone', async () => {
    await withLinearMock(async (mock) => {
        const provider = makeProvider()
        await provider.onTurnEvent(
            makeCtx(),
            SCOPE,
            { type: 'tool_result', toolCallId: 't1', result: 'ok' },
            { chatSessionId: 'cs-1' }
        )
        assert.equal(mock.graphql.length, 0)
    })
})

test('linear throttles thinking into one ephemeral thought', async () => {
    await withLinearMock(async (mock) => {
        const provider = makeProvider()
        const ctx = makeCtx()
        for (const text of ['first', 'second', 'third'])
            await provider.onTurnEvent(
                ctx,
                SCOPE,
                { type: 'thinking', text },
                { chatSessionId: 'cs-1' }
            )
        const thoughts = mock.graphql.filter(
            (entry) => activityContent(entry).type === 'thought'
        )
        assert.equal(thoughts.length, 1, 'the burst collapses to one')
        assert.equal(activityInput(thoughts[0]).ephemeral, true)
    })
})

test('linear projects TodoWrite as the session plan, not an action', async () => {
    await withLinearMock(
        async (mock) => {
            const provider = makeProvider()
            await provider.onTurnEvent(
                makeCtx(),
                SCOPE,
                {
                    type: 'tool_call',
                    toolCallId: 't1',
                    toolName: 'TodoWrite',
                    args: {
                        todos: [
                            { content: 'Read the code', status: 'completed' },
                            { content: 'Write the fix', status: 'in_progress' },
                            { content: 'Run tests', status: 'pending' },
                            { content: '', status: 'pending' }
                        ]
                    }
                },
                { chatSessionId: 'cs-1' }
            )
            const planCall = mock.graphql.find((entry) =>
                entry.query.includes('agentSessionUpdate')
            )
            assert.equal(
                (planCall?.variables as { input: { plan: unknown[] } }).input
                    .plan.length,
                3,
                'a blank step is dropped, not sent'
            )
            assert.deepEqual(
                (
                    planCall?.variables as {
                        input: { plan: LinearPlanStepish[] }
                    }
                ).input.plan.map((step) => step.status),
                ['completed', 'inProgress', 'pending']
            )
            assert.ok(
                !mock.graphql.some(
                    (entry) => activityContent(entry).type === 'action'
                ),
                'the plan is the projection — an action would duplicate it'
            )
        },
        {
            graphql: [
                {
                    status: 200,
                    body: { data: { agentSessionUpdate: { success: true } } }
                }
            ]
        }
    )
})

test('linear drops the plan for the session when Linear rejects its shape', async () => {
    await withLinearMock(
        async (mock) => {
            const provider = makeProvider()
            const ctx = makeCtx()
            const todo = {
                type: 'tool_call' as const,
                toolCallId: 't1',
                toolName: 'TodoWrite',
                args: { todos: [{ content: 'step', status: 'pending' }] }
            }
            const info = { chatSessionId: 'cs-1', channelSessionId: 'chs-1' }
            // A rejected plan shape must not throw: it would count as a tap
            // strike and take the rest of the turn's progress with it.
            await provider.onTurnEvent(ctx, SCOPE, todo, info)
            await provider.onTurnEvent(ctx, SCOPE, todo, info)
            assert.equal(
                mutationNames(mock).filter((n) => n === 'AgentSessionUpdate')
                    .length,
                1,
                'it is not retried for this session'
            )
        },
        {
            graphql: [
                {
                    status: 200,
                    body: {
                        errors: [
                            {
                                message: 'plan must be an object',
                                extensions: { code: 'INVALID_INPUT' }
                            }
                        ]
                    }
                }
            ]
        }
    )
})

test('linear stops projecting after repeated failures but keeps replying', async () => {
    await withLinearMock(
        async (mock) => {
            const provider = makeProvider()
            const ctx = makeCtx()
            const call = (n: number) => ({
                type: 'tool_call' as const,
                toolCallId: `t${n}`,
                toolName: 'Bash',
                args: {}
            })
            const info = { chatSessionId: 'cs-1', channelSessionId: 'chs-1' }
            for (let n = 0; n < 3; n += 1)
                await assert.rejects(() =>
                    provider.onTurnEvent(ctx, SCOPE, call(n), info)
                )
            const attemptsBefore = mock.graphql.length
            await provider.onTurnEvent(ctx, SCOPE, call(9), info)
            assert.equal(
                mock.graphql.length,
                attemptsBefore,
                'the circuit is open — no further mutations'
            )
        },
        { graphql: [{ status: 500, body: { errors: [{ message: 'boom' }] } }] }
    )
})

test('linear resets the progress budget on the terminal reply', async () => {
    await withLinearMock(async (mock) => {
        const provider = makeProvider()
        const ctx = makeCtx()
        const info = { chatSessionId: 'cs-1', channelSessionId: 'chs-1' }
        await provider.onTurnEvent(
            ctx,
            SCOPE,
            { type: 'thinking', text: 'first turn' },
            info
        )
        await provider.sendText(ctx, SCOPE, 'done', { terminal: 'final' })
        // A second turn in the same scope must not inherit the throttle.
        await provider.onTurnEvent(
            ctx,
            SCOPE,
            { type: 'thinking', text: 'second turn' },
            info
        )
        assert.equal(
            mock.graphql.filter(
                (entry) => activityContent(entry).type === 'thought'
            ).length,
            2
        )
    })
})

test('linear links the session back to the Manyfold workbench exactly once', async () => {
    await withLinearMock(async (mock) => {
        const provider = makeProvider()
        const ctx = makeCtx()
        const stop = await provider.startTyping(ctx, SCOPE, {
            chatSessionId: 'cs-42'
        })
        stop()
        await provider.startTyping(ctx, SCOPE, { chatSessionId: 'cs-42' })

        const urlCalls = mock.graphql.filter((entry) =>
            entry.query.includes('agentSessionUpdate')
        )
        assert.equal(urlCalls.length, 1, 'added once per chat session')
        const input = (
            urlCalls[0]?.variables as {
                input: { addedExternalUrls?: Array<{ url: string }> }
            }
        ).input
        assert.equal(
            input.addedExternalUrls?.[0]?.url,
            'https://app.manyfold.test/agents/agent-1/chat?sessionId=cs-42'
        )
        assert.ok(
            !('externalLink' in input),
            'externalLink would overwrite every URL on the session'
        )
    })
})

interface LinearPlanStepish {
    content: string
    status: string
}
