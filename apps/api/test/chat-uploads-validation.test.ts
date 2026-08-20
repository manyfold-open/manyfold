import {
    ChatContentBlock,
    createObjectId
} from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import { ChatService } from '../src/modules/chat/chat.service'

const sessionRow = {
    id: 'session-1',
    userId: 'user-1',
    agentId: 'agent-1',
    title: 'existing',
    frameworkSessionRef: null,
    createdAt: new Date(),
    updatedAt: new Date()
}

const makeHarness = (
    framework: string,
    knownUploadIds: Set<string>
): ChatService => {
    const agentRow = {
        id: 'agent-1',
        userId: 'user-1',
        framework,
        runtime: 'external',
        runtimeId: null,
        model: null
    }
    const inserted: Array<{ contentBlocksJson: ChatContentBlock[] }> = []
    const db = {
        select: () => ({
            from: () => ({ where: () => ({ limit: async () => [agentRow] }) })
        }),
        update: () => ({ set: () => ({ where: async () => undefined }) })
    }
    const repo = {
        getSession: async () => sessionRow,
        insertMessage: async (row: {
            contentBlocksJson: ChatContentBlock[]
        }) => {
            inserted.push(row)
            return { ...row, id: 'user-msg-1' }
        },
        listMessages: async () => inserted,
        claimInflightTurn: async () => true,
        releaseInflightTurn: async () => {},
        updateTitleIfEmpty: async () => {},
        touchSession: async () => undefined
    }
    const broadcaster = {
        setStreamFence: () => undefined,
        beginStream: () => undefined,
        emit: async () => ({ persisted: true }),
        emitDetached: async () => true
    }
    const adapters = {
        get: () => ({
            sendMessage: async function* () {
                yield { type: 'done', finalMessageId: 'assistant-1' }
            }
        })
    }
    const uploads = {
        stat: async (id: string) =>
            knownUploadIds.has(id)
                ? {
                      id,
                      name: 'photo.png',
                      contentType: 'image/png',
                      size: 10,
                      createdAt: ''
                  }
                : null,
        read: async () => Buffer.from(''),
        delete: async () => undefined
    }
    return new ChatService(
        db as never,
        repo as never,
        broadcaster as never,
        adapters as never,
        {} as never,
        {} as never,
        { publishStatus: () => {} } as never,
        { event: () => {} } as never,
        undefined as never,
        undefined as never,
        undefined as never,
        undefined,
        undefined,
        uploads as never
    )
}

test('normalizeUploads builds an upload block for a dify agent', async () => {
    const uploadId = createObjectId('chatUpload')
    const service = makeHarness('dify', new Set([uploadId]))
    const result = await service.sendMessage(
        'user-1',
        'agent-1',
        'session-1',
        'what is this',
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [],
        [{ uploadId }]
    )
    assert.deepEqual(result.userMessage.contentBlocks, [
        { type: 'text', text: 'what is this' },
        {
            type: 'upload',
            uploadId,
            name: 'photo.png',
            contentType: 'image/png',
            size: 10
        }
    ])
})

test('normalizeUploads rejects an unknown upload id', async () => {
    const service = makeHarness('dify', new Set())
    await assert.rejects(
        () =>
            service.sendMessage(
                'user-1',
                'agent-1',
                'session-1',
                'hi',
                [],
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                [],
                [{ uploadId: createObjectId('chatUpload') }]
            ),
        /upload not found/
    )
})

test('normalizeUploads rejects a malformed upload id', async () => {
    const service = makeHarness('dify', new Set())
    await assert.rejects(
        () =>
            service.sendMessage(
                'user-1',
                'agent-1',
                'session-1',
                'hi',
                [],
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                [],
                [{ uploadId: 'not-a-cup-id' }]
            ),
        /invalid upload id/
    )
})

test('normalizeUploads rejects uploads for a non-dify framework', async () => {
    const uploadId = createObjectId('chatUpload')
    const service = makeHarness('claude-code', new Set([uploadId]))
    await assert.rejects(
        () =>
            service.sendMessage(
                'user-1',
                'agent-1',
                'session-1',
                'hi',
                [],
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                [],
                [{ uploadId }]
            ),
        /does not support uploads/
    )
})
