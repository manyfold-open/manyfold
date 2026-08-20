import test from 'node:test'
import assert from 'node:assert/strict'
import { Readable } from 'node:stream'
import { PayloadTooLargeException } from '@nestjs/common'
import type { FastifyRequest } from 'fastify'
import type { Agent, FileRoot } from '@manyfold/db'
import { FilesController } from '../src/modules/agents/files/files.controller'
import type { FilesContext } from '../src/modules/agents/files/files-context'
import { isStreamBody } from '../src/modules/agents/files/files-upload'

const WORKSPACE = '/home/sprite/workspace'

const agent = (overrides: Partial<Agent> = {}): Agent =>
    ({
        id: 'agent-1',
        userId: 'user-1',
        framework: 'claude-code',
        runtime: 'sprites',
        status: 'running',
        spriteName: 'sprite-1',
        accountId: 'spa-1',
        mountPath: WORKSPACE,
        fileRoots: [],
        ...overrides
    }) as Agent

const root = (overrides: Partial<FileRoot> = {}): FileRoot =>
    ({
        id: 'workspace',
        label: 'Workspace',
        path: WORKSPACE,
        writable: true,
        ...overrides
    }) as FileRoot

interface Harness {
    controller: FilesController
    writes: Array<{ absPath: string; body: unknown }>
}

const harness = (target: Agent, fileRoot: FileRoot = root()): Harness => {
    const writes: Array<{ absPath: string; body: unknown }> = []
    const ctx: FilesContext = {
        agent: target,
        root: fileRoot,
        mountPath: fileRoot.path,
        list: async () => [],
        stat: async () => null,
        read: async () => null,
        write: async (absPath, body) => {
            writes.push({ absPath, body })
        },
        mkdir: async () => {},
        mv: async () => {},
        rm: async () => {}
    }
    const controller = new FilesController(
        { findForCaller: async () => target } as never,
        { build: async () => ctx, resolveRootsForSdk: async () => [] } as never
    )
    return { controller, writes }
}

const request = (contentLength?: number): FastifyRequest =>
    ({
        headers:
            contentLength === undefined
                ? {}
                : { 'content-length': String(contentLength) }
    }) as FastifyRequest

const user = { userId: 'user-1' } as never

// the request body used to be materialised by the octet-stream parser before the
// handler ran, so peak memory tracked file size
test('write hands the request stream to the adapter without buffering it', async () => {
    const { controller, writes } = harness(agent())
    const body = Readable.from([Buffer.from('chunk-1'), Buffer.from('chunk-2')])

    await controller.write(
        user,
        'agent-1',
        'notes.md',
        request(14),
        body,
        undefined
    )

    assert.equal(writes.length, 1)
    assert.equal(writes[0].absPath, `${WORKSPACE}/notes.md`)
    assert.equal(isStreamBody(writes[0].body as never), true)
    assert.equal(Buffer.isBuffer(writes[0].body), false)
})

test('write treats a missing body as an empty file', async () => {
    const { controller, writes } = harness(agent())

    await controller.write(
        user,
        'agent-1',
        'empty.bin',
        request(0),
        undefined,
        undefined
    )

    assert.equal(Buffer.isBuffer(writes[0].body), true)
    assert.equal((writes[0].body as Buffer).byteLength, 0)
})

// pod-exec caps writes at 5 MiB; the caller should hear that before sending a
// single byte instead of failing deep in the runtime
test('write rejects an over-limit upload from the declared length alone', async () => {
    const { controller, writes } = harness(
        agent({ runtime: 'k8s', namespace: 'ns-1' }),
        root({ transport: 'pod-exec' })
    )

    await assert.rejects(
        () =>
            controller.write(
                user,
                'agent-1',
                'big.bin',
                request(6 * 1024 * 1024),
                Readable.from([Buffer.alloc(1)]),
                undefined
            ),
        (err: unknown) => err instanceof PayloadTooLargeException
    )
    assert.equal(writes.length, 0)
})

test('write accepts an upload at exactly the declared limit', async () => {
    const { controller, writes } = harness(
        agent({ runtime: 'k8s', namespace: 'ns-1' }),
        root({ transport: 'pod-exec' })
    )

    await controller.write(
        user,
        'agent-1',
        'exact.bin',
        request(5 * 1024 * 1024),
        Readable.from([Buffer.alloc(1)]),
        undefined
    )

    assert.equal(writes.length, 1)
})

test('write refuses a read-only root before touching the body', async () => {
    const { controller, writes } = harness(agent(), root({ writable: false }))

    await assert.rejects(() =>
        controller.write(
            user,
            'agent-1',
            'nope.md',
            request(4),
            Readable.from([Buffer.alloc(4)]),
            undefined
        )
    )
    assert.equal(writes.length, 0)
})
