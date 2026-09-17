import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import { randomUUID, createHash } from 'node:crypto'
import { once } from 'node:events'
import {
    mkdtemp,
    mkdir,
    readFile,
    rm,
    stat,
    symlink,
    writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import test, { type TestContext } from 'node:test'

const sha = (text: string) => createHash('sha256').update(text).digest('hex')
const until = async (condition: () => boolean) => {
    const end = Date.now() + 5000
    while (!condition()) {
        if (Date.now() >= end)
            throw new Error('config commit fixture timed out')
        await new Promise((resolve) => setTimeout(resolve, 5))
    }
}

const fixture = async (t: TestContext) => {
    const root = await mkdtemp(path.join(tmpdir(), 'mf-config-commit-'))
    const home = path.join(root, 'home')
    const workspace = path.join(home, 'workspace')
    await mkdir(workspace, { recursive: true })
    const children: ChildProcess[] = []
    const terminals: Promise<unknown>[] = []
    const peer = async () => {
        const loaders = process.versions.bun
            ? []
            : ['--import', 'tsx', '--import', './test/md-text-loader.mjs']
        const child = spawn(
            process.execPath,
            [...loaders, 'test/fixtures/config-delivery-peer.mjs'],
            {
                cwd: path.resolve(import.meta.dirname, '..'),
                env: {
                    PATH: process.env.PATH,
                    HOME: home,
                    TMPDIR: root,
                    MF_CONFIG_DIR: path.join(root, 'profile'),
                    FIXTURE_WORKSPACE: workspace,
                    TSX_TSCONFIG_PATH: path.resolve(
                        import.meta.dirname,
                        '../tsconfig.json'
                    )
                },
                stdio: ['ignore', 'pipe', 'pipe', 'ipc']
            }
        )
        const events: Array<{
            type: string
            id?: string
            result?: {
                ok: boolean
                error?: string
                payload?: { status: string }
            }
        }> = []
        let output = ''
        assert(child.stdout && child.stderr)
        child.stdout.on('data', (data) => {
            output += data
        })
        child.stderr.on('data', (data) => {
            output += data
        })
        child.on('message', (message) =>
            events.push(message as (typeof events)[number])
        )
        const terminal = once(child, 'close')
        children.push(child)
        terminals.push(terminal)
        await until(
            () =>
                events.some((event) => event.type === 'ready') ||
                child.exitCode !== null
        )
        assert.equal(child.exitCode, null, output)
        const request = (payload: Record<string, unknown>) => {
            const id = randomUUID()
            child.send({ type: 'rpc-request', id, method: 'fs.write', payload })
            const result = (async () => {
                await until(() => events.some((event) => event.id === id))
                return events.find((event) => event.id === id)!.result!
            })()
            return { id, result }
        }
        const entry = { child, events, terminal, request }
        return entry
    }
    t.after(async () => {
        for (const child of children)
            if (child.connected) child.send?.({ type: 'stop' })
        const kill = setTimeout(() => {
            for (const child of children) child.kill('SIGKILL')
        }, 3000)
        await Promise.all(terminals)
        clearTimeout(kill)
        await rm(root, { recursive: true, force: true })
    })
    const target = path.join(workspace, '.mcp.json')
    const payload = (
        generation: string,
        content: string,
        previous: string | null = null
    ) => ({
        path: target,
        content,
        mode: '600',
        configCommit: {
            generation,
            revision: sha(content),
            expectedSha256: previous === null ? null : sha(previous)
        }
    })
    return { root, home, workspace, target, payload, peer }
}

test(
    'protected config commits fence a blocked old write across processes and survive restart/replay',
    { timeout: 20_000 },
    async (t) => {
        const h = await fixture(t)
        const a = await h.peer()
        const b = await h.peer()
        a.child.send({ type: 'hold-write' })
        await until(() =>
            a.events.some((event) => event.type === 'holding-enabled')
        )
        const old = a.request(h.payload('9007199254740993', 'old'))
        await until(() => a.events.some((event) => event.type === 'write-held'))
        const fresh = await b.request(h.payload('9007199254740994', 'new'))
            .result
        assert.equal(fresh.ok, true, fresh.error)
        a.child.send({ type: 'release-write' })
        assert.equal((await old.result).error, 'config_commit_superseded')
        assert.equal(await readFile(h.target, 'utf8'), 'new')
        if (process.platform !== 'win32')
            assert.equal((await stat(h.target)).mode & 0o777, 0o600)
        b.child.kill('SIGKILL')
        await b.terminal
        const restarted = await h.peer()
        assert.equal(
            (
                await restarted.request(h.payload('9007199254740994', 'new'))
                    .result
            ).payload?.status,
            'unchanged'
        )
        assert.equal(
            (
                await restarted.request(h.payload('9007199254740993', 'old'))
                    .result
            ).error,
            'config_commit_superseded'
        )
        assert.equal(
            (
                await restarted.request(
                    h.payload('9007199254740994', 'different')
                ).result
            ).error,
            'config_commit_generation_conflict'
        )
    }
)

test(
    'admitted-but-uncommitted generation retries, cancellation and manual edits remain loud',
    { timeout: 20_000 },
    async (t) => {
        const h = await fixture(t)
        const a = await h.peer()
        a.child.send({ type: 'hold-write' })
        await until(() =>
            a.events.some((event) => event.type === 'holding-enabled')
        )
        const pending = a.request(h.payload('12', 'desired'))
        await until(() => a.events.some((event) => event.type === 'write-held'))
        a.child.send({ type: 'cancel-request', id: pending.id })
        a.child.send({ type: 'release-write' })
        assert.equal((await pending.result).error, 'config_commit_cancelled')
        await assert.rejects(readFile(h.target), { code: 'ENOENT' })
        const retry = await a.request(h.payload('12', 'desired')).result
        assert.equal(retry.ok, true, retry.error)
        await writeFile(h.target, 'manual')
        assert.equal(
            (await a.request(h.payload('13', 'new', 'desired')).result).error,
            'config_commit_content_changed'
        )
        assert.equal(await readFile(h.target, 'utf8'), 'manual')
        assert.equal(
            (await a.request(h.payload('13', 'new', 'manual')).result).ok,
            true
        )
    }
)

test(
    'missing differs from empty; malformed generation and symlinked metadata never write',
    { timeout: 20_000 },
    async (t) => {
        const h = await fixture(t)
        const a = await h.peer()
        await writeFile(h.target, '')
        assert.equal(
            (await a.request(h.payload('20', 'nonempty')).result).error,
            'config_commit_content_changed'
        )
        assert.equal(
            (await a.request(h.payload('20', 'nonempty', '')).result).ok,
            true
        )
        assert.equal(
            (await a.request(h.payload('020', 'other')).result).error,
            'config_commit_invalid'
        )
        const outside = path.join(h.root, 'outside')
        await mkdir(outside)
        const own = path.join(h.workspace, 'new-dir')
        await mkdir(own)
        await symlink(
            outside,
            path.join(own, '.manyfold-config-delivery'),
            process.platform === 'win32' ? 'junction' : 'dir'
        )
        assert.equal(
            (
                await a.request({
                    ...h.payload('21', 'blocked'),
                    path: path.join(own, 'config.json')
                }).result
            ).error,
            'config_commit_symlink'
        )
        await assert.rejects(readFile(path.join(own, 'config.json')), {
            code: 'ENOENT'
        })
        const ordinary = await a.request({
            path: h.target,
            content: 'ordinary'
        }).result
        assert.equal(ordinary.ok, true)
        assert.equal(await readFile(h.target, 'utf8'), 'ordinary')
    }
)

test(
    'protected target and lock symlinks cannot redirect configuration or lock metadata',
    { timeout: 20_000, skip: process.platform === 'win32' },
    async (t) => {
        const h = await fixture(t)
        const a = await h.peer()
        const outside = path.join(h.root, 'outside-target')
        await writeFile(outside, 'outside-sentinel')
        await symlink(outside, h.target)
        assert.equal(
            (await a.request(h.payload('10', 'blocked')).result).ok,
            false
        )
        assert.equal(await readFile(outside, 'utf8'), 'outside-sentinel')
        await rm(h.target)
        assert.equal(
            (await a.request(h.payload('11', 'owned')).result).ok,
            true
        )
        const stateDir = path.join(
            h.workspace,
            '.manyfold-config-delivery',
            sha('.mcp.json')
        )
        assert.equal(
            (await stat(path.join(stateDir, 'state.json'))).mode & 0o777,
            0o600
        )
        assert.equal((await stat(stateDir)).mode & 0o777, 0o700)
        await rm(path.join(stateDir, 'lock'))
        await symlink(outside, path.join(stateDir, 'lock'))
        assert.equal(
            (await a.request(h.payload('12', 'blocked', 'owned')).result).error,
            'config_commit_symlink'
        )
        assert.equal(await readFile(outside, 'utf8'), 'outside-sentinel')
        assert.equal(await readFile(h.target, 'utf8'), 'owned')
    }
)

test(
    'an existing non-object sidecar never resets a committed high-water mark',
    { timeout: 20_000 },
    async (t) => {
        const h = await fixture(t)
        const a = await h.peer()
        assert.equal(
            (await a.request(h.payload('99', 'committed')).result).ok,
            true
        )
        const sidecar = path.join(
            h.workspace,
            '.manyfold-config-delivery',
            sha('.mcp.json'),
            'state.json'
        )
        for (const value of [null, false, 0, '', [], {}]) {
            await writeFile(sidecar, JSON.stringify(value))
            assert.equal(
                (await a.request(h.payload('1', 'old', 'committed')).result)
                    .error,
                'config_commit_state_invalid'
            )
            assert.equal(await readFile(h.target, 'utf8'), 'committed')
        }
    }
)

test(
    'case aliases of a configuration target cannot obtain a second high-water mark',
    { timeout: 20_000 },
    async (t) => {
        const h = await fixture(t)
        const a = await h.peer()
        assert.equal(
            (await a.request(h.payload('99', 'current')).result).ok,
            true
        )
        const alias = path.join(h.workspace, '.MCP.JSON')
        const original = await stat(h.target)
        const aliasStat = await stat(alias).catch(() => null)
        const result = await a.request({
            ...h.payload('1', 'old', 'current'),
            path: alias
        }).result
        t.diagnostic(
            `case alias shares original inode: ${aliasStat?.ino === original.ino}`
        )
        assert.equal(result.error, 'config_commit_superseded')
        assert.equal(await readFile(h.target, 'utf8'), 'current')
    }
)

test(
    'a newer explicit absence fences pending creation and remains idempotent after restart',
    { timeout: 20_000 },
    async (t) => {
        const h = await fixture(t)
        const a = await h.peer()
        const b = await h.peer()
        a.child.send({ type: 'hold-write' })
        await until(() =>
            a.events.some((event) => event.type === 'holding-enabled')
        )
        const old = a.request(h.payload('30', 'old'))
        await until(() => a.events.some((event) => event.type === 'write-held'))
        const absent = { ...h.payload('40', 'absent'), content: null }
        assert.equal(
            (await b.request(absent).result).payload?.status,
            'unchanged'
        )
        a.child.send({ type: 'release-write' })
        assert.equal((await old.result).error, 'config_commit_superseded')
        await assert.rejects(readFile(h.target), { code: 'ENOENT' })
        b.child.kill('SIGKILL')
        await b.terminal
        const restarted = await h.peer()
        assert.equal(
            (await restarted.request(absent).result).payload?.status,
            'unchanged'
        )
        const missing = { ...h.payload('50', 'other') } as Record<
            string,
            unknown
        >
        delete missing.content
        assert.equal(
            (await restarted.request(missing).result).error,
            'config_commit_invalid'
        )
        assert.equal(
            (
                await restarted.request({
                    ...h.payload('50', 'other', ''),
                    content: null
                }).result
            ).error,
            'config_commit_invalid'
        )
        await writeFile(h.target, '')
        assert.equal(
            (await restarted.request(absent).result).error,
            'config_commit_content_changed'
        )
        assert.equal(await readFile(h.target, 'utf8'), '')
    }
)

for (const stage of ['admitted', 'committed'] as const)
    test(
        `process death after ${stage} before reply can retry the same generation`,
        { timeout: 20_000 },
        async (t) => {
            const h = await fixture(t)
            const a = await h.peer()
            a.child.send({
                type: stage === 'admitted' ? 'hold-write' : 'hold-reply'
            })
            await until(() =>
                a.events.some(
                    (event) =>
                        event.type ===
                        (stage === 'admitted'
                            ? 'holding-enabled'
                            : 'reply-holding-enabled')
                )
            )
            const pending = a.request(h.payload('80', 'recoverable'))
            const abandoned = pending.result.catch(() => undefined)
            await until(() =>
                a.events.some(
                    (event) =>
                        event.type ===
                        (stage === 'admitted' ? 'write-held' : 'reply-held')
                )
            )
            a.child.kill('SIGKILL')
            await a.terminal
            const b = await h.peer()
            const retry = await b.request(h.payload('80', 'recoverable')).result
            assert.equal(retry.ok, true, retry.error)
            assert.equal(
                retry.payload?.status,
                stage === 'admitted' ? 'delivered' : 'unchanged'
            )
            assert.equal(await readFile(h.target, 'utf8'), 'recoverable')
            await abandoned
        }
    )
