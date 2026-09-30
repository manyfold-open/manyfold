import assert from 'node:assert/strict'
import test from 'node:test'
import { ConflictException } from '@nestjs/common'
import {
    A2aError,
    A2aErrorCode,
    type A2aStreamEvent,
    type MessageSendParams,
    type Part
} from '@manyfold/a2a'
import type { A2aTask } from '@manyfold/db'
import type { CreateMessageAttachmentInput } from '@manyfold/shared'
import { A2aService, type A2aAuthContext } from '../src/modules/a2a/a2a.service'
import type {
    IngestFile,
    IngestedFiles
} from '../src/modules/chat/api-files/chat-api-file.service'

const ctx: A2aAuthContext = {
    userId: 'u',
    targetAgentId: 'target',
    callerAgentId: 'caller',
    externalSubject: null
}

const SECRET = 'Secret Code: 998877'
const secretFile = (): Part => ({
    kind: 'file',
    file: { name: 'secret.txt', bytes: Buffer.from(SECRET).toString('base64') }
})
const question: Part = { kind: 'text', text: 'what is the code?' }

const send = (
    parts: Part[],
    extra: Partial<MessageSendParams> = {},
    messageId = 'm'
): MessageSendParams => ({
    message: { kind: 'message', role: 'user', messageId, parts },
    ...extra
})

const ATTACHED: CreateMessageAttachmentInput[] = [
    {
        path: 'chat-attachments/session-1/f/secret.txt',
        rootId: 'workspace',
        name: 'secret.txt',
        contentType: 'text/plain',
        size: SECRET.length
    }
]

interface IngestCall {
    userId: string
    agentId: string
    sessionId: string
    files: IngestFile[]
}

const harness = (
    framework = 'claude-code',
    ingest: (files: IngestFile[]) => Promise<IngestedFiles> = async () => ({
        attachments: ATTACHED,
        uploads: []
    })
) => {
    const rows = new Map<string, A2aTask>()
    const turns: unknown[][] = []
    const ingests: IngestCall[] = []
    let sessions = 0
    let turnStarted!: () => void
    const turnEntered = new Promise<void>((resolve) => {
        turnStarted = resolve
    })
    const db = {
        insert: () => ({ values: async () => {} }),
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [
                        {
                            id: 'target',
                            name: 'Target',
                            framework,
                            extras: { a2aExposure: { enabled: true } }
                        }
                    ]
                })
            })
        })
    }
    const tasks = {
        withUserLock: async (
            _user: string,
            run: (tasks: unknown, db: unknown) => Promise<unknown>
        ) => run(tasks, db),
        create: async (input: object) => {
            const row = {
                ...input,
                state: 'submitted',
                createdAt: new Date(),
                updatedAt: new Date(),
                completedAt: null,
                artifactJson: null,
                errorJson: null,
                usageJson: null,
                assistantMessageId: null,
                userMessageId: null
            } as A2aTask
            rows.set(row.id, row)
            return { ...row }
        },
        findById: async (id: string) =>
            rows.has(id) ? { ...rows.get(id)! } : null,
        findByClientMessage: async (_scope: unknown, id: string) => {
            const row = [...rows.values()].find(
                (row) => row.clientMessageId === id
            )
            return row ? { ...row } : null
        },
        countInflightForUser: async () => 0,
        update: async (id: string, patch: object) => {
            Object.assign(rows.get(id)!, patch)
        },
        updateIfActive: async (id: string, patch: Partial<A2aTask>) => {
            const row = rows.get(id)!
            if (row.state !== 'submitted' && row.state !== 'working')
                return false
            Object.assign(row, patch)
            return true
        }
    }
    const chat = {
        getTurnOutcome: async () => ({ state: 'running' }),
        createSession: async () => ({ id: `session-${++sessions}` }),
        announceSessionCreated: () => {},
        sendMessage: async (...args: unknown[]) => {
            turns.push(args)
            const observer = args[13] as (event: unknown) => void
            observer({ type: 'token', text: 'The code is 998877.' })
            observer({ type: 'done' })
            turnStarted()
            return {
                userMessage: { id: 'user-message' },
                assistantMessageId: 'assistant'
            }
        },
        cancelMessage: async () => {},
        terminalizeDeadInflightMessage: async () => {}
    }
    const apiFiles = {
        ingest: async (input: IngestCall) => {
            ingests.push(input)
            return ingest(input.files)
        }
    }
    const service = new A2aService(
        db as never,
        chat as never,
        tasks as never,
        undefined,
        undefined,
        undefined,
        undefined,
        apiFiles as never
    )
    return {
        service,
        rows,
        turns,
        ingests,
        turnEntered,
        sessions: () => sessions,
        row: () => [...rows.values()][0]
    }
}

const rejectsWith = (code: number, message?: RegExp) => (err: unknown) => {
    assert.ok(err instanceof A2aError, `expected an A2aError, got ${err}`)
    assert.equal(err.code, code)
    if (message) assert.match(err.message, message)
    return true
}

test('a file part reaches the turn as an attachment in the target workspace', async () => {
    const h = harness()
    const task = await h.service.sendMessage(ctx, send([question, secretFile()]))

    assert.equal(task.status.state, 'completed')
    assert.equal(h.ingests.length, 1)
    const [call] = h.ingests
    assert.equal(call.userId, 'u')
    assert.equal(call.agentId, 'target')
    assert.equal(call.sessionId, 'session-1')
    assert.equal(call.files.length, 1)
    assert.equal(call.files[0].name, 'secret.txt')
    assert.equal(call.files[0].bytes.toString(), SECRET)

    const [args] = h.turns
    assert.equal(args[3], 'what is the code?')
    assert.deepEqual(args[4], ATTACHED)
    assert.deepEqual(args[15], [])
})

test('a message of files alone runs a turn with no text', async () => {
    const h = harness()
    const task = await h.service.sendMessage(ctx, send([secretFile()]))

    assert.equal(task.status.state, 'completed')
    const [args] = h.turns
    assert.equal(args[3], undefined)
    assert.deepEqual(args[4], ATTACHED)
})

test('a file the upload store takes rides the turn as an upload', async () => {
    const uploads = [{ uploadId: 'upl_1', name: 'secret.txt', size: 19 }]
    const h = harness('claude-code', async () => ({ attachments: [], uploads }))
    await h.service.sendMessage(ctx, send([question, secretFile()]))

    const [args] = h.turns
    assert.deepEqual(args[4], [])
    assert.deepEqual(args[15], uploads)
})

test('a non-blocking send hands its files to the detached turn', async () => {
    const h = harness()
    const task = await h.service.sendMessage(
        ctx,
        send([question, secretFile()], { configuration: { blocking: false } })
    )

    assert.equal(task.status.state, 'working')
    await h.turnEntered
    assert.deepEqual(h.turns[0][4], ATTACHED)
})

test('a retried message takes its files in once', async () => {
    const h = harness()
    await h.service.sendMessage(ctx, send([question, secretFile()]))
    await h.service.sendMessage(ctx, send([question, secretFile()]))

    assert.equal(h.ingests.length, 1)
    assert.equal(h.turns.length, 1)
})

test('an agent whose framework takes no files refuses them before any task exists', async () => {
    const h = harness('langflow')
    await assert.rejects(
        h.service.sendMessage(ctx, send([question, secretFile()])),
        rejectsWith(A2aErrorCode.contentTypeNotSupported, /takes no files/)
    )
    assert.equal(h.rows.size, 0)
    assert.equal(h.sessions(), 0)
    assert.equal(h.ingests.length, 0)
})

test('a file type chat refuses is refused before any task exists', async () => {
    const h = harness()
    await assert.rejects(
        h.service.sendMessage(
            ctx,
            send([{ kind: 'file', file: { name: 'setup.exe', bytes: 'TVo=' } }])
        ),
        rejectsWith(
            A2aErrorCode.contentTypeNotSupported,
            /^file setup\.exe is not a type this agent accepts: it takes text/
        )
    )
    assert.equal(h.rows.size, 0)
})

test('a file with neither an extension nor a type is asked for one', async () => {
    const h = harness()
    await assert.rejects(
        h.service.sendMessage(
            ctx,
            send([{ kind: 'file', file: { name: 'notes', bytes: 'aGk=' } }])
        ),
        rejectsWith(
            A2aErrorCode.contentTypeNotSupported,
            /^file notes has no type: name it with its extension or set its mimeType$/
        )
    )
    assert.equal(h.rows.size, 0)
})

test('a declared type admits a file whose name has no extension', async () => {
    const h = harness()
    await h.service.sendMessage(
        ctx,
        send([
            {
                kind: 'file',
                file: { name: 'shot', mimeType: 'image/png', bytes: 'iVBORw==' }
            }
        ])
    )
    assert.equal(h.ingests[0].files[0].contentType, 'image/png')
    assert.equal(h.ingests[0].files[0].name, 'shot.png')
})

test('more file parts than chat allows are refused before any task exists', async () => {
    const h = harness()
    await assert.rejects(
        h.service.sendMessage(
            ctx,
            send(Array.from({ length: 11 }, () => secretFile()))
        ),
        rejectsWith(A2aErrorCode.invalidParams, /at most 10 file parts/)
    )
    assert.equal(h.rows.size, 0)
})

test('inline bytes past one message budget are refused before any task exists', async () => {
    const h = harness()
    await assert.rejects(
        h.service.sendMessage(
            ctx,
            send([
                {
                    kind: 'file',
                    file: { name: 'big.txt', bytes: 'A'.repeat(36 * 1024 * 1024) }
                }
            ])
        ),
        rejectsWith(A2aErrorCode.invalidParams, /more than \d+ bytes/)
    )
    assert.equal(h.rows.size, 0)
})

test('a file part with neither bytes nor uri is malformed', async () => {
    const h = harness()
    await assert.rejects(
        h.service.sendMessage(
            ctx,
            send([{ kind: 'file', file: { name: 'x.txt' } } as unknown as Part])
        ),
        rejectsWith(A2aErrorCode.invalidParams, /valid parts/)
    )
    assert.equal(h.rows.size, 0)
})

test('a message with no text and no file is still refused', async () => {
    const h = harness()
    await assert.rejects(
        h.service.sendMessage(ctx, send([{ kind: 'text', text: '' }])),
        rejectsWith(A2aErrorCode.contentTypeNotSupported, /text part, a file part/)
    )
})

test('a refusal from the workspace fails the task and keeps its code for the caller', async () => {
    const tooOld = 'the Manyfold CLI on sandbox-001 (4.8.0) is too old for this'
    const h = harness('claude-code', async () => {
        throw new ConflictException({
            code: 'SANDBOX_CLI_TOO_OLD',
            message: tooOld,
            details: { hostName: 'sandbox-001' }
        })
    })
    await assert.rejects(
        h.service.sendMessage(ctx, send([question, secretFile()])),
        (err: unknown) => {
            rejectsWith(A2aErrorCode.internalError)(err)
            assert.equal((err as A2aError).message, tooOld)
            assert.deepEqual((err as A2aError).data, {
                status: 409,
                code: 'SANDBOX_CLI_TOO_OLD',
                details: { hostName: 'sandbox-001' }
            })
            return true
        }
    )
    assert.equal(h.row().state, 'failed')
    assert.deepEqual(h.row().errorJson, {
        message: tooOld,
        code: 'SANDBOX_CLI_TOO_OLD'
    })
    assert.equal(h.turns.length, 0)
})

test('a file URL the SSRF guard refuses is the caller’s to fix', async () => {
    const h = harness()
    await assert.rejects(
        h.service.sendMessage(
            ctx,
            send([
                question,
                {
                    kind: 'file',
                    file: { uri: 'http://127.0.0.1/notes.txt' }
                }
            ])
        ),
        rejectsWith(A2aErrorCode.invalidParams, /file URL is not allowed/)
    )
    assert.equal(h.row().state, 'failed')
    assert.equal(
        (h.row().errorJson as { code?: string }).code,
        'file_ingest_failed'
    )
    assert.equal(h.ingests.length, 0)
})

test('a stream sees the task fail when its files are refused', async () => {
    const h = harness('claude-code', async () => {
        throw new ConflictException({ code: 'SANDBOX_CLI_TOO_OLD', message: 'old' })
    })
    const events: A2aStreamEvent[] = []
    await assert.rejects(
        h.service.sendMessage(ctx, send([question, secretFile()]), (event) =>
            events.push(event)
        ),
        rejectsWith(A2aErrorCode.internalError)
    )
    const last = events.at(-1)
    assert.equal(last?.kind, 'status-update')
    assert.equal(
        last?.kind === 'status-update' && last.status.state,
        'failed'
    )
    assert.equal(last?.kind === 'status-update' && last.final, true)
})

test('the card offers file input modes only for an agent that takes files', async () => {
    const card = await harness().service.buildAgentCard(
        'target',
        'https://api.example.com/api'
    )
    const modes = card?.defaultInputModes ?? []
    assert.ok(modes.includes('text/plain'))
    assert.ok(modes.includes('image/*'))
    assert.ok(modes.includes('application/pdf'))

    const textOnly = await harness('langflow').service.buildAgentCard(
        'target',
        'https://api.example.com/api'
    )
    assert.deepEqual(textOnly?.defaultInputModes, ['text/plain'])
})
