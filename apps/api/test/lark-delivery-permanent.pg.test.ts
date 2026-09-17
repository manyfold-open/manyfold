import 'tsconfig-paths/register'
import 'reflect-metadata'
import assert from 'node:assert/strict'
import test from 'node:test'
import { eq } from 'drizzle-orm'
import { createObjectId } from '@manyfold/shared'
import {
    agents,
    agentRuntimes,
    channels,
    channelDeliveries,
    createDb,
    users
} from '@manyfold/db'
import { withScratchDatabase } from '../scripts/scratch-db'
import { ChannelBridgeService } from '../src/modules/channels/channel-bridge.service'
import { ChannelsRepository } from '../src/modules/channels/channels.repository'
import { createLarkOutboundFixture } from './helpers/lark-outbound-fixture'

test(
    'Lark permanent file errors dead-letter once without replaying successful text',
    {
        skip: process.env.RUN_PG_E2E !== '1'
    },
    async (t) => {
        // The sweep reads all due deliveries, so its real repository gets a
        // dedicated migrated database instead of touching sibling test fixtures.
        await withScratchDatabase('lark_delivery', async ({ url }) => {
            const db = createDb(url)
            const repo = new ChannelsRepository(db)
            const userId = createObjectId('user')
            const runtimeId = createObjectId('agentRuntime')
            const agentId = createObjectId('agent')
            try {
                await db
                    .insert(users)
                    .values({ id: userId, email: `${userId}@fixture.invalid` })
                await db
                    .insert(agentRuntimes)
                    .values({
                        id: runtimeId,
                        userId,
                        name: 'Lark fixture',
                        framework: 'claude-code',
                        kind: 'sprites'
                    })
                await db
                    .insert(agents)
                    .values({
                        id: agentId,
                        userId,
                        runtimeId,
                        name: 'Lark fixture',
                        framework: 'claude-code',
                        runtime: 'sprites',
                        internalId: agentId
                    })
                for (const status of [200, 400]) {
                    for (const withText of [false, true]) {
                        await t.test(
                            `HTTP ${status}, ${withText ? 'text and files' : 'files only'}`,
                            async (st) => {
                                const fixture = await createLarkOutboundFixture(
                                    {
                                        status,
                                        body: {
                                            code: 230055,
                                            msg: 'fixture mismatch'
                                        }
                                    }
                                )
                                st.after(fixture.close)
                                const [channel] = await db
                                    .insert(channels)
                                    .values({
                                        id: createObjectId('channel'),
                                        userId,
                                        agentId,
                                        provider: 'lark',
                                        label: 'Lark fixture',
                                        status: 'active',
                                        configJson: {
                                            appId: 'fixture-app',
                                            subscriptionMode: 'websocket'
                                        },
                                        credentialsCiphertext: 'fixture-only'
                                    })
                                    .returning()
                                let reads = 0
                                const kinds: unknown[] = []
                                const bridge = new ChannelBridgeService(
                                    repo,
                                    {} as never,
                                    {} as never,
                                    { get: () => fixture.provider } as never,
                                    {
                                        decrypt: () =>
                                            JSON.stringify({
                                                appSecret: 'fixture-secret'
                                            })
                                    } as never,
                                    {
                                        event: () => undefined,
                                        error: (
                                            _name: string,
                                            _error: Error,
                                            attributes: { errorKind: unknown }
                                        ) => kinds.push(attributes.errorKind)
                                    } as never,
                                    {} as never,
                                    {
                                        readWorkspaceFiles: async () => {
                                            reads++
                                            return [
                                                {
                                                    name: 'clip.mp4',
                                                    contentType: 'video/mp4',
                                                    bytes: Buffer.from(
                                                        'fixture-video'
                                                    )
                                                }
                                            ]
                                        }
                                    } as never
                                )
                                const result = await bridge.sendAgentDirect(
                                    channel,
                                    withText
                                        ? {
                                              kind: 'reply',
                                              messageId: 'fixture-root'
                                          }
                                        : {
                                              kind: 'chat',
                                              chatId: 'fixture-chat'
                                          },
                                    withText ? 'fixture caption' : null,
                                    [{ relPath: 'clip.mp4', name: 'clip.mp4' }]
                                )
                                const fileId = withText
                                    ? result.files?.deliveryId
                                    : result.deliveryId
                                const rows = await db
                                    .select()
                                    .from(channelDeliveries)
                                    .where(
                                        eq(
                                            channelDeliveries.channelId,
                                            channel.id
                                        )
                                    )
                                const file = rows.find(
                                    (row) => row.id === fileId
                                )
                                assert.equal(file?.status, 'dead')
                                assert.equal(file?.attemptCount, 1)
                                assert.equal(file?.nextAttemptAt, null)
                                assert.equal(file?.sendAttemptStartedAt, null)
                                assert.deepEqual(kinds, ['bad_format'])
                                assert.equal(
                                    withText
                                        ? result.files?.status
                                        : result.status,
                                    'failed'
                                )
                                if (withText) {
                                    const text = rows.find(
                                        (row) => row.id === result.deliveryId
                                    )
                                    assert.equal(text?.status, 'sent')
                                    assert.equal(text?.attemptCount, 1)
                                    assert.equal(text?.nextAttemptAt, null)
                                }
                                const before = {
                                    reads,
                                    uploads: fixture.uploads.length,
                                    messages: fixture.messages.length
                                }
                                st.mock.timers.enable({
                                    apis: ['Date'],
                                    now: Date.now() + 2 * 86_400_000
                                })
                                assert.equal(
                                    await bridge.sweepOutboundDeliveries(),
                                    0
                                )
                                assert.deepEqual(
                                    {
                                        reads,
                                        uploads: fixture.uploads.length,
                                        messages: fixture.messages.length
                                    },
                                    before
                                )
                                assert.equal(
                                    fixture.messages.filter(
                                        ({ body }) => body.msg_type === 'text'
                                    ).length,
                                    withText ? 1 : 0
                                )
                                assert.deepEqual(fixture.errors, [])
                            }
                        )
                    }
                }
            } finally {
                await (
                    db as unknown as { $client: { end: () => Promise<void> } }
                ).$client.end()
            }
        })
    }
)
