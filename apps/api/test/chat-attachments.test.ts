import type { ChatContentBlock } from '@manyfold/shared'
import assert from 'node:assert/strict'
import test from 'node:test'
import {
    BadRequestException,
    ForbiddenException,
    NotFoundException
} from '@nestjs/common'
import { ChatService } from '../src/modules/chat/chat.service'
import { messageToPromptText } from '../src/modules/chat/adapters/message-content'

const agentRow = {
    id: 'agent-1',
    userId: 'user-1',
    framework: 'claude-code',
    runtime: 'sprites',
    runtimeId: 'runtime-1',
    model: null
}

const sessionRow = {
    id: 'session-1',
    userId: 'user-1',
    agentId: 'agent-1',
    title: null,
    frameworkSessionRef: null,
    createdAt: new Date(),
    updatedAt: new Date()
}

test('ChatService stores normalized attachment blocks and derives title', async () => {
    const harness = makeServiceHarness()

    const result = await harness.service.sendMessage(
        'user-1',
        'agent-1',
        'session-1',
        '',
        [
            {
                path: 'chat-attachments/session-1/batch/photo.png',
                rootId: 'workspace',
                name: 'local-photo.png'
            }
        ]
    )

    assert.deepEqual(result.userMessage.contentBlocks, [
        {
            type: 'attachment',
            name: 'local-photo.png',
            path: '/workspace/chat-attachments/session-1/batch/photo.png',
            rootId: 'workspace',
            contentType: 'image/png',
            size: 12
        }
    ])
    assert.equal(harness.title, 'local-photo.png')
})

test('ChatService rejects attachments outside workspace root', async () => {
    const harness = makeServiceHarness()

    await assert.rejects(
        () =>
            harness.service.sendMessage(
                'user-1',
                'agent-1',
                'session-1',
                undefined,
                [{ path: 'settings.json', rootId: 'codex-home' }]
            ),
        BadRequestException
    )
})

test('ChatService stores normalized context refs from non-workspace roots', async () => {
    const harness = makeServiceHarness()

    const result = await harness.service.sendMessage(
        'user-1',
        'agent-1',
        'session-1',
        undefined,
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [
            {
                path: '/home/sprite/.codex/config.toml',
                rootId: 'codex-home',
                name: 'config.toml',
                entryType: 'file'
            },
            {
                path: '/home/sprite/.codex/sessions',
                rootId: 'codex-home',
                name: 'sessions',
                entryType: 'dir'
            }
        ]
    )

    assert.deepEqual(result.userMessage.contentBlocks, [
        {
            type: 'context_ref',
            name: 'config.toml',
            path: '/home/sprite/.codex/config.toml',
            rootId: 'codex-home',
            entryType: 'file',
            contentType: 'text/plain',
            size: 12
        },
        {
            type: 'context_ref',
            name: 'sessions',
            path: '/home/sprite/.codex/sessions',
            rootId: 'codex-home',
            entryType: 'dir'
        }
    ])
    assert.equal(harness.title, 'config.toml and 1 more')
})

test('ChatService rejects context refs for unknown roots', async () => {
    const harness = makeServiceHarness()

    await assert.rejects(
        () =>
            harness.service.sendMessage(
                'user-1',
                'agent-1',
                'session-1',
                undefined,
                [],
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                [
                    {
                        path: '/tmp/config.toml',
                        rootId: 'tmp-root'
                    }
                ]
            ),
        NotFoundException
    )
})

test('ChatService rejects context refs that escape the selected root', async () => {
    const harness = makeServiceHarness()

    await assert.rejects(
        () =>
            harness.service.sendMessage(
                'user-1',
                'agent-1',
                'session-1',
                undefined,
                [],
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                [
                    {
                        path: '/home/sprite/.claude/config.json',
                        rootId: 'codex-home'
                    }
                ]
            ),
        ForbiddenException
    )
})

test('ChatService rejects missing context refs', async () => {
    const harness = makeServiceHarness()

    await assert.rejects(
        () =>
            harness.service.sendMessage(
                'user-1',
                'agent-1',
                'session-1',
                undefined,
                [],
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                [
                    {
                        path: '/home/sprite/.codex/missing.txt',
                        rootId: 'codex-home'
                    }
                ]
            ),
        BadRequestException
    )
})

test('ChatService rejects context refs that are not files or directories', async () => {
    const harness = makeServiceHarness()

    await assert.rejects(
        () =>
            harness.service.sendMessage(
                'user-1',
                'agent-1',
                'session-1',
                undefined,
                [],
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                [
                    {
                        path: '/home/sprite/.codex/socket',
                        rootId: 'codex-home'
                    }
                ]
            ),
        BadRequestException
    )
})

test('ChatService rejects context refs with mismatched entry type', async () => {
    const harness = makeServiceHarness()

    await assert.rejects(
        () =>
            harness.service.sendMessage(
                'user-1',
                'agent-1',
                'session-1',
                undefined,
                [],
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                undefined,
                [
                    {
                        path: '/home/sprite/.codex/sessions',
                        rootId: 'codex-home',
                        entryType: 'file'
                    }
                ]
            ),
        BadRequestException
    )
})

test('messageToPromptText appends attachment paths', () => {
    const text = messageToPromptText({
        id: 'msg-user',
        sessionId: 'session-1',
        role: 'user',
        contentBlocks: [
            { type: 'text', text: 'inspect this' },
            {
                type: 'attachment',
                name: 'photo.png',
                path: '/workspace/chat-attachments/session/batch/photo.png',
                rootId: 'workspace',
                contentType: 'image/png',
                size: 12
            }
        ],
        createdAt: new Date().toISOString()
    })

    assert.equal(
        text,
        [
            'inspect this',
            '',
            'Attached files:',
            '- photo.png (image/png, 12 bytes): /workspace/chat-attachments/session/batch/photo.png'
        ].join('\n')
    )
})

test('messageToPromptText appends context refs', () => {
    const text = messageToPromptText({
        id: 'msg-user',
        sessionId: 'session-1',
        role: 'user',
        contentBlocks: [
            { type: 'text', text: 'inspect this' },
            {
                type: 'context_ref',
                name: 'config.toml',
                path: '/home/sprite/.codex/config.toml',
                rootId: 'codex-home',
                entryType: 'file',
                contentType: 'text/plain',
                size: 12
            },
            {
                type: 'context_ref',
                name: 'sessions',
                path: '/home/sprite/.codex/sessions',
                rootId: 'codex-home',
                entryType: 'dir'
            }
        ],
        createdAt: new Date().toISOString()
    })

    assert.equal(
        text,
        [
            'inspect this',
            '',
            'Attached context:',
            '- config.toml (text/plain, 12 bytes): /home/sprite/.codex/config.toml',
            '- sessions (dir): /home/sprite/.codex/sessions'
        ].join('\n')
    )
})

const makeServiceHarness = (): {
    service: ChatService
    title: string | null
} => {
    const inserted: Array<{
        id: string
        sessionId: string
        role: string
        contentBlocksJson: ChatContentBlock[]
        capabilityEventsJson: unknown
        createdAt: Date
    }> = []
    const harness = { title: null as string | null }
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [agentRow]
                })
            })
        }),
        update: () => ({
            set: () => ({
                where: async () => undefined
            })
        })
    }
    const repo = {
        getSession: async () => sessionRow,
        insertMessage: async (row: {
            id: string
            sessionId: string
            role: string
            contentBlocksJson: ChatContentBlock[]
            capabilityEventsJson: unknown
            createdAt: Date
        }) => {
            inserted.push(row)
            return row
        },
        listMessages: async () => inserted,
        claimInflightTurn: async () => true,
        releaseInflightTurn: async () => {},
        updateTitleIfEmpty: async (_sessionId: string, title: string) => {
            harness.title = title
        },
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
                yield { type: 'done', finalMessageId: 'msg-assistant' }
            }
        })
    }
    const files = {
        build: async (_agent: unknown, rootId = 'workspace') => {
            if (rootId !== 'workspace' && rootId !== 'codex-home')
                throw new NotFoundException(`unknown file root: ${rootId}`)
            const isCodexRoot = rootId === 'codex-home'
            return {
                root: {
                    id: rootId,
                    label: isCodexRoot ? 'Codex Home' : 'Workspace',
                    path: isCodexRoot ? '/home/sprite/.codex' : '/workspace',
                    writable: true
                },
                mountPath: isCodexRoot ? '/home/sprite/.codex' : '/workspace',
                stat: async (path: string) =>
                    path.endsWith('/missing.txt')
                        ? null
                        : {
                              entry: {
                                  name: path.split('/').at(-1) ?? 'photo.png',
                                  type: path.endsWith('/sessions')
                                      ? 'dir'
                                      : path.endsWith('/socket')
                                        ? 'other'
                                        : 'file',
                                  size: 12,
                                  mtime: 1,
                                  mode: '644'
                              },
                              contentType: path.endsWith('.png')
                                  ? 'image/png'
                                  : 'text/plain'
                          }
            }
        }
    }
    return {
        service: new ChatService(
            db as never,
            repo as never,
            broadcaster as never,
            adapters as never,
            {} as never,
            files as never,
            { publishStatus: () => {} } as never,
            { event: () => {} } as never,
            undefined as never,
            undefined as never,
            undefined as never
        ),
        get title() {
            return harness.title
        }
    }
}
