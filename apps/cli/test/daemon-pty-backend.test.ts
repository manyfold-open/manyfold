import test from 'node:test'
import assert from 'node:assert/strict'
import type * as PtyTypes from 'node-pty'
import {
    createBunPtyBackend,
    encodePtyChunk,
    getBunPty,
    ptyUnavailableMessage,
    resolvePtyBackend
} from '../src/daemon/pty-backend'

interface FakeBunCalls {
    cmd: string[] | null
    spawnOpts: {
        cwd: string
        env: Record<string, string>
        terminal: {
            cols: number
            rows: number
            data(term: unknown, chunk: Uint8Array): void
        }
    } | null
    writes: string[]
    resizes: Array<[number, number]>
    kills: Array<string | undefined>
    closes: number
}

const makeFakeBun = (): {
    bun: Parameters<typeof createBunPtyBackend>[0] & { Terminal: unknown }
    calls: FakeBunCalls
    exit(code: number | undefined): void
} => {
    const calls: FakeBunCalls = {
        cmd: null,
        spawnOpts: null,
        writes: [],
        resizes: [],
        kills: [],
        closes: 0
    }
    let resolveExit: (code: number | undefined) => void = () => {}
    const exited = new Promise<number | undefined>((resolveCode) => {
        resolveExit = resolveCode
    })
    const terminal = {
        write: (data: string): void => {
            calls.writes.push(data)
        },
        resize: (cols: number, rows: number): void => {
            calls.resizes.push([cols, rows])
        },
        close: (): void => {
            calls.closes += 1
        }
    }
    const bun = {
        Terminal: function Terminal() {},
        spawn: (cmd: string[], opts: typeof calls.spawnOpts) => {
            calls.cmd = cmd
            calls.spawnOpts = opts
            return {
                exited,
                terminal,
                kill: (signal?: string): void => {
                    calls.kills.push(signal)
                }
            }
        }
    }
    return { bun: bun as never, calls, exit: (code) => resolveExit(code) }
}

const fakeNodePty = { spawn: () => null } as unknown as typeof PtyTypes

test('resolvePtyBackend prefers bun terminal when available', async () => {
    const { bun } = makeFakeBun()
    const backend = await resolvePtyBackend({ bun, platform: 'darwin' })
    assert.equal(backend.name, 'bun')
})

test('resolvePtyBackend skips bun on win32', async () => {
    const { bun } = makeFakeBun()
    const backend = await resolvePtyBackend({
        bun,
        platform: 'win32',
        loadNodePty: async () => fakeNodePty
    })
    assert.equal(backend.name, 'node-pty')
})

test('resolvePtyBackend uses node-pty without a bun global', async () => {
    const backend = await resolvePtyBackend({
        platform: 'linux',
        loadNodePty: async () => fakeNodePty
    })
    assert.equal(backend.name, 'node-pty')
})

test('getBunPty rejects bun without Terminal support', () => {
    assert.equal(getBunPty({ spawn: () => null }, 'darwin'), null)
})

test('old standalone binary message suggests mf update', async () => {
    await assert.rejects(
        resolvePtyBackend({
            bun: { spawn: () => null },
            platform: 'darwin',
            loadNodePty: async () => {
                throw new Error('cannot find module')
            }
        }),
        (err: Error) => {
            assert.match(err.message, /mf update/)
            assert.doesNotMatch(err.message, /@manyfold\/cli/)
            return true
        }
    )
})

test('windows standalone message explains pipe mode', () => {
    const msg = ptyUnavailableMessage('no native module', {}, 'win32')
    assert.match(msg, /Windows/)
    assert.match(msg, /limited pipe mode/)
    assert.doesNotMatch(msg, /@manyfold\/cli/)
})

test('node runtime message keeps node-pty install hint', () => {
    const msg = ptyUnavailableMessage('not installed', undefined, 'linux')
    assert.match(msg, /npm i -g node-pty/)
    assert.doesNotMatch(msg, /@manyfold\/cli/)
})

test('bun backend spawns shell with terminal dimensions', () => {
    const { bun, calls } = makeFakeBun()
    createBunPtyBackend(bun).spawn({
        shell: '/bin/zsh',
        args: ['-il'],
        cwd: '/tmp',
        env: {},
        cols: 120,
        rows: 40,
        onData: () => {}
    })
    assert.deepEqual(calls.cmd, ['/bin/zsh', '-il'])
    assert.equal(calls.spawnOpts?.cwd, '/tmp')
    assert.equal(calls.spawnOpts?.terminal.cols, 120)
    assert.equal(calls.spawnOpts?.terminal.rows, 40)
})

test('bun backend defaults TERM and preserves an explicit one', () => {
    const { bun, calls } = makeFakeBun()
    const backend = createBunPtyBackend(bun)
    const spawnOpts = {
        shell: '/bin/sh',
        args: [],
        cwd: '/',
        cols: 80,
        rows: 24,
        onData: () => {}
    }
    backend.spawn({ ...spawnOpts, env: {} })
    assert.equal(calls.spawnOpts?.env.TERM, 'xterm-256color')
    backend.spawn({ ...spawnOpts, env: { TERM: 'vt100' } })
    assert.equal(calls.spawnOpts?.env.TERM, 'vt100')
})

test('bun backend forwards terminal data to onData', () => {
    const { bun, calls } = makeFakeBun()
    const chunks: Array<string | Uint8Array> = []
    createBunPtyBackend(bun).spawn({
        shell: '/bin/sh',
        args: [],
        cwd: '/',
        env: {},
        cols: 80,
        rows: 24,
        onData: (chunk) => {
            chunks.push(chunk)
        }
    })
    const payload = new Uint8Array([104, 105])
    calls.spawnOpts?.terminal.data(null, payload)
    assert.deepEqual(chunks, [payload])
})

test('bun backend delegates write/resize and closes terminal once on exit', async () => {
    const { bun, calls, exit } = makeFakeBun()
    const proc = createBunPtyBackend(bun).spawn({
        shell: '/bin/sh',
        args: [],
        cwd: '/',
        env: {},
        cols: 80,
        rows: 24,
        onData: () => {}
    })
    proc.write('ls\n')
    proc.resize(100, 30)
    assert.deepEqual(calls.writes, ['ls\n'])
    assert.deepEqual(calls.resizes, [[100, 30]])
    exit(3)
    assert.equal(await proc.exited, 3)
    assert.equal(calls.closes, 1)
})

test('bun backend kill closes terminal exactly once across exit', async () => {
    const { bun, calls, exit } = makeFakeBun()
    const proc = createBunPtyBackend(bun).spawn({
        shell: '/bin/sh',
        args: [],
        cwd: '/',
        env: {},
        cols: 80,
        rows: 24,
        onData: () => {}
    })
    proc.kill('SIGTERM')
    assert.deepEqual(calls.kills, ['SIGTERM'])
    assert.equal(calls.closes, 1)
    exit(undefined)
    assert.equal(await proc.exited, 0)
    assert.equal(calls.closes, 1)
})

test('encodePtyChunk keeps raw bytes for partial multibyte output', () => {
    assert.equal(
        encodePtyChunk(new Uint8Array([0xe4, 0xbd])),
        Buffer.from([0xe4, 0xbd]).toString('base64')
    )
    assert.equal(
        encodePtyChunk('你好'),
        Buffer.from('你好', 'utf8').toString('base64')
    )
})
