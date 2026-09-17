import assert from 'node:assert/strict'
import test from 'node:test'
import type { ChannelRow } from '@manyfold/db'
import { classifySendError } from '../src/modules/channels/channel-send-error'
import { createLarkOutboundFixture } from './helpers/lark-outbound-fixture'

const channel = {
    id: 'chn_fixture',
    configJson: { appId: 'fixture-app', subscriptionMode: 'websocket' }
} as ChannelRow
const routes = ['chat', 'user', 'reply', 'scope', 'thread'] as const
const files = [
    ['voice.OPUS', 'application/octet-stream', 'opus', 'audio'],
    ['clip.mp4', 'video/mp4', 'mp4', 'media'],
    ['report.pdf', 'application/pdf', 'pdf', 'file'],
    ['report.docx', 'application/octet-stream', 'doc', 'file'],
    ['sheet.xlsx', 'application/octet-stream', 'xls', 'file'],
    ['slides.pptx', 'application/octet-stream', 'ppt', 'file'],
    ['archive.bin', 'application/octet-stream', 'stream', 'file'],
    ['image.png', 'image/png', null, 'image']
] as const

for (const route of routes) {
    test(`Lark upload and message types remain paired through ${route}`, async (t) => {
        const fixture = await createLarkOutboundFixture()
        t.after(fixture.close)
        const { provider } = fixture
        const ctx = {
            channel,
            config: provider.validateConfig(channel.configJson),
            credentials: { appSecret: 'fixture-secret' }
        }
        const attachments = files.map(([name, contentType]) => ({
            name,
            contentType,
            bytes: Buffer.from(name)
        }))
        if (route === 'scope' || route === 'thread') {
            await provider.sendAttachments(
                ctx,
                route === 'scope'
                    ? 'feishu:fixture-chat:fixture-user'
                    : 'feishu:fixture-chat:thread:fixture-root',
                attachments
            )
        } else {
            await provider.sendDirectAttachments(
                ctx,
                route === 'chat'
                    ? { kind: 'chat', chatId: 'fixture-chat' }
                    : route === 'user'
                      ? { kind: 'user', userId: 'fixture-user' }
                      : { kind: 'reply', messageId: 'fixture-root' },
                attachments
            )
        }
        assert.deepEqual(fixture.errors, [])
        assert.equal(fixture.uploads.length, files.length)
        assert.equal(fixture.messages.length, files.length)
        assert.deepEqual(
            fixture.messages.map(({ body }) => body.msg_type),
            files.map((file) => file[3])
        )
        for (const [
            index,
            [name, , fileType, messageType]
        ] of files.entries()) {
            assert.deepEqual(fixture.uploads[index], {
                kind: messageType === 'image' ? 'image' : 'file',
                fileType,
                name,
                bytes: name
            })
            const { path, body } = fixture.messages[index]
            assert.equal(body.msg_type, messageType, name)
            assert.deepEqual(
                JSON.parse(String(body.content)),
                messageType === 'image'
                    ? { image_key: 'fixture-image' }
                    : { file_key: 'fixture-file' }
            )
            assert.equal(
                path,
                route === 'reply' || route === 'thread'
                    ? '/open-apis/im/v1/messages/fixture-root/reply'
                    : `/open-apis/im/v1/messages?receive_id_type=${route === 'user' ? 'open_id' : 'chat_id'}`
            )
            assert.equal(
                body.reply_in_thread,
                route === 'thread' ? true : undefined
            )
        }
    })
}

for (const [status, body, expected] of [
    [400, { code: 230055, msg: 'mismatch' }, 'bad_format'],
    [200, { code: 230055, msg: 'mismatch' }, 'bad_format'],
    [400, { code: 230001, msg: 'other error' }, 'unknown'],
    [400, { msg: '230055 file type mismatch' }, 'unknown'],
    [400, { code: '230055', msg: 'untyped code' }, 'unknown']
] as const) {
    test(`Lark classifies only structured mismatch: HTTP ${status}, ${JSON.stringify(body)}`, async (t) => {
        const fixture = await createLarkOutboundFixture({ status, body })
        t.after(fixture.close)
        const { provider } = fixture
        await assert.rejects(
            provider.sendDirectAttachments(
                {
                    channel,
                    config: provider.validateConfig(channel.configJson),
                    credentials: { appSecret: 'fixture-secret' }
                },
                { kind: 'reply', messageId: 'fixture-root' },
                [
                    {
                        name: 'voice.opus',
                        contentType: 'audio/ogg',
                        bytes: Buffer.from('fixture')
                    }
                ]
            ),
            (error: unknown) => {
                assert.equal(classifySendError(error).kind, expected)
                return true
            }
        )
        assert.deepEqual(fixture.errors, [])
        assert.equal(fixture.uploads.length, 1)
        assert.equal(fixture.messages.length, 1)
    })
}
