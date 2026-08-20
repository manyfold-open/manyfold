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

const NN_SPRITE_WORKSPACE =
    '/home/sprite/.narranexus/data/workspaces/agent-1_mf_user-1'

const narraNexusAgent = (overrides: Partial<Agent> = {}): Agent =>
    agent({
        framework: 'narranexus',
        runtime: 'sprites',
        daemonId: null,
        spriteName: 'sprite-1',
        accountId: 'spa-1',
        mountPath: NN_SPRITE_WORKSPACE,
        fileRoots: [
            {
                id: 'workspace',
                label: 'Workspace',
                path: NN_SPRITE_WORKSPACE,
                writable: true
            },
            { id: 'home', label: 'Home', path: '/home/sprite', writable: true }
        ],
        ...overrides
    })

const filesBuilder = (): FilesContextBuilder =>
    new FilesContextBuilder(
        { getById: async () => null } as never,
        { findById: async () => null } as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never
    )

// A builder whose narranexus runtime + gateway token resolve, so resolveRoots
// actually reaches GET /files/roots. Captures the agent-row write-back.
const narraNexusBuilder = (): {
    builder: FilesContextBuilder
    updates: Record<string, unknown>[]
} => {
    const updates: Record<string, unknown>[] = []
    const db = {
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [
                        { payloadCiphertext: 'ct', keyVersion: 1 }
                    ]
                })
            })
        }),
        update: () => ({
            set: (patch: Record<string, unknown>) => ({
                where: async () => {
                    updates.push(patch)
                }
            })
        })
    }
    return {
        builder: new FilesContextBuilder(
            { getById: async () => null } as never,
            {
                findById: async () => ({
                    id: 'runtime-1',
                    ingressHost: 'gw.example.com'
                })
            } as never,
            {} as never,
            {} as never,
            {} as never,
            db as never,
            { decrypt: () => JSON.stringify({ gatewayToken: 'tok' }) } as never
        ),
        updates
    }
}

const withRootsResponse = async <T>(
    respond: () => { ok: boolean; status: number; body?: unknown },
    run: (calls: string[]) => Promise<T>
): Promise<T> => {
    const calls: string[] = []
    const orig = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
        calls.push(url)
        const r = respond()
        return {
            ok: r.ok,
            status: r.status,
            text: async () => JSON.stringify(r.body ?? {})
        }
    }) as never
    try {
        return await run(calls)
    } finally {
        globalThis.fetch = orig
    }
}

const NN_GATEWAY_WORKSPACE = '/data/workspaces/mf_user-1/agent-1'

// issue #120 + multi-root: the gateway serves only the read-only workspace,
// but on sprites Manyfold additionally exposes ~/.narranexus and home as
// read-only roots browsed via direct sprite access
test('narranexus resolveRoots exposes workspace + ~/.narranexus + home on sprites', async () => {
    const roots = await filesBuilder().resolveRoots(narraNexusAgent())
    assert.deepEqual(roots, [
        {
            id: 'workspace',
            label: 'Workspace',
            path: NN_SPRITE_WORKSPACE,
            writable: false
        },
        {
            id: 'narranexus-home',
            label: 'NarraNexus config',
            path: '/home/sprite/.narranexus',
            writable: false
        },
        {
            id: 'home',
            label: 'Home',
            path: '/home/sprite',
            writable: false
        }
    ])
})

// off sprites (k8s) there's no direct sprite access, so it stays workspace-only
test('narranexus resolveRoots stays workspace-only on k8s', async () => {
    const roots = await filesBuilder().resolveRoots(
        narraNexusAgent({ runtime: 'k8s' })
    )
    assert.deepEqual(roots, [
        {
            id: 'workspace',
            label: 'Workspace',
            path: NN_SPRITE_WORKSPACE,
            writable: false
        }
    ])
})

// The layout under BASE_WORKING_PATH belongs to NarraNexus and has changed once
// already. Deriving it locally addressed a directory outside the workspace, and
// every file call then died on the far side's containment check — so the
// gateway's own answer is the only acceptable source.
test('narranexus workspace root comes from the gateway, not a local guess', async () => {
    const { builder, updates } = narraNexusBuilder()
    const roots = await withRootsResponse(
        () => ({
            ok: true,
            status: 200,
            body: {
                roots: [
                    {
                        id: 'workspace',
                        label: 'Workspace',
                        path: NN_GATEWAY_WORKSPACE
                    }
                ]
            }
        }),
        async (calls) => {
            const r = await builder.resolveRoots(narraNexusAgent())
            assert.ok(
                calls[0]?.includes(
                    '/manyfold/agents/agent-1/files/roots'
                ),
                `expected a files/roots call, got ${calls[0]}`
            )
            return r
        }
    )
    assert.equal(roots[0].path, NN_GATEWAY_WORKSPACE)
    assert.notEqual(
        roots[0].path,
        NN_SPRITE_WORKSPACE,
        'the stored value must lose to the gateway, or the stale layout survives forever'
    )
    // The sprite-side roots are Manyfold's own knowledge of the image and stay
    // put; every root stays read-only so the file controllers remain shut.
    assert.deepEqual(
        roots.map((r) => [r.id, r.writable]),
        [
            ['workspace', false],
            ['narranexus-home', false],
            ['home', false]
        ]
    )
    // agent.workspacePath is what diagnostics measures storage against, so the
    // row has to converge too, not just the in-memory roots.
    assert.equal(updates.length, 1)
    assert.equal(updates[0].workspacePath, NN_GATEWAY_WORKSPACE)
})

test('narranexus roots are cached so a Files session is one gateway lookup', async () => {
    const { builder } = narraNexusBuilder()
    await withRootsResponse(
        () => ({
            ok: true,
            status: 200,
            body: { roots: [{ id: 'workspace', path: NN_GATEWAY_WORKSPACE }] }
        }),
        async (calls) => {
            await builder.resolveRoots(narraNexusAgent())
            await builder.resolveRoots(narraNexusAgent())
            await builder.resolveRoots(narraNexusAgent())
            assert.equal(calls.length, 1)
        }
    )
})

// Degrading to the local guess is what this whole path exists to stop, so an
// unreachable gateway falls back to the last resolved value instead.
test('an unreachable gateway falls back to the last known good path', async () => {
    const { builder, updates } = narraNexusBuilder()
    const roots = await withRootsResponse(
        () => ({ ok: false, status: 503 }),
        () =>
            builder.resolveRoots(
                narraNexusAgent({
                    fileRoots: [
                        {
                            id: 'workspace',
                            label: 'Workspace',
                            path: NN_GATEWAY_WORKSPACE,
                            writable: false
                        }
                    ]
                })
            )
    )
    assert.equal(roots[0].path, NN_GATEWAY_WORKSPACE)
    assert.equal(updates.length, 0, 'a fallback must not be written back')
})

// Silently addressing a guessed path is how the original bug produced 403s that
// read as permission problems; refusing is the honest failure.
test('an unreachable gateway with nothing stored fails loudly', async () => {
    const { builder } = narraNexusBuilder()
    await withRootsResponse(
        () => ({ ok: false, status: 503 }),
        () =>
            assert.rejects(
                builder.resolveRoots(narraNexusAgent({ fileRoots: [] })),
                /workspace layout for agent agent-1 is unknown/
            )
    )
})

// rootId=home is now a real root routed through sprite access; with no sprite
// account wired it fails on the account lookup, proving it took the sprite path
// rather than the gateway
test('narranexus build routes rootId=home through sprite access', async () => {
    await assert.rejects(
        () => filesBuilder().build(narraNexusAgent(), 'home'),
        (err: unknown) =>
            err instanceof NotFoundException &&
            err.message === 'sprites account spa-1 not found'
    )
})

test('narranexus build still rejects an unknown rootId', async () => {
    await assert.rejects(
        () => filesBuilder().build(narraNexusAgent(), 'bogus'),
        (err: unknown) =>
            err instanceof NotFoundException &&
            err.message === 'unknown file root: bogus'
    )
})

test('narranexus build accepts rootId=workspace', async () => {
    await assert.rejects(
        () => filesBuilder().build(narraNexusAgent(), 'workspace'),
        (err: unknown) =>
            err instanceof NotFoundException &&
            err.message ===
                'narranexus runtime for agent agent-1 missing ingress host'
    )
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
            db as never,
            {} as never
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

test('narranexus context infers image MIME for generic stat and read responses', async () => {
    const { builder } = narraNexusBuilder()
    const body = Buffer.from([0x89, 0x50, 0x4e, 0x47])
    const calls: string[] = []
    const originalFetch = globalThis.fetch
    globalThis.fetch = (async (url: string) => {
        calls.push(url)
        if (url.includes('/files/roots'))
            return new Response(
                JSON.stringify({
                    roots: [{ id: 'workspace', path: NN_GATEWAY_WORKSPACE }]
                })
            )
        if (url.includes('/files/stat'))
            return new Response(
                JSON.stringify({
                    entry: {
                        name: 'logo.png',
                        type: 'file',
                        size: body.byteLength,
                        mtime: 1,
                        mode: '644'
                    }
                })
            )
        if (url.includes('/files/read'))
            return new Response(body, {
                headers: {
                    'content-length': String(body.byteLength),
                    'content-type': 'application/octet-stream'
                }
            })
        throw new Error(`unexpected fetch: ${url}`)
    }) as never

    try {
        const ctx = await builder.build(narraNexusAgent(), 'workspace')
        const path = `${NN_GATEWAY_WORKSPACE}/logo.png`
        const stat = await ctx.stat(path)
        const read = await ctx.read(path)

        assert.equal(stat?.contentType, 'image/png')
        assert.ok(read)
        assert.equal(read.contentType, 'image/png')
        assert.equal(read.size, body.byteLength)
        assert.deepEqual(await drain(read.stream), body)
        assert.equal(
            calls.filter((url) => url.includes('/files/stat')).length,
            1
        )
        assert.equal(
            calls.filter((url) => url.includes('/files/read')).length,
            1
        )
    } finally {
        globalThis.fetch = originalFetch
    }
})

// capabilities must be resolved per request: the same runtime reports different
// binarySafe values depending on the host CLI version behind it
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
