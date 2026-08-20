import test, { beforeEach } from 'node:test'
import assert from 'node:assert/strict'

const store = new Map<string, string>()
let failReads = false
let failWrites = false

;(globalThis as { window?: unknown }).window = {
    localStorage: {
        getItem: (key: string) => {
            if (failReads) throw new Error('storage read denied')
            return store.get(key) ?? null
        },
        setItem: (key: string, value: string) => {
            if (failWrites) throw new Error('quota exceeded')
            store.set(key, value)
        }
    }
}

const KEY = 'nca.chat.scrollPosition.v1'
const DAY = 24 * 60 * 60 * 1000
const NOW = 1_760_000_000_000

const {
    CHAT_SCROLL_ANCHOR_MAX_PAGE_LOADS,
    CHAT_SCROLL_BOTTOM,
    CHAT_SCROLL_MAX_AGE_MS,
    CHAT_SCROLL_MAX_ENTRIES,
    CHAT_SCROLL_RESTORE_COMMAND,
    advanceChatScrollRestoration,
    beginChatScrollRestoration,
    captureChatScrollPosition,
    chatAnchorScrollTop,
    chatMessageAnchorId,
    chatScrollScopeKey,
    handoffChatScrollScope,
    isChatViewportAtBottom,
    parseChatScrollStore,
    readChatScrollPosition,
    shouldRestoreChatScrollScope,
    unpositionedChatScrollRestoration,
    writeChatScrollPosition
} = await import('../src/lib/chatScrollMemory')

const scope = (
    accountKey: string | null,
    agentId: string | null,
    sessionId: string | null
): string | null => chatScrollScopeKey({ accountKey, agentId, sessionId })

const anchorPosition = {
    mode: 'anchor' as const,
    anchor: { messageId: 'msg_b', offset: -100 }
}

beforeEach(() => {
    store.clear()
    failReads = false
    failWrites = false
})

const viewport = { scrollTop: 1200, scrollHeight: 4000, clientHeight: 600 }
const messageTops = [
    { messageId: 'msg_a', top: -700 },
    { messageId: 'msg_b', top: -100 },
    { messageId: 'msg_c', top: 200 },
    { messageId: 'msg_d', top: 1400 }
]

test('mid-history is captured by message and relative offset', () => {
    assert.deepEqual(captureChatScrollPosition(viewport, messageTops), {
        mode: 'anchor',
        anchor: { messageId: 'msg_b', offset: -100 }
    })
})

test('bottom, short and detached viewports have distinct outcomes', () => {
    assert.deepEqual(
        captureChatScrollPosition(
            { scrollTop: 3400, scrollHeight: 4000, clientHeight: 600 },
            messageTops
        ),
        CHAT_SCROLL_BOTTOM
    )
    assert.deepEqual(
        captureChatScrollPosition(
            { scrollTop: 0, scrollHeight: 400, clientHeight: 600 },
            [{ messageId: 'msg_a', top: 0 }]
        ),
        CHAT_SCROLL_BOTTOM
    )
    assert.equal(
        captureChatScrollPosition(
            { scrollTop: 0, scrollHeight: 0, clientHeight: 0 },
            messageTops
        ),
        null
    )
    assert.equal(captureChatScrollPosition(viewport, []), null)
    assert.equal(
        isChatViewportAtBottom({
            scrollTop: 3200,
            scrollHeight: 4000,
            clientHeight: 600
        }),
        false
    )
})

test('the first rendered message anchors a short transcript below the top', () => {
    assert.deepEqual(
        captureChatScrollPosition(
            { scrollTop: 40, scrollHeight: 4000, clientHeight: 600 },
            [
                { messageId: 'msg_a', top: 60 },
                { messageId: 'msg_b', top: 700 }
            ]
        ),
        { mode: 'anchor', anchor: { messageId: 'msg_a', offset: 60 } }
    )
})

test('duplicate message ids use the first DOM occurrence consistently', () => {
    assert.deepEqual(
        captureChatScrollPosition(viewport, [
            { messageId: 'msg_duplicate', top: -80 },
            { messageId: 'msg_duplicate', top: -10 },
            { messageId: 'msg_after', top: 50 }
        ]),
        {
            mode: 'anchor',
            anchor: { messageId: 'msg_duplicate', offset: -80 }
        }
    )
})

test('persistent and streaming rows use the same validated anchor adapter', () => {
    const persistentId = chatMessageAnchorId('msg_persisted')
    const streamingId = chatMessageAnchorId('msg_streaming')
    assert.equal(persistentId, 'msg_persisted')
    assert.equal(streamingId, 'msg_streaming')
    assert.equal(chatMessageAnchorId(''), null)
    assert.equal(chatMessageAnchorId('m'.repeat(129)), null)

    assert.deepEqual(
        captureChatScrollPosition(viewport, [
            { messageId: persistentId as string, top: -500 },
            { messageId: streamingId as string, top: -20 }
        ]),
        {
            mode: 'anchor',
            anchor: { messageId: 'msg_streaming', offset: -20 }
        }
    )
})

test('anchor restoration preserves offset through reflow and clamps safely', () => {
    const top = chatAnchorScrollTop(
        { scrollTop: 0, scrollHeight: 5000, clientHeight: 600 },
        2300,
        -100
    )
    assert.equal(top, 2400)
    assert.equal(2300 - top, -100)
    assert.equal(
        chatAnchorScrollTop(
            { scrollTop: 0, scrollHeight: 1000, clientHeight: 600 },
            900,
            -5000
        ),
        400
    )
    assert.equal(
        chatAnchorScrollTop(
            { scrollTop: 0, scrollHeight: 1000, clientHeight: 600 },
            10,
            5000
        ),
        0
    )
})

test('scope is isolated by account, agent and session and fails closed', () => {
    const mine = scope('usr_1', 'agt_1', 'ses_1')
    assert.ok(mine)
    writeChatScrollPosition(mine, anchorPosition, NOW)

    assert.deepEqual(readChatScrollPosition(mine, NOW), anchorPosition)
    assert.equal(
        readChatScrollPosition(scope('usr_2', 'agt_1', 'ses_1'), NOW),
        null
    )
    assert.equal(
        readChatScrollPosition(scope('usr_1', 'agt_2', 'ses_1'), NOW),
        null
    )
    assert.equal(
        readChatScrollPosition(scope('usr_1', 'agt_1', 'ses_2'), NOW),
        null
    )
    assert.equal(scope(null, 'agt_1', 'ses_1'), null)
    assert.equal(scope('usr_1', null, 'ses_1'), null)
    assert.equal(scope('usr_1', 'agt_1', null), null)
    assert.equal(scope('', 'agt_1', 'ses_1'), null)
    assert.equal(scope('u'.repeat(201), 'agt_1', 'ses_1'), null)
    writeChatScrollPosition(null, CHAT_SCROLL_BOTTOM, NOW)
    assert.equal(store.size, 1)
})

test('valid encoded scope parts remain readable at their maximum length', () => {
    const part = '界'.repeat(200)
    const key = scope(part, part, part)
    assert.ok(key)
    assert.ok(key.length > 640)
    writeChatScrollPosition(key, CHAT_SCROLL_BOTTOM, NOW)
    assert.deepEqual(readChatScrollPosition(key, NOW), CHAT_SCROLL_BOTTOM)
    assert.equal(scope('\ud800', 'agt_1', 'ses_1'), null)
    assert.notEqual(
        scope('usr_1|agt_1', 'ses_1', 'x'),
        scope('usr_1', 'agt_1', 'ses_1|x')
    )
})

test('the persisted store is bounded to the newest captures', () => {
    const finalNow = NOW + CHAT_SCROLL_MAX_ENTRIES + 12
    for (let i = 0; i < CHAT_SCROLL_MAX_ENTRIES + 12; i++) {
        writeChatScrollPosition(
            scope('usr_1', 'agt_1', `ses_${i}`),
            CHAT_SCROLL_BOTTOM,
            NOW + i
        )
    }
    const raw = store.get(KEY)
    assert.ok(raw)
    assert.equal(
        Object.keys(JSON.parse(raw) as Record<string, unknown>).length,
        CHAT_SCROLL_MAX_ENTRIES
    )
    assert.equal(
        readChatScrollPosition(scope('usr_1', 'agt_1', 'ses_0'), finalNow),
        null
    )
    assert.deepEqual(
        readChatScrollPosition(
            scope('usr_1', 'agt_1', `ses_${CHAT_SCROLL_MAX_ENTRIES + 11}`),
            finalNow
        ),
        CHAT_SCROLL_BOTTOM
    )
})

test('an oversized untrusted store is bounded while it is parsed', () => {
    const raw: Record<string, unknown> = {}
    for (let i = 0; i < CHAT_SCROLL_MAX_ENTRIES + 20; i++) {
        raw[`scope_${i}`] = {
            mode: 'bottom',
            updatedAt: NOW - i
        }
    }
    const parsed = parseChatScrollStore(JSON.stringify(raw), NOW)
    assert.equal(Object.keys(parsed).length, CHAT_SCROLL_MAX_ENTRIES)
    assert.ok(parsed.scope_0)
    assert.equal(parsed[`scope_${CHAT_SCROLL_MAX_ENTRIES + 19}`], undefined)
})

test('expired and future-dated entries are rejected', () => {
    const key = scope('usr_1', 'agt_1', 'ses_1')
    writeChatScrollPosition(key, CHAT_SCROLL_BOTTOM, NOW)
    assert.deepEqual(
        readChatScrollPosition(key, NOW + CHAT_SCROLL_MAX_AGE_MS - DAY),
        CHAT_SCROLL_BOTTOM
    )
    assert.equal(
        readChatScrollPosition(key, NOW + CHAT_SCROLL_MAX_AGE_MS + 1),
        null
    )
    assert.equal(readChatScrollPosition(key, NOW - 1), null)
})

test('malformed stored values are dropped independently', () => {
    const cases = [
        '{not json',
        '[]',
        'null',
        JSON.stringify({ k: null }),
        JSON.stringify({ k: { mode: 'anchor', updatedAt: NOW } }),
        JSON.stringify({
            k: { mode: 'anchor', messageId: '', offset: 0, updatedAt: NOW }
        }),
        JSON.stringify({
            k: {
                mode: 'anchor',
                messageId: 'm'.repeat(129),
                offset: 0,
                updatedAt: NOW
            }
        }),
        JSON.stringify({
            k: {
                mode: 'anchor',
                messageId: 'msg_b',
                offset: 1e9,
                updatedAt: NOW
            }
        }),
        JSON.stringify({ k: { mode: 'elsewhere', updatedAt: NOW } }),
        JSON.stringify({ k: { mode: 'bottom' } }),
        JSON.stringify({ k: { mode: 'bottom', updatedAt: 'today' } }),
        JSON.stringify({
            ['x'.repeat(8000)]: { mode: 'bottom', updatedAt: NOW }
        })
    ]
    for (const raw of cases)
        assert.deepEqual(parseChatScrollStore(raw, NOW), {})

    assert.deepEqual(
        Object.keys(
            parseChatScrollStore(
                JSON.stringify({
                    good: { mode: 'bottom', updatedAt: NOW },
                    bad: { mode: 'anchor', offset: 3, updatedAt: NOW }
                }),
                NOW
            )
        ),
        ['good']
    )
})

test('storage errors neither throw nor overwrite unread entries', () => {
    const first = scope('usr_1', 'agt_1', 'ses_1')
    const second = scope('usr_1', 'agt_1', 'ses_2')
    writeChatScrollPosition(first, CHAT_SCROLL_BOTTOM, NOW)
    const before = store.get(KEY)

    failReads = true
    assert.doesNotThrow(() =>
        writeChatScrollPosition(second, CHAT_SCROLL_BOTTOM, NOW + 1)
    )
    failReads = false
    assert.equal(store.get(KEY), before)
    assert.deepEqual(readChatScrollPosition(first, NOW), CHAT_SCROLL_BOTTOM)
    assert.equal(readChatScrollPosition(second, NOW + 1), null)

    failWrites = true
    assert.doesNotThrow(() =>
        writeChatScrollPosition(second, CHAT_SCROLL_BOTTOM, NOW + 1)
    )
})

test('a corrupt store recovers on the next successful capture', () => {
    store.set(KEY, '{not json')
    const key = scope('usr_1', 'agt_1', 'ses_1')
    writeChatScrollPosition(key, CHAT_SCROLL_BOTTOM, NOW)
    assert.deepEqual(readChatScrollPosition(key, NOW), CHAT_SCROLL_BOTTOM)
})

test('bottom restoration positions immediately and keeps following enabled', () => {
    const transition = beginChatScrollRestoration(CHAT_SCROLL_BOTTOM)
    assert.equal(transition.command, CHAT_SCROLL_RESTORE_COMMAND.pinBottom)
    assert.deepEqual(transition.state, { positioned: true, pending: null })
})

test('anchor restoration applies as soon as the anchor is present', () => {
    const started = beginChatScrollRestoration(anchorPosition)
    assert.equal(started.command, CHAT_SCROLL_RESTORE_COMMAND.none)
    const found = advanceChatScrollRestoration(started.state, {
        anchorFound: true,
        hasMore: true,
        loadingOlder: false
    })
    assert.equal(found.command, CHAT_SCROLL_RESTORE_COMMAND.applyAnchor)
    assert.deepEqual(found.state, { positioned: true, pending: null })
})

test('pagination waits for each request and performs at most four loads', () => {
    let state = beginChatScrollRestoration(anchorPosition).state
    for (let i = 1; i <= CHAT_SCROLL_ANCHOR_MAX_PAGE_LOADS; i++) {
        const load = advanceChatScrollRestoration(state, {
            anchorFound: false,
            hasMore: true,
            loadingOlder: false
        })
        assert.equal(load.command, CHAT_SCROLL_RESTORE_COMMAND.loadOlder)
        assert.equal(load.state.pending?.loadedPages, i)
        state = load.state

        const wait = advanceChatScrollRestoration(state, {
            anchorFound: false,
            hasMore: true,
            loadingOlder: true
        })
        assert.equal(wait.command, CHAT_SCROLL_RESTORE_COMMAND.pinBottom)
        assert.equal(wait.state.pending?.loadedPages, i)
        state = wait.state
    }

    const fallback = advanceChatScrollRestoration(state, {
        anchorFound: false,
        hasMore: true,
        loadingOlder: false
    })
    assert.equal(fallback.command, CHAT_SCROLL_RESTORE_COMMAND.pinBottom)
    assert.deepEqual(fallback.state, { positioned: true, pending: null })
})

test('an anchor found during the fourth in-flight page wins over fallback', () => {
    let state = beginChatScrollRestoration(anchorPosition).state
    for (let i = 0; i < CHAT_SCROLL_ANCHOR_MAX_PAGE_LOADS; i++) {
        state = advanceChatScrollRestoration(state, {
            anchorFound: false,
            hasMore: true,
            loadingOlder: false
        }).state
    }
    const found = advanceChatScrollRestoration(state, {
        anchorFound: true,
        hasMore: true,
        loadingOlder: true
    })
    assert.equal(found.command, CHAT_SCROLL_RESTORE_COMMAND.applyAnchor)
    assert.deepEqual(found.state, { positioned: true, pending: null })
})

test('an empty page completion advances or terminates the search', () => {
    const first = advanceChatScrollRestoration(
        beginChatScrollRestoration(anchorPosition).state,
        { anchorFound: false, hasMore: true, loadingOlder: false }
    )
    const next = advanceChatScrollRestoration(first.state, {
        anchorFound: false,
        hasMore: true,
        loadingOlder: false
    })
    assert.equal(next.command, CHAT_SCROLL_RESTORE_COMMAND.loadOlder)
    assert.equal(next.state.pending?.loadedPages, 2)

    const ended = advanceChatScrollRestoration(first.state, {
        anchorFound: false,
        hasMore: false,
        loadingOlder: false
    })
    assert.equal(ended.command, CHAT_SCROLL_RESTORE_COMMAND.pinBottom)
    assert.deepEqual(ended.state, { positioned: true, pending: null })
})

test('scope handoff captures the old positioned conversation under its key', () => {
    const positioned = beginChatScrollRestoration(CHAT_SCROLL_BOTTOM).state
    const handoff = handoffChatScrollScope('old', 'new', positioned)
    assert.equal(handoff.changed, true)
    assert.equal(handoff.captureScopeKey, 'old')
    assert.deepEqual(handoff.state, unpositionedChatScrollRestoration())

    const repeated = handoffChatScrollScope('new', 'new', handoff.state)
    assert.equal(repeated.changed, false)
    assert.equal(repeated.state, handoff.state)

    const restoring = beginChatScrollRestoration(anchorPosition).state
    assert.equal(
        handoffChatScrollScope('old', 'new', restoring).captureScopeKey,
        null
    )
})

test('identity hydration can restore an already-loaded first page exactly once', () => {
    assert.equal(
        shouldRestoreChatScrollScope({
            scopeKey: null,
            restoredScopeKey: null,
            loadedAgentId: 'agt_1',
            activeAgentId: 'agt_1',
            loadedSessionId: 'ses_1',
            activeSessionId: 'ses_1'
        }),
        false
    )
    const hydrated = scope('usr_1', 'agt_1', 'ses_1')
    assert.equal(
        shouldRestoreChatScrollScope({
            scopeKey: hydrated,
            restoredScopeKey: null,
            loadedAgentId: 'agt_1',
            activeAgentId: 'agt_1',
            loadedSessionId: 'ses_1',
            activeSessionId: 'ses_1'
        }),
        true
    )
    assert.equal(
        shouldRestoreChatScrollScope({
            scopeKey: hydrated,
            restoredScopeKey: hydrated,
            loadedAgentId: 'agt_1',
            activeAgentId: 'agt_1',
            loadedSessionId: 'ses_1',
            activeSessionId: 'ses_1'
        }),
        false
    )
    assert.equal(
        shouldRestoreChatScrollScope({
            scopeKey: scope('usr_2', 'agt_1', 'ses_1'),
            restoredScopeKey: hydrated,
            loadedAgentId: 'agt_1',
            activeAgentId: 'agt_1',
            loadedSessionId: 'ses_1',
            activeSessionId: 'ses_1'
        }),
        true
    )
    assert.equal(
        shouldRestoreChatScrollScope({
            scopeKey: hydrated,
            restoredScopeKey: null,
            loadedAgentId: 'agt_1',
            activeAgentId: 'agt_1',
            loadedSessionId: 'ses_old',
            activeSessionId: 'ses_1'
        }),
        false
    )
    assert.equal(
        shouldRestoreChatScrollScope({
            scopeKey: scope('usr_1', 'agt_2', 'ses_1'),
            restoredScopeKey: hydrated,
            loadedAgentId: 'agt_1',
            activeAgentId: 'agt_2',
            loadedSessionId: 'ses_1',
            activeSessionId: 'ses_1'
        }),
        false
    )
})

test('the Settings round trip restores the same message and relative offset', () => {
    const key = scope('usr_1', 'agt_1', 'ses_1')
    writeChatScrollPosition(
        key,
        captureChatScrollPosition(viewport, messageTops),
        NOW
    )
    const returned = readChatScrollPosition(key, NOW + 30_000)
    assert.ok(returned?.mode === 'anchor')
    const started = beginChatScrollRestoration(returned)
    const found = advanceChatScrollRestoration(started.state, {
        anchorFound: true,
        hasMore: true,
        loadingOlder: false
    })
    assert.equal(found.command, CHAT_SCROLL_RESTORE_COMMAND.applyAnchor)
    assert.equal(
        chatAnchorScrollTop(
            { scrollTop: 0, scrollHeight: 4200, clientHeight: 600 },
            1240,
            returned.anchor.offset
        ),
        1340
    )
})
