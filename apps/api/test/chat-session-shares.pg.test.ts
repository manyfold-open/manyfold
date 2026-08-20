import type {
    ChatContentBlock,
    ChatRole
} from '@manyfold/shared'
import 'tsconfig-paths/register'
import 'reflect-metadata'
import 'dotenv/config'
import assert from 'node:assert/strict'
import { randomBytes, randomUUID } from 'node:crypto'
import test from 'node:test'
import { eq, inArray } from 'drizzle-orm'
import {
    BadRequestException,
    ConflictException,
    NotFoundException
} from '@nestjs/common'
import {
    agentRuntimes,
    agents,
    channelSessions,
    channels,
    chatMessages,
    chatSessions,
    chatSessionShares,
    createDb,
    users,
    type Database
} from '@manyfold/db'
import { ChatRepository } from '../src/modules/chat/chat.repository'
import { ChatSessionSharesService } from '../src/modules/chat/chat-session-shares.service'

// Real-Postgres proof of chat session sharing: create is idempotent under the
// partial unique index, the cutoff freezes the public transcript at share
// time (later + inflight messages stay private), resolve is uniformly null
// for revoked/unknown/cascade-deleted shares, the public surface leaks no
// internal ids, emails or grant tokens, and history rewrites auto-revoke
// active shares. Env-gated:
//   RUN_PG_E2E=1 DATABASE_URL=postgres://postgres:postgres@localhost:5432/nca \
//     node --import tsx --test test/chat-session-shares.pg.test.ts
const RUN = process.env.RUN_PG_E2E === '1'

interface Harness {
    db: Database
    suffix: string
    ownerId: string
    otherId: string
    agentId: string
    repo: ChatRepository
    shares: ChatSessionSharesService
    close: () => Promise<void>
}

const buildHarness = async (): Promise<Harness> => {
    const url = process.env.DATABASE_URL
    if (!url) throw new Error('DATABASE_URL must be set in .env')
    const db = createDb(url)
    const suffix = randomBytes(6).toString('hex')
    const ownerId = `user_pgcshare_a_${suffix}`
    const otherId = `user_pgcshare_b_${suffix}`
    await db.insert(users).values([
        {
            id: ownerId,
            email: `a-${suffix}@pgtest.local`,
            displayName: `Owner ${suffix}`
        },
        { id: otherId, email: `b-${suffix}@pgtest.local` }
    ])
    const runtimeId = `art_pgcshare_${suffix}`
    await db.insert(agentRuntimes).values({
        id: runtimeId,
        userId: ownerId,
        name: `pgcshare-runtime-${suffix}`,
        framework: 'codex',
        kind: 'sprites'
    })
    const agentId = `agt_pgcshare_${suffix}`
    await db.insert(agents).values({
        id: agentId,
        userId: ownerId,
        name: `pgcshare-agent-${suffix}`,
        framework: 'codex',
        runtime: 'sprites',
        runtimeId,
        internalId: `pgcshare-${suffix}`
    })
    const repo = new ChatRepository(db)
    const config = { get: () => undefined } as never
    const shares = new ChatSessionSharesService(db, repo, config)
    return {
        db,
        suffix,
        ownerId,
        otherId,
        agentId,
        repo,
        shares,
        close: async (): Promise<void> => {
            await db
                .delete(users)
                .where(inArray(users.id, [ownerId, otherId]))
        }
    }
}

const createSession = async (
    h: Harness,
    title = 'pg share session'
): Promise<string> => {
    const id = `cts_pgcshare_${randomUUID().replaceAll('-', '')}`
    await h.db.insert(chatSessions).values({
        id,
        userId: h.ownerId,
        agentId: h.agentId,
        title
    })
    return id
}

let clock = Date.parse('2026-01-01T00:00:00Z')

const addMessage = async (
    h: Harness,
    sessionId: string,
    role: ChatRole,
    blocks: ChatContentBlock[]
): Promise<{ id: string; createdAt: Date }> => {
    const id = `msg_${randomUUID()}`
    clock += 1000
    const createdAt = new Date(clock)
    await h.db.insert(chatMessages).values({
        id,
        sessionId,
        role,
        contentBlocksJson: blocks,
        createdAt
    })
    return { id, createdAt }
}

const textBlock = (text: string): ChatContentBlock => ({ type: 'text', text })

const seedSession = async (
    h: Harness,
    texts: string[] = ['hello', 'world']
): Promise<string> => {
    const sessionId = await createSession(h)
    for (const [i, text] of texts.entries())
        await addMessage(h, sessionId, i % 2 === 0 ? 'user' : 'assistant', [
            textBlock(text)
        ])
    return sessionId
}

const publicTexts = async (
    h: Harness,
    shareId: string
): Promise<string[]> => {
    const page = await h.shares.listPublicMessages(shareId, {})
    return page.messages.map((m) =>
        m.contentBlocks[0]?.type === 'text' ? m.contentBlocks[0].text : ''
    )
}

test('createShare is idempotent, empty sessions 400, revoke+create rotates the id', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const emptySessionId = await createSession(h)
        await assert.rejects(
            h.shares.createShare(h.ownerId, h.agentId, emptySessionId),
            BadRequestException
        )

        const sessionId = await seedSession(h)
        const first = await h.shares.createShare(h.ownerId, h.agentId, sessionId)
        const second = await h.shares.createShare(h.ownerId, h.agentId, sessionId)
        assert.equal(second.id, first.id)
        assert.match(first.id, /^css_[a-z2-7]{26}$/)
        assert.equal(first.url, `https://manyfold.ai/chat/shared/${first.id}`)

        const before = await h.shares.getShare(h.ownerId, h.agentId, sessionId)
        assert.equal(before.share?.id, first.id)

        await h.shares.revokeShare(h.ownerId, h.agentId, sessionId)
        const after = await h.shares.getShare(h.ownerId, h.agentId, sessionId)
        assert.equal(after.share, null)

        const rotated = await h.shares.createShare(h.ownerId, h.agentId, sessionId)
        assert.notEqual(rotated.id, first.id)

        const rows = await h.db
            .select()
            .from(chatSessionShares)
            .where(eq(chatSessionShares.sessionId, sessionId))
        assert.equal(rows.length, 2)
    } finally {
        await h.close()
    }
})

test('ownership is strict and resolve is uniformly null for revoked/unknown/malformed', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const sessionId = await seedSession(h)
        await assert.rejects(
            h.shares.createShare(h.otherId, h.agentId, sessionId),
            NotFoundException
        )
        await assert.rejects(
            h.shares.createShare(h.ownerId, 'agt_wrong', sessionId),
            NotFoundException
        )

        const share = await h.shares.createShare(h.ownerId, h.agentId, sessionId)
        assert.ok(await h.shares.resolveActiveShare(share.id))
        assert.equal(await h.shares.resolveActiveShare('css_garbage'), null)
        assert.equal(
            await h.shares.resolveActiveShare(share.id.replace('css_', 'cts_')),
            null
        )

        await h.shares.revokeShare(h.ownerId, h.agentId, sessionId)
        assert.equal(await h.shares.resolveActiveShare(share.id), null)
        await assert.rejects(
            h.shares.buildPublicPreview(share.id),
            NotFoundException
        )
        await assert.rejects(
            h.shares.listPublicMessages(share.id, {}),
            NotFoundException
        )
    } finally {
        await h.close()
    }
})

test('cutoff freezes the transcript: later and inflight messages stay private', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const sessionId = await seedSession(h, ['one', 'two'])
        const share = await h.shares.createShare(h.ownerId, h.agentId, sessionId)
        await addMessage(h, sessionId, 'user', [textBlock('after-share')])
        assert.deepEqual(await publicTexts(h, share.id), ['one', 'two'])

        const inflightSessionId = await createSession(h)
        await addMessage(h, inflightSessionId, 'user', [textBlock('question')])
        const inflight = await addMessage(h, inflightSessionId, 'assistant', [
            textBlock('half-streamed')
        ])
        await h.db
            .update(chatSessions)
            .set({ inflightMessageId: inflight.id })
            .where(eq(chatSessions.id, inflightSessionId))
        const inflightShare = await h.shares.createShare(
            h.ownerId,
            h.agentId,
            inflightSessionId
        )
        assert.deepEqual(await publicTexts(h, inflightShare.id), ['question'])

        const onlyInflightId = await createSession(h)
        const only = await addMessage(h, onlyInflightId, 'assistant', [
            textBlock('streaming')
        ])
        await h.db
            .update(chatSessions)
            .set({ inflightMessageId: only.id })
            .where(eq(chatSessions.id, onlyInflightId))
        await assert.rejects(
            h.shares.createShare(h.ownerId, h.agentId, onlyInflightId),
            BadRequestException
        )
    } finally {
        await h.close()
    }
})

test('channel-bound sessions cannot be shared', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const sessionId = await seedSession(h)
        const channelId = `chn_pgcshare_${h.suffix}`
        await h.db.insert(channels).values({
            id: channelId,
            userId: h.ownerId,
            agentId: h.agentId,
            provider: 'fake',
            label: `pgcshare-${h.suffix}`,
            configJson: {}
        })
        await h.db.insert(channelSessions).values({
            id: `chs_pgcshare_${h.suffix}`,
            channelId,
            chatSessionId: sessionId,
            scopeKey: `dm:${h.suffix}`
        })
        await assert.rejects(
            h.shares.createShare(h.ownerId, h.agentId, sessionId),
            ConflictException
        )
    } finally {
        await h.close()
    }
})

test('public preview exposes only the shared surface', { skip: !RUN }, async () => {
    const h = await buildHarness()
    try {
        const sessionId = await seedSession(h)
        const share = await h.shares.createShare(h.ownerId, h.agentId, sessionId)

        const preview = await h.shares.buildPublicPreview(share.id)
        assert.deepEqual(
            Object.keys(preview).sort(),
            ['agent', 'session', 'sharedAt', 'sharedBy']
        )
        assert.deepEqual(Object.keys(preview.agent).sort(), [
            'framework',
            'name'
        ])
        assert.deepEqual(Object.keys(preview.session).sort(), [
            'createdAt',
            'title'
        ])
        assert.equal(preview.sharedBy, `Owner ${h.suffix}`)
        assert.equal(preview.agent.framework, 'codex')
        assert.equal(preview.session.title, 'pg share session')

        const serialized = JSON.stringify(preview)
        assert.ok(!serialized.includes(sessionId))
        assert.ok(!serialized.includes(h.ownerId))
        assert.ok(!serialized.includes(h.agentId))
        assert.ok(!serialized.includes('@pgtest.local'))

        await h.db
            .update(users)
            .set({ displayName: null })
            .where(eq(users.id, h.ownerId))
        const anon = await h.shares.buildPublicPreview(share.id)
        assert.equal(anon.sharedBy, null)
    } finally {
        await h.close()
    }
})

test('public messages scrub grant links, workspace paths and upload ids', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const grantUrl =
            'https://app.manyfold.ai/grant-permission?token=SECRETTOKEN123'
        const sessionId = await createSession(h)
        await addMessage(h, sessionId, 'user', [
            {
                type: 'attachment',
                name: 'file.md',
                path: '/home/sprite/.manyfold/workspaces/agt_x/docs/file.md',
                rootId: 'workspace',
                contentType: 'text/markdown',
                size: 10
            },
            {
                type: 'upload',
                uploadId: 'cup_secretupload',
                name: 'pic.png',
                contentType: 'image/png',
                size: 5
            }
        ])
        await addMessage(h, sessionId, 'assistant', [
            { type: 'thinking', text: `considering ${grantUrl} now` },
            {
                type: 'tool_call',
                toolCallId: 'call1',
                toolName: 'request_permission',
                args: { url: grantUrl }
            },
            {
                type: 'tool_result',
                toolCallId: 'call1',
                result: { links: [grantUrl] }
            },
            textBlock(`please approve via ${grantUrl}`)
        ])
        const share = await h.shares.createShare(h.ownerId, h.agentId, sessionId)

        const page = await h.shares.listPublicMessages(share.id, {})
        const serialized = JSON.stringify(page)
        assert.ok(!serialized.includes('SECRETTOKEN123'))
        assert.ok(!serialized.includes('/grant-permission?'))
        assert.ok(!serialized.includes('/home/sprite'))
        assert.ok(!serialized.includes('cup_secretupload'))
        assert.ok(serialized.includes('[permission link removed]'))

        const userBlocks = page.messages[0].contentBlocks
        assert.equal(
            userBlocks[0].type === 'attachment' && userBlocks[0].path,
            'docs/file.md'
        )
        assert.equal(
            userBlocks[1].type === 'upload' && userBlocks[1].uploadId,
            ''
        )
    } finally {
        await h.close()
    }
})

test('public pagination walks the full frozen transcript in order', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const texts = ['m1', 'm2', 'm3', 'm4', 'm5']
        const sessionId = await seedSession(h, texts)
        const share = await h.shares.createShare(h.ownerId, h.agentId, sessionId)
        await addMessage(h, sessionId, 'user', [textBlock('m6-after-share')])

        const collected: string[] = []
        let before: string | undefined
        for (let i = 0; i < 10; i += 1) {
            const page = await h.shares.listPublicMessages(share.id, {
                limit: 2,
                before
            })
            collected.unshift(
                ...page.messages.map((m) =>
                    m.contentBlocks[0]?.type === 'text'
                        ? m.contentBlocks[0].text
                        : ''
                )
            )
            if (!page.hasMore) {
                assert.equal(page.nextBefore, null)
                break
            }
            assert.ok(page.nextBefore)
            before = page.nextBefore
        }
        assert.deepEqual(collected, texts)
    } finally {
        await h.close()
    }
})

test('history rewrites and session deletion kill active shares', {
    skip: !RUN
}, async () => {
    const h = await buildHarness()
    try {
        const rewriteSessionId = await createSession(h)
        const target = await addMessage(h, rewriteSessionId, 'user', [
            textBlock('original')
        ])
        await addMessage(h, rewriteSessionId, 'assistant', [textBlock('reply')])
        const rewriteShare = await h.shares.createShare(
            h.ownerId,
            h.agentId,
            rewriteSessionId
        )
        await h.repo.rewriteMessageAndDeleteAfter(rewriteSessionId, target.id, [
            textBlock('edited')
        ])
        assert.equal(
            await h.shares.resolveActiveShare(rewriteShare.id),
            null
        )

        const replaceSessionId = await seedSession(h)
        const replaceShare = await h.shares.createShare(
            h.ownerId,
            h.agentId,
            replaceSessionId
        )
        await h.repo.replaceSessionMessages(replaceSessionId, [])
        assert.equal(
            await h.shares.resolveActiveShare(replaceShare.id),
            null
        )

        const cascadeSessionId = await seedSession(h)
        const cascadeShare = await h.shares.createShare(
            h.ownerId,
            h.agentId,
            cascadeSessionId
        )
        await h.db
            .delete(chatSessions)
            .where(eq(chatSessions.id, cascadeSessionId))
        assert.equal(await h.shares.resolveActiveShare(cascadeShare.id), null)
        const orphans = await h.db
            .select()
            .from(chatSessionShares)
            .where(eq(chatSessionShares.id, cascadeShare.id))
        assert.equal(orphans.length, 0)
    } finally {
        await h.close()
    }
})
