import {
    DAEMON_FEATURE_FS_WRITE_BINARY,
    DAEMON_FS_WRITE_MAX_BYTES
} from '@manyfold/shared'
import test from 'node:test'
import assert from 'node:assert/strict'
import { BadRequestException, NotFoundException } from '@nestjs/common'
import type { Agent } from '@manyfold/db'
import {
    FilesContextBuilder,
    assertAgentReady
} from '../src/modules/agents/files/files-context'
import {
    FIXTURE,
    FIXTURE_WORKSPACE,
    fixtureFiles
} from './helpers/fixture-framework'
import { extensionsWith } from './helpers/framework-extensions-stub'

const agent = (overrides: Partial<Agent> = {}): Agent =>
    ({
        id: 'agent-1',
        userId: 'user-1',
        runtimeId: 'runtime-1',
        name: 'local claude',
        framework: 'claude-code',
        runtime: 'daemon',
        status: 'running',
        spriteStatus: null,
        k8sPodPhase: null,
        accountId: null,
        clusterId: null,
        daemonId: 'dh-1',
        internalId: 'agent-1',
        model: null,
        extras: {},
        workspacePath: '/Users/me/.nca/workspaces/agent-1',
        spriteName: null,
        spriteId: null,
        mountPath: '/Users/me/.nca/workspaces/agent-1',
        fileRoots: [],
        namespace: null,
        ingressHost: null,
        currentPhase: null,
        failureReason: null,
        startedAt: new Date(),
        lastBootstrappedAt: new Date(),
        lastReconciledAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides
    }) as Agent

test('assertAgentReady accepts running daemon agents with daemonId', () => {
    assert.doesNotThrow(() => assertAgentReady(agent()))
})

test('assertAgentReady rejects daemon agents without daemonId', () => {
    assert.throws(
        () => assertAgentReady(agent({ daemonId: null })),
        (err: unknown) =>
            err instanceof NotFoundException &&
            err.message === 'daemon agent missing daemonId'
    )
})

test('assertAgentReady still rejects k8s agents without namespace', () => {
    assert.throws(
        () => assertAgentReady(agent({ runtime: 'k8s', daemonId: null })),
        (err: unknown) =>
            err instanceof NotFoundException &&
            err.message === 'k8s agent missing namespace'
    )
})

const frameworkAgent = (overrides: Partial<Agent> = {}): Agent =>
    agent({
        framework: FIXTURE,
        runtime: 'sprites',
        daemonId: null,
        spriteName: 'sprite-1',
        accountId: 'spa-1',
        mountPath: FIXTURE_WORKSPACE,
        ...overrides
    })

// A framework that serves its own files (FrameworkDefinition.files): its
// provider owns the roots, answers the ones it serves, and hands the rest back
// to the runtime's own transport.
const frameworkBuilder = (
    files: Record<string, Uint8Array> = {}
): FilesContextBuilder =>
    new FilesContextBuilder(
        { getById: async () => null } as never,
        { findById: async () => null } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        extensionsWith({ framework: FIXTURE, files: fixtureFiles(files) })
    )

// With no sprite account wired, the runtime transport fails on the account
// lookup, which proves the root took that path rather than the provider's.
test('a root the framework does not serve goes through the runtime transport', async () => {
    await assert.rejects(
        () => frameworkBuilder().build(frameworkAgent(), 'home'),
        (err: unknown) =>
            err instanceof NotFoundException &&
            err.message === 'sprites account spa-1 not found'
    )
})

test('a framework-served agent still rejects an unknown rootId', async () => {
    await assert.rejects(
        () => frameworkBuilder().build(frameworkAgent(), 'bogus'),
        (err: unknown) =>
            err instanceof NotFoundException &&
            err.message === 'unknown file root: bogus'
    )
})

test('a framework-served root is built by the framework provider', async () => {
    const ctx = await frameworkBuilder().build(frameworkAgent(), 'workspace')
    assert.equal(ctx.root.id, 'workspace')
    assert.equal(ctx.mountPath, FIXTURE_WORKSPACE)
})

const DAEMON_WORKSPACE = '/Users/me/.manyfold/workspaces/agent-1'

// keeping the stored roots in their current shape avoids the fileRoots backfill
// write, so the db stub only has to serve the clientFeatures lookup
const daemonAgent = (): Agent =>
    agent({
        mountPath: DAEMON_WORKSPACE,
        workspacePath: DAEMON_WORKSPACE,
        fileRoots: [
            {
                id: 'workspace',
                label: 'Workspace',
                path: DAEMON_WORKSPACE,
                writable: true
            },
            {
                id: 'claude-home',
                label: 'Claude config',
                path: '/Users/me/.claude',
                writable: true
            }
        ]
    })

interface DaemonCall {
    method: string
    payload: Record<string, unknown>
}

interface DaemonStub {
    calls: DaemonCall[]
    settleRead: (payload: Record<string, unknown>) => void
    failRead: (err: Error) => void
    builder: FilesContextBuilder
}

const daemonStub = (
    opts: {
        stat?: Record<string, unknown> | null
        chunks?: Buffer[]
        features?: string[]
    } = {}
): DaemonStub => {
    const calls: DaemonCall[] = []
    let settle: (payload: Record<string, unknown>) => void = () => {}
    let fail: (err: Error) => void = () => {}
    const registry = {
        rpc: async (args: DaemonCall) => {
            calls.push({ method: args.method, payload: args.payload })
            if (args.method === 'fs.stat')
                return opts.stat === undefined
                    ? { size: 0, isDir: false }
                    : opts.stat
            return { ok: true }
        },
        streamRpc: (
            args: DaemonCall & { onEvent: (k: string, d: string) => void }
        ) => {
            calls.push({ method: args.method, payload: args.payload })
            const result = new Promise<Record<string, unknown>>(
                (resolve, reject) => {
                    settle = resolve
                    fail = reject
                }
            )
            // the daemon emits every fs.chunk before its final frame, which is
            // exactly the ordering that used to win the size race and yield 0
            for (const chunk of opts.chunks ?? [])
                args.onEvent('fs.chunk', chunk.toString('base64'))
            return { result }
        }
    }
    const rows = [
        { clientFeatures: opts.features ?? [DAEMON_FEATURE_FS_WRITE_BINARY] }
    ]
    const db = {
        select: () => ({
            from: () => ({ where: () => ({ limit: async () => rows }) })
        })
    }
    return {
        calls,
        settleRead: (payload) => settle(payload),
        failRead: (err) => fail(err),
        builder: new FilesContextBuilder(
            {} as never,
            { findById: async () => null } as never,
            {} as never,
            {} as never,
            registry as never,
            db as never
        )
    }
}

const drain = async (
    stream: AsyncIterable<Uint8Array | Buffer>
): Promise<Buffer> => {
    const parts: Buffer[] = []
    for await (const chunk of stream)
        parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    return Buffer.concat(parts)
}

test('a framework-served context infers image MIME for generic stat and read responses', async () => {
    const path = `${FIXTURE_WORKSPACE}/logo.png`
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const ctx = await frameworkBuilder({ [path]: body }).build(
        frameworkAgent(),
        'workspace'
    )
    const stat = await ctx.stat(path)
    const read = await ctx.read(path)

    assert.equal(stat?.contentType, 'image/png')
    assert.ok(read)
    assert.equal(read.contentType, 'image/png')
    assert.equal(read.size, body.byteLength)
    assert.deepEqual(await drain(read.stream), body)
})

test('resolveRootsForSdk reports daemon capabilities from the host features', async () => {
    const stale = daemonStub({ features: [] })
    const staleRoots = await stale.builder.resolveRootsForSdk(daemonAgent())

    assert.deepEqual(
        staleRoots.map((r) => r.id),
        ['workspace', 'claude-home']
    )
    assert.equal(staleRoots[0].capabilities?.binarySafe, false)
    assert.equal(
        staleRoots[0].capabilities?.maxUploadBytes,
        DAEMON_FS_WRITE_MAX_BYTES
    )

    const current = daemonStub()
    const currentRoots = await current.builder.resolveRootsForSdk(daemonAgent())
    assert.equal(currentRoots[0].capabilities?.binarySafe, true)
})

// fs.read reports size only in its final frame, so the old code raced that frame
// against the first chunk and settled for 0 on any multi-chunk file — which the
// controller then sent as Content-Length: 0. The size must come from stat and be
// known before the transfer finishes.
test('daemon read reports the stat size before the transfer completes', async () => {
    const body = Buffer.from('hello daemon')
    const stub = daemonStub({
        stat: { size: body.byteLength, isDir: false },
        chunks: [body.subarray(0, 5), body.subarray(5)]
    })
    const ctx = await stub.builder.build(daemonAgent(), 'workspace')

    const result = await ctx.read(`${DAEMON_WORKSPACE}/hello.txt`)

    assert.ok(result)
    assert.equal(result.size, body.byteLength)
    assert.deepEqual(
        stub.calls.map((c) => c.method).filter((m) => m !== 'fs.mkdir'),
        ['fs.stat', 'fs.read']
    )

    stub.settleRead({ size: body.byteLength, chunked: true })
    assert.deepEqual(await drain(result.stream), body)
    await result.done
})

test('daemon context infers image MIME without additional filesystem RPCs', async () => {
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const stub = daemonStub({
        stat: { size: body.byteLength, isDir: false },
        chunks: [body]
    })
    const ctx = await stub.builder.build(daemonAgent(), 'workspace')
    const path = `${DAEMON_WORKSPACE}/logo.PNG`

    const stat = await ctx.stat(path)
    const read = await ctx.read(path)

    assert.equal(stat?.contentType, 'image/png')
    assert.ok(read)
    assert.equal(read.contentType, 'image/png')
    assert.deepEqual(
        stub.calls.map((call) => call.method).filter((m) => m !== 'fs.mkdir'),
        ['fs.stat', 'fs.stat', 'fs.read']
    )

    stub.settleRead({ size: body.byteLength, chunked: true })
    assert.deepEqual(await drain(read.stream), body)
    await read.done
})

test('daemon read returns null for a missing path so the controller can 404', async () => {
    const stub = daemonStub({ stat: null })
    const ctx = await stub.builder.build(daemonAgent(), 'workspace')

    assert.equal(await ctx.read(`${DAEMON_WORKSPACE}/nope.txt`), null)
})

test('daemon read returns null for a directory', async () => {
    const stub = daemonStub({ stat: { size: 4096, isDir: true } })
    const ctx = await stub.builder.build(daemonAgent(), 'workspace')

    assert.equal(await ctx.read(DAEMON_WORKSPACE), null)
})

// a failing fs.read must surface through done() rather than look like a
// successful short download
test('daemon read propagates an rpc failure through done', async () => {
    const stub = daemonStub({
        stat: { size: 3, isDir: false },
        chunks: [Buffer.from('a')]
    })
    const ctx = await stub.builder.build(daemonAgent(), 'workspace')
    const result = await ctx.read(`${DAEMON_WORKSPACE}/partial.bin`)

    assert.ok(result)
    stub.failRead(new Error('daemon disconnected'))
    await assert.rejects(
        () => result.done as Promise<void>,
        (err: unknown) =>
            err instanceof Error && err.message === 'daemon disconnected'
    )
})

// the legacy fs.write takes a UTF-8 string, so bytes that are not valid UTF-8
// used to land on disk mangled with a 200 back to the caller
test('daemon write refuses binary bodies when the daemon lacks fs.write.binary', async () => {
    const stub = daemonStub({ features: [] })
    const ctx = await stub.builder.build(daemonAgent(), 'workspace')

    await assert.rejects(
        () =>
            ctx.write(
                `${DAEMON_WORKSPACE}/logo.png`,
                Buffer.from([0xff, 0xd8, 0xff])
            ),
        (err: unknown) => err instanceof BadRequestException
    )
    assert.equal(
        stub.calls.some((c) => c.method === 'fs.write'),
        false
    )
})

// text still has to work on old daemons: that's the whole point of only
// refusing what UTF-8 cannot represent
test('daemon write still sends text as utf8 when the daemon lacks fs.write.binary', async () => {
    const stub = daemonStub({ features: [] })
    const ctx = await stub.builder.build(daemonAgent(), 'workspace')

    await ctx.write(`${DAEMON_WORKSPACE}/notes.md`, Buffer.from('# 你好\n'))

    const write = stub.calls.find((c) => c.method === 'fs.write')
    assert.equal(write?.payload.content, '# 你好\n')
    assert.equal(write?.payload.encoding, undefined)
})

test('daemon write sends base64 when the daemon advertises fs.write.binary', async () => {
    const stub = daemonStub()
    const ctx = await stub.builder.build(daemonAgent(), 'workspace')
    const body = Buffer.from([0xff, 0xd8, 0xff])

    await ctx.write(`${DAEMON_WORKSPACE}/logo.png`, body)

    const write = stub.calls.find((c) => c.method === 'fs.write')
    assert.equal(write?.payload.encoding, 'base64')
    assert.equal(write?.payload.content, body.toString('base64'))
})
