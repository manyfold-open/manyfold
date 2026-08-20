import assert from 'node:assert/strict'
import test from 'node:test'
import {
    ChatApiFileService,
    sanitizeFilename,
    uniqueName
} from '../src/modules/chat/api-files/chat-api-file.service'

test('sanitizeFilename confines a name to one safe segment', () => {
    assert.equal(sanitizeFilename('../../etc/passwd'), 'passwd')
    assert.equal(sanitizeFilename('/abs/path/x.png'), 'x.png')
    assert.equal(sanitizeFilename('..'), 'file')
    assert.equal(sanitizeFilename('.'), 'file')
    assert.equal(sanitizeFilename(''), 'file')
    assert.equal(sanitizeFilename('.hidden'), 'hidden')
    assert.equal(sanitizeFilename('a b@c.png'), 'a_b_c.png')
})

test('uniqueName dedupes within a batch', () => {
    const used = new Set<string>()
    assert.equal(uniqueName('a.png', used), 'a.png')
    assert.equal(uniqueName('a.png', used), 'a-1.png')
    assert.equal(uniqueName('a.png', used), 'a-2.png')
})

const makeService = (
    framework: string,
    opts: { binaryWriteSafe?: boolean; withStorage?: boolean } = {}
): { service: ChatApiFileService; writes: Array<{ abs: string }> } => {
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [{ id: 'agent-1', framework }]
                })
            })
        })
    }
    const writes: Array<{ abs: string }> = []
    const files = {
        build: async () => ({
            mountPath: '/workspace',
            binaryWriteSafe: opts.binaryWriteSafe,
            mkdir: async () => undefined,
            write: async (abs: string) => {
                writes.push({ abs })
            }
        })
    }
    const uploads =
        opts.withStorage === false
            ? undefined
            : { put: async () => ({ id: 'cup_test', size: 1 }) }
    const service = new ChatApiFileService(
        db as never,
        files as never,
        uploads as never
    )
    return { service, writes }
}

const file = () => ({
    name: 'a.png',
    contentType: 'image/png',
    bytes: Buffer.from('x')
})

test('dify routes files to the upload store', async () => {
    const { service } = makeService('dify')
    const r = await service.ingest({
        userId: 'u',
        agentId: 'agent-1',
        sessionId: 's',
        files: [file()]
    })
    assert.equal(r.uploads.length, 1)
    assert.equal(r.attachments.length, 0)
    assert.equal(r.uploads[0].uploadId, 'cup_test')
})

test('a coding agent routes files to a workspace attachment', async () => {
    const { service, writes } = makeService('claude-code')
    const r = await service.ingest({
        userId: 'u',
        agentId: 'agent-1',
        sessionId: 's',
        files: [file()]
    })
    assert.equal(r.attachments.length, 1)
    assert.equal(r.uploads.length, 0)
    assert.equal(writes.length, 1)
    assert.match(r.attachments[0].path, /^chat-attachments\/s\/.+\/a\.png$/)
})

test('a non-attachment framework rejects files', async () => {
    const { service } = makeService('langflow')
    await assert.rejects(() =>
        service.ingest({
            userId: 'u',
            agentId: 'agent-1',
            sessionId: 's',
            files: [file()]
        })
    )
})

test('a daemon agent without binary support rejects files', async () => {
    const { service } = makeService('claude-code', { binaryWriteSafe: false })
    await assert.rejects(() =>
        service.ingest({
            userId: 'u',
            agentId: 'agent-1',
            sessionId: 's',
            files: [file()]
        })
    )
})

// A proxied workspace write can fail after the bytes landed (#577: narranexus
// 502 arriving after the body was fully streamed). Accounting must follow the
// disk, not the error: a verifiably landed file is a written file, and only a
// genuinely absent or partial file may fail the ingest.
const makeWriteFailService = (opts: {
    stat: (abs: string) => Promise<{
        type: 'file' | 'dir'
        size: number
    } | null>
    telemetryEvents?: Array<{ name: string; attrs: Record<string, unknown> }>
}): ChatApiFileService => {
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [
                        { id: 'agent-1', framework: 'claude-code' }
                    ]
                })
            })
        })
    }
    const files = {
        build: async () => ({
            mountPath: '/workspace',
            mkdir: async () => undefined,
            write: async () => {
                throw new Error('narranexus files/write failed (status 502)')
            },
            stat: async (abs: string) => {
                const entry = await opts.stat(abs)
                return entry
                    ? {
                          entry: {
                              name: abs,
                              type: entry.type,
                              size: entry.size,
                              mtime: 0,
                              mode: '644'
                          },
                          contentType: 'application/octet-stream'
                      }
                    : null
            }
        })
    }
    const telemetry = opts.telemetryEvents
        ? {
              event: (name: string, attrs: Record<string, unknown>) =>
                  opts.telemetryEvents!.push({ name, attrs })
          }
        : undefined
    return new ChatApiFileService(
        db as never,
        files as never,
        undefined as never,
        telemetry as never
    )
}

test('a failed write whose file fully landed is accounted as written', async () => {
    const telemetryEvents: Array<{
        name: string
        attrs: Record<string, unknown>
    }> = []
    const service = makeWriteFailService({
        stat: async () => ({ type: 'file', size: 1 }),
        telemetryEvents
    })
    const r = await service.ingest({
        userId: 'u',
        agentId: 'agent-1',
        sessionId: 's',
        files: [file()]
    })
    assert.equal(r.attachments.length, 1)
    assert.match(r.attachments[0].path, /^chat-attachments\/s\/.+\/a\.png$/)
    assert.equal(
        telemetryEvents.filter(
            (e) => e.name === 'chat.attachment.write_reconciled'
        ).length,
        1
    )
})

test('a failed write with no file on disk still fails the ingest', async () => {
    const service = makeWriteFailService({ stat: async () => null })
    await assert.rejects(
        () =>
            service.ingest({
                userId: 'u',
                agentId: 'agent-1',
                sessionId: 's',
                files: [file()]
            }),
        /status 502/
    )
})

test('a failed write leaving a partial file still fails the ingest', async () => {
    const service = makeWriteFailService({
        stat: async () => ({ type: 'file', size: 0 })
    })
    await assert.rejects(
        () =>
            service.ingest({
                userId: 'u',
                agentId: 'agent-1',
                sessionId: 's',
                files: [file()]
            }),
        /status 502/
    )
})

test('a failed write whose landed-check also fails surfaces the write error', async () => {
    const service = makeWriteFailService({
        stat: async () => {
            throw new Error('path escapes workspace')
        }
    })
    await assert.rejects(
        () =>
            service.ingest({
                userId: 'u',
                agentId: 'agent-1',
                sessionId: 's',
                files: [file()]
            }),
        /status 502/
    )
})

test('supportsAttachments reflects framework capabilities', async () => {
    const { service: claude } = makeService('claude-code')
    assert.equal(await claude.supportsAttachments('agent-1'), true)

    const { service: langflow } = makeService('langflow')
    assert.equal(await langflow.supportsAttachments('agent-1'), false)
})

// This capability is what channel-bridge consults before it downloads a single
// inbound byte: with it off the file is dropped at the gate, whatever the
// workspace can do. It is on now that narraNexusCtx.write reaches the gateway's
// write endpoint.
test('supportsAttachments is on for narranexus now that the workspace accepts writes', async () => {
    const { service } = makeService('narranexus')
    assert.equal(await service.supportsAttachments('agent-1'), true)
})

test('supportsAttachments is false for a missing agent', async () => {
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => []
                })
            })
        })
    }
    const service = new ChatApiFileService(
        db as never,
        { build: async () => ({}) } as never,
        undefined as never
    )
    assert.equal(await service.supportsAttachments('agent-x'), false)
})

const makeReadService = (
    entries: Record<string, { size: number; bytes: Buffer; contentType: string }>,
    framework = 'claude-code'
): ChatApiFileService => {
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [{ id: 'agent-1', framework }]
                })
            })
        })
    }
    const files = {
        build: async () => ({
            mountPath: '/work',
            stat: async (abs: string) => {
                const e = entries[abs]
                return e
                    ? {
                          entry: {
                              name: abs,
                              type: 'file',
                              size: e.size,
                              mtime: 0,
                              mode: ''
                          },
                          contentType: e.contentType
                      }
                    : null
            },
            read: async (abs: string) => {
                const e = entries[abs]
                if (!e) return null
                return {
                    stream: (async function* () {
                        yield e.bytes
                    })(),
                    size: e.bytes.length,
                    contentType: e.contentType
                }
            }
        })
    }
    return new ChatApiFileService(db as never, files as never, undefined as never)
}

test('readWorkspaceFiles reads existing files and skips missing ones', async () => {
    const service = makeReadService({
        '/work/sine.png': {
            size: 7,
            bytes: Buffer.from('PNGDATA'),
            contentType: 'image/png'
        }
    })
    const out = await service.readWorkspaceFiles('agent-1', [
        { relPath: 'sine.png', name: 'sine.png' },
        { relPath: 'missing.png', name: 'missing.png' }
    ])
    assert.equal(out.length, 1)
    assert.equal(out[0].name, 'sine.png')
    assert.equal(out[0].contentType, 'image/png')
    assert.equal(out[0].bytes.toString(), 'PNGDATA')
})

test('readWorkspaceFiles enforces the per-file byte cap', async () => {
    const service = makeReadService({
        '/work/big.png': {
            size: 20 * 1024 * 1024,
            bytes: Buffer.alloc(20 * 1024 * 1024),
            contentType: 'image/png'
        }
    })
    const out = await service.readWorkspaceFiles('agent-1', [
        { relPath: 'big.png', name: 'big.png' }
    ])
    assert.equal(out.length, 0)
})

test('readWorkspaceFiles returns nothing for a workspace-less framework', async () => {
    const service = makeReadService(
        {
            '/work/a.png': {
                size: 1,
                bytes: Buffer.from('x'),
                contentType: 'image/png'
            }
        },
        'dify'
    )
    const out = await service.readWorkspaceFiles('agent-1', [
        { relPath: 'a.png', name: 'a.png' }
    ])
    assert.equal(out.length, 0)
})
