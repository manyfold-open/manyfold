import assert from 'node:assert/strict'
import test from 'node:test'
import { Readable } from 'node:stream'
import { ChatUploadStorageService } from '../src/modules/chat/uploads/chat-upload-storage.service'

const makeConfig = (values: Record<string, string>): never =>
    ({ get: (key: string) => values[key] }) as never

const drain = async (stream: AsyncIterable<Uint8Array>): Promise<Buffer> => {
    const chunks: Buffer[] = []
    for await (const chunk of stream)
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return Buffer.concat(chunks)
}

test('disk fallback round-trips put/stat/read/delete and scopes by owner', async () => {
    const svc = new ChatUploadStorageService(
        makeConfig({ CHAT_UPLOAD_ALLOW_DISK: 'true' })
    )
    const { id, size } = await svc.put({
        userId: 'user-1',
        agentId: 'agent-1',
        name: 'photo.png',
        contentType: 'image/png',
        stream: Readable.from([Buffer.from('hello world')])
    })
    assert.equal(size, 11)
    assert.ok(id.startsWith('cup_'))

    const stat = await svc.stat(id, 'user-1', 'agent-1')
    assert.equal(stat?.name, 'photo.png')
    assert.equal(stat?.contentType, 'image/png')
    assert.equal(stat?.size, 11)

    // ownership is enforced by the storage key: a different user/agent misses
    assert.equal(await svc.stat(id, 'other-user', 'agent-1'), null)
    assert.equal(await svc.stat(id, 'user-1', 'other-agent'), null)

    const bytes = await drain(await svc.read(id, 'user-1', 'agent-1'))
    assert.equal(bytes.toString(), 'hello world')

    await svc.delete(id, 'user-1', 'agent-1')
    assert.equal(await svc.stat(id, 'user-1', 'agent-1'), null)
})

test('fails closed when neither S3 nor disk is configured', async () => {
    const svc = new ChatUploadStorageService(makeConfig({}))
    await assert.rejects(
        () =>
            svc.put({
                userId: 'user-1',
                agentId: 'agent-1',
                name: 'x.txt',
                contentType: 'text/plain',
                stream: Readable.from([Buffer.from('x')])
            }),
        /not configured/
    )
})

test('stat rejects ids that are not chat-upload object ids', async () => {
    const svc = new ChatUploadStorageService(
        makeConfig({ CHAT_UPLOAD_ALLOW_DISK: 'true' })
    )
    assert.equal(await svc.stat('not-an-id', 'user-1', 'agent-1'), null)
    assert.equal(await svc.stat('agt_abc', 'user-1', 'agent-1'), null)
})
