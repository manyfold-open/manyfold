import { createHash } from 'node:crypto'
import {
    DAEMON_FEATURE_FS_ROOTS,
    DAEMON_FEATURE_FS_WRITE_STREAM,
    FILES_UPLOAD_MAX_BYTES
} from '@manyfold/shared'
import test from 'node:test'
import assert from 'node:assert/strict'
import { BadGatewayException, NotFoundException } from '@nestjs/common'
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
import {
    contextOf,
    daemonRow,
    fakeRuntimeContext,
    hostRow,
    runtimeRow,
    spritesHostRow
} from './helpers/runtime-context-fixture'

const agent = (overrides: Partial<Agent> = {}): Agent =>
    ({
        id: 'agent-1',
        userId: 'user-1',
        runtimeId: 'runtime-1',
        name: 'local claude',
        framework: 'claude-code',
        status: 'ready',
        internalId: 'agent-1',
        model: null,
        extras: {},
        workspacePath: '/Users/me/.nca/workspaces/agent-1',
        mountPath: '/Users/me/.nca/workspaces/agent-1',
        fileRoots: [],
        currentPhase: null,
        failureReason: null,
        startedAt: new Date(),
        lastBootstrappedAt: new Date(),
        lastReconciledAt: new Date(),
        createdAt: new Date(),
        updatedAt: new Date(),
        ...overrides
    }) as Agent

const localContext = (
    row: Agent = agent(),
    overrides: { daemonOnline?: boolean; features?: string[] } = {}
) =>
    contextOf({
        agent: row,
        host: hostRow({ id: 'dh-1', homeDir: '/Users/me' }),
        daemon: daemonRow({
            hostId: 'dh-1',
            clientFeatures: overrides.features ?? [],
            ...(overrides.daemonOnline === false
                ? { lastSeenAt: new Date(0), rpcLastSeenAt: new Date(0) }
                : {})
        })
    })

// The one admission rule (ADR-0037): an installed runtime on a ready host. A
// hosted machine that is asleep is still admitted (reads wake it); a local
// one whose daemon is gone is not.
test('assertAgentReady accepts an available local agent', () => {
    assert.doesNotThrow(() => assertAgentReady(localContext()))
})

test('assertAgentReady rejects a local agent whose daemon is offline', () => {
    assert.throws(
        () => assertAgentReady(localContext(agent(), { daemonOnline: false })),
        (err: unknown) =>
            err instanceof NotFoundException &&
            err.message.startsWith('agent is offline')
    )
})

test('assertAgentReady admits a sleeping sandbox and refuses an uninstalled runtime', () => {
    const asleep = contextOf({
        agent: agent(),
        host: spritesHostRow({ powerState: 'suspended' }),
        daemon: null
    })
    assert.doesNotThrow(() => assertAgentReady(asleep))
    const installing = contextOf({
        agent: agent(),
        runtime: runtimeRow({ status: 'installing' }),
        host: hostRow()
    })
    assert.throws(
        () => assertAgentReady(installing),
        (err: unknown) =>
            err instanceof NotFoundException &&
            err.message.startsWith('agent is unavailable')
    )
})

test('assertAgentReady rejects external agents', () => {
    assert.throws(
        () =>
            assertAgentReady(
                contextOf({ agent: agent(), host: null, daemon: null })
            ),
        (err: unknown) =>
            err instanceof NotFoundException &&
            err.message === 'external-runtime agents have no filesystem'
    )
})

const frameworkAgent = (overrides: Partial<Agent> = {}): Agent =>
    agent({
        framework: FIXTURE,
        mountPath: FIXTURE_WORKSPACE,
        ...overrides
    })

// A framework that serves its own files (FrameworkDefinition.files): its
// provider owns the roots, answers the ones it serves, and hands the rest back
// to the runtime's own transport — the host's daemon (here a sprites host).
const frameworkBuilder = (
    files: Record<string, Uint8Array> = {}
): FilesContextBuilder =>
    new FilesContextBuilder(
        fakeRuntimeContext((id) =>
            contextOf({
                agent: frameworkAgent({ id }),
                host: spritesHostRow({ id: 'spa-1' })
            })
        ) as never,
        {} as never,
        {
            withHost: async () => {
                throw new Error('the daemon path was taken')
            }
        } as never,
        extensionsWith({ framework: FIXTURE, files: fixtureFiles(files) })
    )

test('a root the framework does not serve goes through the host daemon', async () => {
    const ctx = await frameworkBuilder().build(frameworkAgent(), 'home')
    await assert.rejects(
        () => ctx.list(ctx.mountPath),
        (err: unknown) =>
            err instanceof BadGatewayException &&
            err.message.includes('the daemon path was taken')
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

// keeping the stored roots in their current shape avoids the fileRoots
// backfill write
const daemonAgent = (overrides: Partial<Agent> = {}): Agent =>
    agent({
        ...overrides,
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
    sessions: Array<{ reason: string; requiredFeatures?: readonly string[] }>
    holds: Array<{ released: boolean }>
    settleRead: (payload: Record<string, unknown>) => void
    failRead: (err: Error) => void
    builder: FilesContextBuilder
}

const daemonStub = (
    opts: {
        stat?: Record<string, unknown> | null
        chunks?: Buffer[]
        // a sandbox instead of a self-owned computer
        hosted?: boolean
        failMethod?: string
    } = {}
): DaemonStub => {
    const calls: DaemonCall[] = []
    const sessions: DaemonStub['sessions'] = []
    const holds: DaemonStub['holds'] = []
    let settle: (payload: Record<string, unknown>) => void = () => {}
    let fail: (err: Error) => void = () => {}
    const rpc = async (call: DaemonCall) => {
        calls.push({ method: call.method, payload: call.payload })
        if (call.method === opts.failMethod) throw new Error(`${call.method} failed`)
        if (call.method === 'fs.stat')
            return opts.stat === undefined ? { size: 0, isDir: false } : opts.stat
        if (call.method === 'fs.write.begin')
            return { uploadId: 'upl-1', chunkMaxBytes: 4 }
        return {}
    }
    const stream = (call: DaemonCall & { onEvent: (k: string, d: string) => void }) => {
        calls.push({ method: call.method, payload: call.payload })
        const result = new Promise<Record<string, unknown>>((resolve, reject) => {
            settle = resolve
            fail = reject
        })
        // the daemon emits every fs.chunk before its final frame, which is
        // exactly the ordering that used to win the size race and yield 0
        for (const chunk of opts.chunks ?? [])
            call.onEvent('fs.chunk', chunk.toString('base64'))
        return { refId: 'ref-1', result, cancel: () => fail(new Error('cancelled')) }
    }
    const host = opts.hosted
        ? spritesHostRow({ id: 'sbx-1', homeDir: '/home/sprite' })
        : hostRow({ id: 'dh-1', homeDir: '/Users/me' })
    return {
        calls,
        sessions,
        holds,
        settleRead: (payload) => settle(payload),
        failRead: (err) => fail(err),
        builder: new FilesContextBuilder(
            fakeRuntimeContext((id) =>
                contextOf({
                    agent: daemonAgent({ id }),
                    host,
                    daemon: daemonRow({ hostId: host.id })
                })
            ) as never,
            {} as never,
            // Every daemon call runs under the host session (ADR-0038).
            {
                withHost: async (
                    args: {
                        host: { id: string }
                        daemon: unknown
                        reason: string
                        requiredFeatures?: readonly string[]
                    },
                    work: (session: Record<string, unknown>) => Promise<unknown>
                ) => {
                    sessions.push({
                        reason: args.reason,
                        requiredFeatures: args.requiredFeatures
                    })
                    return work({
                        host: args.host,
                        daemon: args.daemon,
                        daemonId: args.host.id,
                        rpc,
                        stream
                    })
                },
                hold: () => {
                    const hold = { released: false }
                    holds.push(hold)
                    return {
                        release: async () => {
                            hold.released = true
                        }
                    }
                }
            } as never
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

test('resolveRootsForSdk reports the daemon\'s streaming capabilities', async () => {
    const roots = await daemonStub().builder.resolveRootsForSdk(daemonAgent())
    assert.deepEqual(
        roots.map((r) => r.id),
        ['workspace', 'claude-home']
    )
    assert.equal(roots[0].capabilities?.binarySafe, true)
    assert.equal(roots[0].capabilities?.streamWrite, true)
    assert.equal(roots[0].capabilities?.maxUploadBytes, FILES_UPLOAD_MAX_BYTES)
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

// The download outlives the call that opened it, so it holds the machine
// until it ends, and lets go then.
test('a download holds its machine until the read ends', async () => {
    const stub = daemonStub({ stat: { size: 1, isDir: false }, chunks: [Buffer.from('x')] })
    const ctx = await stub.builder.build(daemonAgent(), 'workspace')
    const result = await ctx.read(`${DAEMON_WORKSPACE}/x.txt`)
    assert.ok(result)
    assert.deepEqual(stub.holds, [{ released: false }])
    stub.settleRead({})
    await result.done
    assert.deepEqual(stub.holds, [{ released: true }])
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

// A write streams into a part file in chunks and becomes the target at commit,
// once its size and sha256 match; binary content is carried exactly.
test('a write streams its body in chunks and commits it with its size and sha256', async () => {
    const stub = daemonStub()
    const ctx = await stub.builder.build(daemonAgent(), 'workspace')
    const body = Buffer.from([0xff, 0xd8, 0xff, 0x00, 0x01, 0x02])

    await ctx.write(`${DAEMON_WORKSPACE}/logo.png`, body)

    const writes = stub.calls.filter((c) => c.method.startsWith('fs.write'))
    assert.deepEqual(
        writes.map((c) => c.method),
        ['fs.write.begin', 'fs.write.chunk', 'fs.write.chunk', 'fs.write.commit']
    )
    const sent = Buffer.concat(
        writes
            .filter((c) => c.method === 'fs.write.chunk')
            .map((c) => Buffer.from(String(c.payload.data), 'base64'))
    )
    assert.deepEqual(sent, body)
    assert.deepEqual(
        writes.filter((c) => c.method === 'fs.write.chunk').map((c) => c.payload.seq),
        [0, 1]
    )
    const commit = writes.at(-1)!.payload
    assert.equal(commit.size, body.byteLength)
    assert.equal(commit.sha256, createHash('sha256').update(body).digest('hex'))
    // A self-owned computer admits what its daemon registered: nothing vouched.
    assert.equal(writes[0].payload.roots, undefined)
    const write = stub.sessions.find((s) => s.reason === 'files-write')
    assert.deepEqual(write?.requiredFeatures, [DAEMON_FEATURE_FS_WRITE_STREAM])
})

test('a write that fails part way aborts its upload', async () => {
    const stub = daemonStub({ failMethod: 'fs.write.chunk' })
    const ctx = await stub.builder.build(daemonAgent(), 'workspace')

    await assert.rejects(() => ctx.write(`${DAEMON_WORKSPACE}/x.bin`, Buffer.from('abc')))
    assert.deepEqual(
        stub.calls.filter((c) => c.method.startsWith('fs.write')).map((c) => c.method),
        ['fs.write.begin', 'fs.write.chunk', 'fs.write.abort']
    )
})

// The platform owns a sandbox's filesystem: every call vouches for the root it
// works in, and needs a daemon that honours that.
test('a sandbox vouches for the root on every call', async () => {
    const stub = daemonStub({ hosted: true })
    const ctx = await stub.builder.build(daemonAgent(), 'workspace')
    await ctx.list(DAEMON_WORKSPACE)
    await ctx.write(`${DAEMON_WORKSPACE}/a.txt`, Buffer.from('a'))
    for (const call of stub.calls)
        if (call.method !== 'fs.write.chunk' && call.method !== 'fs.write.commit')
            assert.deepEqual(call.payload.roots, [DAEMON_WORKSPACE], call.method)
    assert.ok(
        stub.sessions.every((s) => s.requiredFeatures?.includes(DAEMON_FEATURE_FS_ROOTS))
    )
    assert.deepEqual(
        stub.sessions.find((s) => s.reason === 'files-write')?.requiredFeatures,
        [DAEMON_FEATURE_FS_ROOTS, DAEMON_FEATURE_FS_WRITE_STREAM]
    )
})
