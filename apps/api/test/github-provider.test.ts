import type { GithubChannelConfig } from '@manyfold/shared'
import assert from 'node:assert/strict'
import { createHmac, generateKeyPairSync } from 'node:crypto'
import test from 'node:test'
import { getGlobalDispatcher, MockAgent, setGlobalDispatcher } from 'undici'
import type { ChannelRow } from '@manyfold/db'
import { UnsupportedEventError } from '../src/modules/channels/channel-provider'
import { ChannelSendError } from '../src/modules/channels/channel-send-error'
import {
    buildGithubAppManifest,
    convertGithubAppManifestCode,
    GithubChannelProvider
} from '../src/modules/channels/providers/github.provider'

const WEBHOOK_SECRET = 'github-webhook-secret-0001'
const APP_ID = '7'
const REPO = 'Acme/Widgets'
const SCOPE = 'github:acme/widgets:7'

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 })
const TEST_PEM = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string

const makeProvider = (): GithubChannelProvider => new GithubChannelProvider()

const makeChannel = (overrides: Partial<ChannelRow> = {}): ChannelRow =>
    ({
        id: 'chn-1',
        userId: 'user-1',
        agentId: 'agent-1',
        provider: 'github',
        label: 'github test',
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
    overrides: Partial<GithubChannelConfig> = {}
): GithubChannelConfig => ({
    appSlug: 'triage-bot',
    botLogin: 'triage-bot[bot]',
    appHtmlUrl: 'https://github.com/apps/triage-bot',
    allowedRepos: [],
    allowedUserIds: [],
    operatorUserIds: [],
    allowedAssociations: ['OWNER', 'MEMBER', 'COLLABORATOR'],
    progressMode: 'preview',
    ...overrides
})

const makeCredentials = (overrides: Record<string, unknown> = {}) => ({
    appId: APP_ID,
    privateKey: TEST_PEM,
    webhookSecret: WEBHOOK_SECRET,
    ...overrides
})

const makeCtx = (
    config: Partial<GithubChannelConfig> = {},
    credentials: Record<string, unknown> | null = makeCredentials(),
    channel: Partial<ChannelRow> = {}
) =>
    ({
        channel: makeChannel(channel),
        config: baseConfig(config),
        credentials
    }) as never

const signGithub = (rawBody: string, secret = WEBHOOK_SECRET): string =>
    `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`

const issuePayload = (overrides: Record<string, unknown> = {}) => ({
    number: 7,
    title: 'Crash on save',
    body: 'Steps to reproduce: save twice.',
    state: 'open',
    html_url: `https://github.com/${REPO}/issues/7`,
    user: { login: 'ada' },
    author_association: 'OWNER',
    ...overrides
})

const commentEvent = (overrides: Record<string, unknown> = {}) => ({
    action: 'created',
    repository: {
        full_name: REPO,
        html_url: `https://github.com/${REPO}`,
        clone_url: `https://github.com/${REPO}.git`,
        default_branch: 'main'
    },
    issue: issuePayload(),
    comment: {
        id: 111,
        body: '@triage-bot please look into this',
        user: { login: 'ada' },
        author_association: 'OWNER'
    },
    sender: { login: 'ada', type: 'User' },
    installation: { id: 42 },
    ...overrides
})

const issuesEvent = (
    action: string,
    overrides: Record<string, unknown> = {}
) => ({
    action,
    repository: {
        full_name: REPO,
        html_url: `https://github.com/${REPO}`,
        clone_url: `https://github.com/${REPO}.git`,
        default_branch: 'main'
    },
    issue: issuePayload(),
    sender: { login: 'ada', type: 'User' },
    installation: { id: 42 },
    ...overrides
})

const reqFor = (
    eventName: string,
    body: unknown,
    opts: {
        secret?: string
        signature?: string
        delivery?: string
        targetId?: string
        omitTargetId?: boolean
    } = {}
) => {
    const rawBody = JSON.stringify(body)
    const headers: Record<string, string> = {
        'x-github-event': eventName,
        'x-github-delivery': opts.delivery ?? 'delivery-1',
        'x-hub-signature-256':
            opts.signature ?? signGithub(rawBody, opts.secret ?? WEBHOOK_SECRET)
    }
    if (!opts.omitTargetId)
        headers['x-github-hook-installation-target-id'] = opts.targetId ?? APP_ID
    return { headers, body, rawBody }
}

const expectUnsupported = (
    fn: () => unknown,
    expected: { type: string; silent: boolean }
): void => {
    try {
        fn()
        assert.fail('expected UnsupportedEventError')
    } catch (err) {
        assert.ok(
            err instanceof UnsupportedEventError,
            `expected UnsupportedEventError, got ${(err as Error).message}`
        )
        assert.equal(err.eventType, expected.type)
        assert.equal(err.silent, expected.silent)
    }
}

interface MockReply {
    status: number
    body?: unknown
    headers?: Record<string, string>
}

interface MockRoute {
    method: string
    path: RegExp
    replies: MockReply[]
}

interface GithubMock {
    requests: Array<{ method: string; path: string; body: unknown }>
}

const withGithubMock = async (
    run: (mock: GithubMock) => Promise<void>,
    routes: MockRoute[] = []
): Promise<void> => {
    const previous = getGlobalDispatcher()
    const agent = new MockAgent()
    agent.disableNetConnect()
    setGlobalDispatcher(agent)
    const pool = agent.get('https://api.github.com')
    const mock: GithubMock = { requests: [] }
    const counters = new Map<number, number>()
    let commentSeq = 900
    let reactionSeq = 500
    const defaults = (method: string, path: string): MockReply => {
        if (method === 'GET' && path === '/app')
            return {
                status: 200,
                body: {
                    id: 7,
                    slug: 'triage-bot',
                    name: 'Triage Bot',
                    html_url: 'https://github.com/apps/triage-bot'
                }
            }
        if (method === 'GET' && /^\/repos\/[^/]+\/[^/]+\/installation$/.test(path))
            return { status: 200, body: { id: 42 } }
        if (method === 'POST' && /^\/app\/installations\/\d+\/access_tokens$/.test(path))
            return {
                status: 201,
                body: {
                    token: 'inst-token-1',
                    expires_at: new Date(Date.now() + 3_600_000).toISOString()
                }
            }
        if (method === 'GET' && path === '/app/installations?per_page=100')
            return {
                status: 200,
                body: [{ account: { login: 'acme' } }]
            }
        if (method === 'POST' && /\/issues\/\d+\/comments$/.test(path)) {
            commentSeq += 1
            return { status: 201, body: { id: commentSeq } }
        }
        if (method === 'POST' && /\/reactions$/.test(path)) {
            reactionSeq += 1
            return { status: 201, body: { id: reactionSeq } }
        }
        if (method === 'GET' && /\/issues\/\d+\/comments/.test(path))
            return { status: 200, body: [] }
        return { status: 200, body: {} }
    }
    pool.intercept({ path: () => true, method: () => true })
        .reply((opts) => {
            const method = opts.method ?? 'GET'
            let body: unknown
            if (opts.body) {
                try {
                    body = JSON.parse(String(opts.body))
                } catch {
                    body = String(opts.body)
                }
            }
            mock.requests.push({ method, path: opts.path, body })
            for (const [index, route] of routes.entries()) {
                if (route.method !== method) continue
                if (!route.path.test(opts.path)) continue
                const idx = counters.get(index) ?? 0
                counters.set(index, idx + 1)
                const reply =
                    route.replies[Math.min(idx, route.replies.length - 1)]
                return {
                    statusCode: reply.status,
                    data: reply.body ?? {},
                    responseOptions: { headers: reply.headers ?? {} }
                }
            }
            const reply = defaults(method, opts.path)
            return {
                statusCode: reply.status,
                data: reply.body ?? {},
                responseOptions: { headers: reply.headers ?? {} }
            }
        })
        .persist()
    try {
        await run(mock)
    } finally {
        setGlobalDispatcher(previous)
    }
}

test('github validateCredentials enforces app id, PEM and webhook secret', () => {
    const provider = makeProvider()
    assert.equal(provider.validateCredentials(null), null)
    assert.throws(
        () => provider.validateCredentials(makeCredentials({ appId: 'x7' })),
        /numeric GitHub App ID/
    )
    assert.throws(
        () =>
            provider.validateCredentials(
                makeCredentials({ privateKey: 'not a pem' })
            ),
        /privateKey/
    )
    assert.throws(
        () =>
            provider.validateCredentials(
                makeCredentials({ webhookSecret: 'short' })
            ),
        /webhookSecret/
    )
    const base64 = Buffer.from(TEST_PEM, 'utf8').toString('base64')
    const parsed = provider.validateCredentials(
        makeCredentials({ appId: 7, privateKey: base64 })
    )
    assert.equal(parsed?.appId, '7')
    assert.equal(parsed?.privateKey, base64)
})

test('github validateConfig applies fail-closed association defaults', () => {
    const provider = makeProvider()
    const config = provider.validateConfig({})
    assert.deepEqual(config.allowedAssociations, [
        'OWNER',
        'MEMBER',
        'COLLABORATOR'
    ])
    assert.equal(config.progressMode, 'preview')
    assert.equal(config.finalMessageMode, 'edit')
    assert.equal(config.historyBackfill, true)
    assert.equal(config.contextProjection, true)
    const custom = provider.validateConfig({
        allowedAssociations: ['none', 'member'],
        progressMode: 'final',
        finalMessageMode: 'fresh'
    })
    assert.deepEqual(custom.allowedAssociations, ['NONE', 'MEMBER'])
    assert.equal(custom.progressMode, 'final')
    assert.equal(custom.finalMessageMode, 'fresh')
})

test('github verifySignature checks the sha256 prefix over the raw body', () => {
    const provider = makeProvider()
    const ctx = makeCtx()
    const body = commentEvent()
    assert.equal(provider.verifySignature(reqFor('issue_comment', body), ctx).ok, true)
    const badSecret = provider.verifySignature(
        reqFor('issue_comment', body, { secret: 'wrong-secret-000' }),
        ctx
    )
    assert.deepEqual(
        { ok: badSecret.ok, reason: badSecret.reason },
        { ok: false, reason: 'signature_mismatch' }
    )
    const rawBody = JSON.stringify(body)
    const unprefixed = provider.verifySignature(
        {
            headers: {
                'x-github-event': 'issue_comment',
                'x-hub-signature-256': createHmac('sha256', WEBHOOK_SECRET)
                    .update(rawBody)
                    .digest('hex')
            },
            body,
            rawBody
        },
        ctx
    )
    assert.equal(unprefixed.ok, false)
    const missing = provider.verifySignature(
        { headers: {}, body, rawBody },
        ctx
    )
    assert.equal(missing.reason, 'missing_signature')
    const noSecret = provider.verifySignature(
        reqFor('issue_comment', body),
        makeCtx({}, null)
    )
    assert.equal(noSecret.reason, 'webhook_secret_missing')
})

test('github ping answers a challenge so a draft channel connects', () => {
    const provider = makeProvider()
    const check = provider.verifySignature(
        reqFor('ping', { zen: 'Design for failure.' }),
        makeCtx()
    )
    assert.equal(check.ok, true)
    assert.equal(check.challengeResponse?.status, 200)
})

test('github parseInbound turns a mention comment into a turn', () => {
    const provider = makeProvider()
    const event = provider.parseInbound(
        reqFor('issue_comment', commentEvent()),
        makeCtx()
    )
    assert.equal(event.providerEventId, 'delivery-1')
    assert.equal(event.chatId, 'acme/widgets:7')
    assert.equal(event.chatType, 'group')
    assert.equal(event.isMention, true)
    assert.equal(event.senderId, 'ada')
    assert.equal(event.text, 'please look into this')
    assert.equal(event.messageId, 'comment:111')
})

test('github parseInbound drops its own and other bots events on every path', () => {
    const provider = makeProvider()
    expectUnsupported(
        () =>
            provider.parseInbound(
                reqFor(
                    'issue_comment',
                    commentEvent({
                        sender: { login: 'triage-bot[bot]', type: 'Bot' }
                    })
                ),
                makeCtx()
            ),
        { type: 'bot_sender', silent: true }
    )
    // Case-insensitive on the login even when GitHub omits the Bot type.
    expectUnsupported(
        () =>
            provider.parseInbound(
                reqFor(
                    'issue_comment',
                    commentEvent({
                        sender: { login: 'Triage-Bot[bot]', type: 'User' }
                    })
                ),
                makeCtx()
            ),
        { type: 'bot_sender', silent: true }
    )
    // Label delegation is human-only: an automation adding the label must
    // not start a turn (loop guard applies before the trigger check).
    expectUnsupported(
        () =>
            provider.parseInbound(
                reqFor(
                    'issues',
                    issuesEvent('labeled', {
                        label: { name: 'agent' },
                        sender: { login: 'some-ci[bot]', type: 'Bot' }
                    })
                ),
                makeCtx({ triggerLabel: 'agent' })
            ),
        { type: 'bot_sender', silent: true }
    )
})

test('github parseInbound requires a mention outside code and quotes', () => {
    const provider = makeProvider()
    const parse = (body: string) =>
        provider.parseInbound(
            reqFor('issue_comment', commentEvent({ comment: {
                id: 112,
                body,
                user: { login: 'ada' },
                author_association: 'OWNER'
            } })),
            makeCtx()
        )
    expectUnsupported(() => parse('no mention here'), {
        type: 'no_mention',
        silent: true
    })
    expectUnsupported(
        () => parse('```\n@triage-bot inside a fence\n```'),
        { type: 'no_mention', silent: true }
    )
    expectUnsupported(() => parse('`@triage-bot` in inline code'), {
        type: 'no_mention',
        silent: true
    })
    // GitHub email replies quote the previous comment — including its
    // mention — verbatim.
    expectUnsupported(
        () => parse('> @triage-bot please look into this\n\nsounds right'),
        { type: 'no_mention', silent: true }
    )
    // A longer login sharing the prefix is a different user.
    expectUnsupported(() => parse('@triage-bot-2 ping'), {
        type: 'no_mention',
        silent: true
    })
    const event = parse('mid-sentence @Triage-Bot can you take this?')
    assert.equal(event.text, 'mid-sentence @Triage-Bot can you take this?')
})

test('github parseInbound synthesizes a directive for a bare mention', () => {
    const provider = makeProvider()
    const event = provider.parseInbound(
        reqFor(
            'issue_comment',
            commentEvent({
                comment: {
                    id: 113,
                    body: '@triage-bot',
                    user: { login: 'ada' },
                    author_association: 'OWNER'
                }
            })
        ),
        makeCtx()
    )
    assert.match(event.text, /mentioned on GitHub issue Acme\/Widgets#7/)
    assert.match(event.text, /Crash on save/)
})

test('github parseInbound gates repos case-insensitively', () => {
    const provider = makeProvider()
    expectUnsupported(
        () =>
            provider.parseInbound(
                reqFor('issue_comment', commentEvent()),
                makeCtx({ allowedRepos: ['other/repo'] })
            ),
        { type: 'repo_not_allowed', silent: true }
    )
    const event = provider.parseInbound(
        reqFor('issue_comment', commentEvent()),
        makeCtx({ allowedRepos: ['ACME/widgets'] })
    )
    assert.equal(event.chatId, 'acme/widgets:7')
})

test('github parseInbound records an app id mismatch instead of hiding it', () => {
    const provider = makeProvider()
    expectUnsupported(
        () =>
            provider.parseInbound(
                reqFor('issue_comment', commentEvent(), { targetId: '999' }),
                makeCtx()
            ),
        { type: 'app_mismatch', silent: false }
    )
    // Absent header (or absent credentials) skips the check.
    const event = provider.parseInbound(
        reqFor('issue_comment', commentEvent(), { omitTargetId: true }),
        makeCtx()
    )
    assert.equal(event.senderId, 'ada')
})

test('github parseInbound handles issue open mentions and label delegation', () => {
    const provider = makeProvider()
    const opened = provider.parseInbound(
        reqFor(
            'issues',
            issuesEvent('opened', {
                issue: issuePayload({
                    body: '@triage-bot triage this please'
                })
            })
        ),
        makeCtx()
    )
    assert.equal(opened.text, 'triage this please')
    assert.equal(opened.messageId, 'issue')
    expectUnsupported(
        () =>
            provider.parseInbound(
                reqFor('issues', issuesEvent('opened')),
                makeCtx()
            ),
        { type: 'no_mention', silent: true }
    )
    const labeled = provider.parseInbound(
        reqFor('issues', issuesEvent('labeled', { label: { name: 'agent' } })),
        makeCtx({ triggerLabel: 'agent' })
    )
    assert.match(labeled.text, /delegated GitHub issue Acme\/Widgets#7/)
    expectUnsupported(
        () =>
            provider.parseInbound(
                reqFor(
                    'issues',
                    issuesEvent('labeled', { label: { name: 'bug' } })
                ),
                makeCtx({ triggerLabel: 'agent' })
            ),
        { type: 'issues:labeled', silent: true }
    )
    expectUnsupported(
        () =>
            provider.parseInbound(
                reqFor(
                    'issues',
                    issuesEvent('labeled', { label: { name: 'agent' } })
                ),
                makeCtx()
            ),
        { type: 'issues:labeled', silent: true }
    )
})

test('github parseInbound drops non-conversation events silently', () => {
    const provider = makeProvider()
    expectUnsupported(
        () =>
            provider.parseInbound(
                reqFor('installation', { action: 'created' }),
                makeCtx()
            ),
        { type: 'installation', silent: true }
    )
    expectUnsupported(
        () =>
            provider.parseInbound(
                reqFor('issue_comment', commentEvent({ action: 'edited' })),
                makeCtx()
            ),
        { type: 'issue_comment:edited', silent: true }
    )
})

test('github computeScopeKey names the scope after the issue', () => {
    const provider = makeProvider()
    const event = provider.parseInbound(
        reqFor('issue_comment', commentEvent()),
        makeCtx()
    )
    const scope = provider.computeScopeKey(event)
    assert.equal(scope.scopeKey, SCOPE)
    assert.equal(scope.scopeName, 'Acme/Widgets#7 Crash on save')
})

test('github evaluateInboundActor: allowlist wins, association gates the rest', () => {
    const provider = makeProvider()
    const eventFor = (association: string, login = 'ada') =>
        provider.parseInbound(
            reqFor(
                'issue_comment',
                commentEvent({
                    comment: {
                        id: 114,
                        body: '@triage-bot go',
                        user: { login },
                        author_association: association
                    },
                    sender: { login, type: 'User' }
                })
            ),
            makeCtx()
        )
    const memberEvent = eventFor('MEMBER')
    assert.deepEqual(
        provider.evaluateInboundActor(memberEvent, baseConfig() as never),
        { allowed: true, operator: false }
    )
    const outsiderEvent = eventFor('NONE', 'drive-by')
    assert.equal(
        provider.evaluateInboundActor(outsiderEvent, baseConfig() as never)
            .reason,
        'association_not_allowed'
    )
    // Opt into everyone via NONE.
    assert.equal(
        provider.evaluateInboundActor(
            outsiderEvent,
            baseConfig({
                allowedAssociations: ['NONE']
            }) as never
        ).allowed,
        true
    )
    // A non-empty login allowlist is the whole policy: listed wins even with
    // association NONE, unlisted loses even as OWNER.
    const listed = provider.evaluateInboundActor(
        eventFor('NONE', 'Drive-By'),
        baseConfig({ allowedUserIds: ['drive-by'] }) as never
    )
    assert.equal(listed.allowed, true)
    const unlisted = provider.evaluateInboundActor(
        eventFor('OWNER'),
        baseConfig({ allowedUserIds: ['someone-else'] }) as never
    )
    assert.equal(unlisted.reason, 'sender_not_allowed')
    const operator = provider.evaluateInboundActor(
        eventFor('MEMBER'),
        baseConfig({ operatorUserIds: ['ADA'] }) as never
    )
    assert.equal(operator.operator, true)
})

test('github sendText posts a comment and chunks oversize replies', async () => {
    await withGithubMock(async (mock) => {
        const provider = makeProvider()
        const short = await provider.sendText(
            makeCtx() as never,
            SCOPE,
            'done — see the fix'
        )
        assert.equal(short.providerMessageId, '901')
        const posts = mock.requests.filter(
            (r) =>
                r.method === 'POST' &&
                r.path === '/repos/acme/widgets/issues/7/comments'
        )
        assert.equal(posts.length, 1)
        assert.deepEqual(posts[0].body, { body: 'done — see the fix' })
        // The installation token was resolved and minted exactly once.
        assert.equal(
            mock.requests.filter((r) =>
                r.path.endsWith('/installation')
            ).length,
            1
        )
        const long = 'a'.repeat(60_001)
        await provider.sendText(makeCtx() as never, SCOPE, long)
        const longPosts = mock.requests.filter(
            (r) =>
                r.method === 'POST' &&
                r.path === '/repos/acme/widgets/issues/7/comments'
        )
        assert.equal(longPosts.length, 3)
    })
})

test('github rest retries once with a fresh token on 401', async () => {
    await withGithubMock(
        async (mock) => {
            const provider = makeProvider()
            const sent = await provider.sendText(
                makeCtx() as never,
                SCOPE,
                'after re-mint'
            )
            assert.ok(sent.providerMessageId)
            const mints = mock.requests.filter((r) =>
                /access_tokens$/.test(r.path)
            )
            assert.equal(mints.length, 2)
        },
        [
            {
                method: 'POST',
                path: /\/issues\/7\/comments$/,
                replies: [
                    { status: 401, body: { message: 'Bad credentials' } },
                    { status: 201, body: { id: 950 } }
                ]
            }
        ]
    )
})

test('github rest maps 403+retry-after to rate_limited and 403 to forbidden', async () => {
    await withGithubMock(
        async () => {
            const provider = makeProvider()
            await assert.rejects(
                provider.sendText(makeCtx() as never, SCOPE, 'x'),
                (err: unknown) => {
                    assert.ok(err instanceof ChannelSendError)
                    assert.equal(err.kind, 'rate_limited')
                    assert.equal(err.retryAfterMs, 60_000)
                    return true
                }
            )
        },
        [
            {
                method: 'POST',
                path: /\/issues\/7\/comments$/,
                replies: [
                    {
                        status: 403,
                        body: { message: 'secondary rate limit' },
                        headers: { 'retry-after': '60' }
                    }
                ]
            }
        ]
    )
    await withGithubMock(
        async () => {
            const provider = makeProvider()
            await assert.rejects(
                provider.sendText(makeCtx() as never, SCOPE, 'x'),
                (err: unknown) => {
                    assert.ok(err instanceof ChannelSendError)
                    assert.equal(err.kind, 'forbidden')
                    return true
                }
            )
        },
        [
            {
                method: 'POST',
                path: /\/issues\/7\/comments$/,
                replies: [
                    { status: 403, body: { message: 'Resource not accessible' } }
                ]
            }
        ]
    )
})

test('github preview lifecycle edits one comment, fresh overflow comments follow', async () => {
    await withGithubMock(async (mock) => {
        const provider = makeProvider()
        const ctx = makeCtx() as never
        const handle = await provider.sendPreviewStart(ctx, SCOPE)
        assert.equal(handle.providerMessageId, '901')
        await provider.updatePreview(ctx, handle, 'partial answer…')
        await provider.finishPreview(ctx, handle, 'final answer')
        const edits = mock.requests.filter(
            (r) =>
                r.method === 'PATCH' &&
                r.path === '/repos/acme/widgets/issues/comments/901'
        )
        assert.equal(edits.length, 2)
        assert.deepEqual(edits[1].body, { body: 'final answer' })
        await provider.finishPreview(ctx, handle, 'b'.repeat(60_001))
        // One fresh comment for the overflow beyond the edited preview (the
        // other POST on this path was the preview start itself).
        const overflow = mock.requests.filter(
            (r) =>
                r.method === 'POST' &&
                r.path === '/repos/acme/widgets/issues/7/comments' &&
                (r.body as { body?: string }).body?.startsWith('b') === true
        )
        assert.equal(overflow.length, 1)
        await provider.deleteMessage(ctx, SCOPE, handle.providerMessageId)
        const deletes = mock.requests.filter(
            (r) =>
                r.method === 'DELETE' &&
                r.path === '/repos/acme/widgets/issues/comments/901'
        )
        assert.equal(deletes.length, 1)
    })
})

test('github reactions hit the comment or issue endpoint and clear the eyes', async () => {
    await withGithubMock(async (mock) => {
        const provider = makeProvider()
        const ctx = makeCtx() as never
        await provider.setInboundReaction(ctx, SCOPE, 'comment:111', 'working')
        await provider.setInboundReaction(ctx, SCOPE, 'comment:111', 'done')
        const commentReactions = mock.requests.filter((r) =>
            r.path.startsWith(
                '/repos/acme/widgets/issues/comments/111/reactions'
            )
        )
        assert.deepEqual(
            commentReactions.map((r) => [r.method, r.body ?? null]),
            [
                ['POST', { content: 'eyes' }],
                ['POST', { content: 'rocket' }],
                ['DELETE', null]
            ]
        )
        assert.equal(
            commentReactions[2].path.endsWith('/reactions/501'),
            true
        )
        await provider.setInboundReaction(ctx, SCOPE, 'issue', 'working')
        await provider.setInboundReaction(ctx, SCOPE, 'issue', 'failed')
        const issueReactions = mock.requests.filter((r) =>
            r.path.startsWith('/repos/acme/widgets/issues/7/reactions')
        )
        assert.deepEqual(
            issueReactions.map((r) => [r.method, r.body ?? null]),
            [
                ['POST', { content: 'eyes' }],
                ['POST', { content: 'confused' }],
                ['DELETE', null]
            ]
        )
    })
})

test('github fetchHistoryContext replays the issue and recent comments', async () => {
    await withGithubMock(
        async () => {
            const provider = makeProvider()
            const event = provider.parseInbound(
                reqFor('issue_comment', commentEvent()),
                makeCtx()
            )
            const history = await provider.fetchHistoryContext(
                makeCtx() as never,
                event,
                { scopeKey: SCOPE, limit: 10 }
            )
            assert.ok(history)
            const block = history.text
            assert.match(block, /^\[GitHub issue context\]/)
            assert.match(
                block,
                /Repository: Acme\/Widgets \(clone: https:\/\/github.com\/Acme\/Widgets.git, default branch: main\)/
            )
            assert.match(block, /Issue #7: Crash on save \[open\] by @ada/)
            assert.match(block, /Steps to reproduce: save twice\./)
            assert.match(block, /@grace: earlier discussion/)
            // The triggering comment is the turn text, not history.
            assert.ok(!block.includes('please look into this'))
        },
        [
            {
                method: 'GET',
                path: /\/issues\/7\/comments\?per_page=100$/,
                replies: [
                    {
                        status: 200,
                        body: [
                            {
                                id: 90,
                                body: 'earlier discussion',
                                user: { login: 'grace' }
                            },
                            {
                                id: 111,
                                body: '@triage-bot please look into this',
                                user: { login: 'ada' }
                            }
                        ]
                    }
                ]
            }
        ]
    )
})

test('github fetchHistoryContext survives a failing comments fetch', async () => {
    await withGithubMock(
        async () => {
            const provider = makeProvider()
            const event = provider.parseInbound(
                reqFor('issue_comment', commentEvent()),
                makeCtx()
            )
            const history = await provider.fetchHistoryContext(
                makeCtx() as never,
                event,
                { scopeKey: SCOPE, limit: 10 }
            )
            assert.ok(history)
            assert.match(history.text, /Issue #7: Crash on save/)
        },
        [
            {
                method: 'GET',
                path: /\/issues\/7\/comments\?per_page=100$/,
                replies: [{ status: 500, body: { message: 'boom' } }]
            }
        ]
    )
})

test('github reconcileSend matches only the bot-authored exact last chunk', async () => {
    const listed = (comments: unknown[]): MockRoute[] => [
        {
            method: 'GET',
            path: /\/issues\/7\/comments\?since=/,
            replies: [{ status: 200, body: comments }]
        }
    ]
    const attempt = {
        scopeKey: SCOPE,
        target: null,
        text: 'the reply',
        attemptStartedAt: new Date()
    }
    await withGithubMock(async () => {
        const provider = makeProvider()
        const found = await provider.reconcileSend(makeCtx() as never, attempt)
        assert.deepEqual(found, { outcome: 'not_sent' })
    }, listed([]))
    await withGithubMock(async () => {
        const provider = makeProvider()
        const found = await provider.reconcileSend(makeCtx() as never, attempt)
        assert.deepEqual(found, {
            outcome: 'sent',
            providerMessageId: '77'
        })
    }, listed([
        {
            id: 76,
            body: 'the reply',
            user: { login: 'ada' }
        },
        {
            id: 77,
            body: 'the reply',
            user: { login: 'triage-bot[bot]' }
        }
    ]))
    await withGithubMock(async () => {
        const provider = makeProvider()
        const unknown = await provider.reconcileSend(
            makeCtx({ botLogin: null }) as never,
            attempt
        )
        assert.deepEqual(unknown, { outcome: 'unknown' })
    }, listed([]))
})

test('github register captures the app identity and activates', async () => {
    await withGithubMock(async () => {
        const provider = makeProvider()
        const skipped = await provider.register(makeCtx({}, null) as never)
        assert.equal(skipped.ok, true)
        assert.equal(skipped.activate, undefined)
        const result = await provider.register(
            makeCtx({ appSlug: null, botLogin: null }) as never
        )
        assert.equal(result.ok, true)
        assert.equal(result.activate, true)
        const patch = result.configPatch as GithubChannelConfig
        assert.equal(patch.appSlug, 'triage-bot')
        assert.equal(patch.botLogin, 'triage-bot[bot]')
        assert.equal(patch.appHtmlUrl, 'https://github.com/apps/triage-bot')
        assert.match(result.message ?? '', /Triage Bot/)
    })
})

test('github test reports identity, installations and channel status', async () => {
    await withGithubMock(async () => {
        const provider = makeProvider()
        const missing = await provider.test(makeCtx({}, null) as never)
        assert.equal(missing.ok, false)
        const draft = await provider.test(
            makeCtx({}, makeCredentials(), { status: 'draft' }) as never
        )
        assert.equal(draft.ok, false)
        assert.match(draft.message, /still draft/)
        const active = await provider.test(makeCtx() as never)
        assert.equal(active.ok, true)
        assert.match(active.message, /Triage Bot/)
        assert.match(active.message, /installed on: acme/)
    })
    await withGithubMock(
        async () => {
            const provider = makeProvider()
            const uninstalled = await provider.test(makeCtx() as never)
            assert.equal(uninstalled.ok, false)
            assert.match(uninstalled.message, /not installed anywhere/)
        },
        [
            {
                method: 'GET',
                path: /^\/app\/installations/,
                replies: [{ status: 200, body: [] }]
            }
        ]
    )
})

test('github app manifest keeps least-privilege permissions', () => {
    const manifest = buildGithubAppManifest({
        name: 'a-very-long-channel-label-that-exceeds-github-limit',
        homepageUrl: 'https://app.manyfold.test',
        hookUrl: 'https://api.manyfold.test/api/channels/hooks/github/chn-1',
        redirectUrl:
            'https://api.manyfold.test/api/channels/github/manifest-callback'
    })
    assert.equal((manifest.name as string).length, 34)
    assert.deepEqual(manifest.default_events, ['issues', 'issue_comment'])
    assert.deepEqual(manifest.default_permissions, {
        issues: 'write',
        pull_requests: 'write'
    })
    assert.equal(manifest.public, false)
    assert.deepEqual(manifest.hook_attributes, {
        url: 'https://api.manyfold.test/api/channels/hooks/github/chn-1',
        active: true
    })
})

test('github manifest conversion returns the new app credentials', async () => {
    await withGithubMock(
        async (mock) => {
            const conversion = await convertGithubAppManifestCode('code-123')
            assert.deepEqual(conversion, {
                appId: '7',
                slug: 'triage-bot',
                name: 'Triage Bot',
                htmlUrl: 'https://github.com/apps/triage-bot',
                pem: TEST_PEM,
                webhookSecret: 'hook-secret-from-github'
            })
            assert.equal(
                mock.requests[0].path,
                '/app-manifests/code-123/conversions'
            )
        },
        [
            {
                method: 'POST',
                path: /^\/app-manifests\//,
                replies: [
                    {
                        status: 201,
                        body: {
                            id: 7,
                            slug: 'triage-bot',
                            name: 'Triage Bot',
                            html_url: 'https://github.com/apps/triage-bot',
                            pem: TEST_PEM,
                            webhook_secret: 'hook-secret-from-github'
                        }
                    }
                ]
            }
        ]
    )
    await withGithubMock(
        async () => {
            await assert.rejects(
                convertGithubAppManifestCode('expired'),
                /manifest conversion failed/
            )
        },
        [
            {
                method: 'POST',
                path: /^\/app-manifests\//,
                replies: [{ status: 404, body: { message: 'Not Found' } }]
            }
        ]
    )
})
