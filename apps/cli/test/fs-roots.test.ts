import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import {
    mkdir,
    mkdtemp,
    readFile,
    realpath,
    symlink,
    writeFile
} from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
    DAEMON_CLIENT_FEATURES,
    DAEMON_FEATURE_FS_ROOTS
} from '@manyfold/shared'
import { rpcHandler, setDeclaredWorkspaceRoot } from '../src/daemon/rpc'
import { resolvePtyBackend } from '../src/daemon/pty-backend'
import type { RpcContext } from '../src/daemon/ws-client'

// DAEMON_FEATURE_FS_ROOTS: fs.*, pty.open and terminal.herdr.open carry the
// directories the platform vouches for, like exec.start. The machine is laid
// out the way a hosted one is: the daemon's config dir, with its managed
// workspaces inside, lives in the home the platform vouches for.

const ctx = (
    refId: string,
    events: Array<[string, string]> = []
): RpcContext => ({
    refId,
    sendEvent: (kind, data) => {
        events.push([kind, data])
    },
    onCancel: () => {}
})

interface Machine {
    home: string
    config: string
    project: string
    token: string
}

const withMachine = async (
    fn: (m: Machine) => Promise<void>
): Promise<void> => {
    const home = await realpath(await mkdtemp(join(tmpdir(), 'mf-fs-roots-')))
    const priorConfigDir = process.env.MF_CONFIG_DIR
    const priorProfile = process.env.MF_PROFILE
    const config = join(home, '.manyfold')
    process.env.MF_CONFIG_DIR = config
    delete process.env.MF_PROFILE
    const project = join(home, 'project')
    const token = join(config, 'profiles', 'spriterunner', 'config.json')
    await mkdir(project, { recursive: true })
    await mkdir(join(config, 'workspaces'), { recursive: true })
    await mkdir(join(config, 'profiles', 'spriterunner'), { recursive: true })
    await writeFile(token, 'daemon-config-fixture')
    await writeFile(join(project, 'notes.md'), 'hello')
    setDeclaredWorkspaceRoot(null)
    try {
        await fn({ home, config, project, token })
    } finally {
        setDeclaredWorkspaceRoot(null)
        if (priorConfigDir === undefined) delete process.env.MF_CONFIG_DIR
        else process.env.MF_CONFIG_DIR = priorConfigDir
        if (priorProfile !== undefined) process.env.MF_PROFILE = priorProfile
    }
}

const read = (path: string, roots?: string[]) =>
    rpcHandler(
        'fs.read',
        { path, chunked: false, ...(roots ? { roots } : {}) },
        ctx('ref-read')
    )

test('the daemon advertises fs.roots.v1', () => {
    assert.ok(DAEMON_CLIENT_FEATURES.includes(DAEMON_FEATURE_FS_ROOTS))
})

test('a file under a vouched root is admitted for that call only', async () => {
    await withMachine(async ({ project }) => {
        const file = join(project, 'notes.md')
        const ack = await read(file, [project])
        assert.equal(ack.ok, true, ack.error)
        assert.equal(ack.payload?.content, 'hello')
        await assert.rejects(read(file), /outside allowed roots/)
    })
})

test('every fs call takes the roots', async () => {
    await withMachine(async ({ project }) => {
        const roots = [project]
        const call = (
            method:
                | 'fs.write'
                | 'fs.stat'
                | 'fs.list'
                | 'fs.mkdir'
                | 'fs.mv'
                | 'fs.rm',
            payload: Record<string, unknown>
        ) => rpcHandler(method, { ...payload, roots }, ctx(`ref-${method}`))
        const file = join(project, 'new.txt')
        const sub = join(project, 'sub')
        assert.equal(
            (await call('fs.write', { path: file, content: 'x' })).ok,
            true
        )
        assert.equal((await call('fs.stat', { path: file })).payload?.size, 1)
        const listed = await call('fs.list', { path: project })
        assert.ok(
            (listed.payload?.entries as Array<{ name: string }>).some(
                (e) => e.name === 'new.txt'
            )
        )
        assert.equal((await call('fs.mkdir', { path: sub })).ok, true)
        assert.equal(
            (await call('fs.mv', { from: file, to: join(sub, 'new.txt') })).ok,
            true
        )
        assert.equal(await readFile(join(sub, 'new.txt'), 'utf8'), 'x')
        assert.equal(
            (await call('fs.rm', { path: sub, recursive: true })).ok,
            true
        )
        for (const method of [
            'fs.stat',
            'fs.list',
            'fs.mkdir',
            'fs.rm'
        ] as const)
            await assert.rejects(
                rpcHandler(
                    method,
                    { path: project },
                    ctx(`ref-bare-${method}`)
                ),
                /outside allowed roots/,
                method
            )
    })
})

test("a vouched home does not reach into the daemon's config dir", async () => {
    await withMachine(async ({ home, config, token }) => {
        await assert.rejects(
            read(token, [home]),
            /inside the daemon's config dir/
        )
        await assert.rejects(
            rpcHandler(
                'fs.list',
                { path: config, roots: [home] },
                ctx('ref-list-config')
            ),
            /inside the daemon's config dir/
        )
        await assert.rejects(
            rpcHandler(
                'fs.write',
                { path: token, content: 'replaced', roots: [home] },
                ctx('ref-write-config')
            ),
            /inside the daemon's config dir/
        )
        assert.equal(await readFile(token, 'utf8'), 'daemon-config-fixture')
    })
})

// ADR-0013's threat model: a link planted where the agent works.
test('a link under a vouched root that resolves into the config dir is refused', async () => {
    await withMachine(async ({ home, project, token }) => {
        const link = join(project, 'token-link')
        await symlink(token, link)
        await assert.rejects(
            read(link, [home]),
            /inside the daemon's config dir/
        )
    })
})

test('the workspaces and runtime auth the daemon keeps in its config dir stay admitted', async () => {
    await withMachine(async ({ home, config }) => {
        const workspaceFile = join(config, 'workspaces', 'wks_1', 'AGENTS.md')
        const authFile = join(config, 'runtime-auth', 'profile.json')
        for (const roots of [undefined, [home]]) {
            for (const path of [workspaceFile, authFile]) {
                const ack = await rpcHandler(
                    'fs.write',
                    { path, content: 'kept', ...(roots ? { roots } : {}) },
                    ctx('ref-own')
                )
                assert.equal(ack.ok, true, ack.error)
            }
        }
    })
})

test('a registered workspace that holds the config dir does not reach into it either', async () => {
    await withMachine(async ({ home, project, token }) => {
        const registered = await rpcHandler(
            'workspace.ensure',
            { path: home, create: false },
            ctx('ref-register-home')
        )
        assert.equal(registered.ok, true, registered.error)
        try {
            assert.equal((await read(join(project, 'notes.md'))).ok, true)
            await assert.rejects(read(token), /inside the daemon's config dir/)
        } finally {
            await rpcHandler(
                'workspace.delete',
                { path: home, remove: false },
                ctx('ref-unregister-home')
            )
        }
    })
})

test('fs roots must be absolute paths', async () => {
    await withMachine(async ({ project }) => {
        await assert.rejects(
            read(join(project, 'notes.md'), ['project']),
            /roots must be absolute paths/
        )
    })
})

test("pty.open refuses a cwd in the daemon's config dir under a vouched home", async () => {
    await withMachine(async ({ home, config }) => {
        const ack = await rpcHandler(
            'pty.open',
            {
                cwd: join(config, 'profiles'),
                roots: [home],
                cols: 80,
                rows: 24
            },
            ctx('ref-pty-config')
        )
        assert.equal(ack.ok, false)
        assert.match(String(ack.error), /inside the daemon's config dir/)
    })
})

const ptyAvailable = await resolvePtyBackend().then(
    () => true,
    () => false
)

test(
    'pty.open starts in a cwd admitted by its roots',
    { skip: !ptyAvailable && 'no pty backend on this machine' },
    async () => {
        await withMachine(async ({ project }) => {
            const priorShell = process.env.SHELL
            process.env.SHELL = '/bin/sh'
            const events: Array<[string, string]> = []
            let cancel = (): void => {}
            const out = (): string =>
                events
                    .filter(([kind]) => kind === 'pty.out')
                    .map(([, data]) =>
                        Buffer.from(data, 'base64').toString('utf8')
                    )
                    .join('')
            try {
                // The command runs, then the pty drops into a login shell:
                // it lives until its stream is cancelled.
                const opened = rpcHandler(
                    'pty.open',
                    {
                        cwd: project,
                        roots: [project],
                        command: ['/bin/pwd'],
                        cols: 80,
                        rows: 24
                    },
                    {
                        ...ctx('ref-pty-roots', events),
                        onCancel: (handler) => {
                            cancel = handler
                        }
                    }
                )
                const deadline = Date.now() + 8_000
                while (!out().includes(project) && Date.now() < deadline)
                    await new Promise((resolve) => setTimeout(resolve, 25))
                cancel()
                const ack = await opened
                assert.equal(ack.ok, true, ack.error)
                assert.ok(
                    out().includes(project),
                    'pwd reports the vouched cwd'
                )
            } finally {
                if (priorShell === undefined) delete process.env.SHELL
                else process.env.SHELL = priorShell
            }
        })
    }
)
