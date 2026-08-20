import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import {
    daemonActivitySnapshot,
    rpcHandler,
    setDeclaredWorkspaceRoot
} from '../src/daemon/rpc'
import { daemonPaths } from '../src/daemon/config'
import type { RpcContext } from '../src/daemon/ws-client'

// Handler-level coverage for the #781 CLI release: fs.write honours `mode`
// (DAEMON_FEATURE_FS_WRITE_MODE) and exec.start no longer persists its env
// into the local exec-buffer meta.json. Everything runs against a throwaway
// MF_CONFIG_DIR + declared workspace root so no real profile or home file is
// touched.

const ctx = (refId: string): RpcContext => ({
    refId,
    sendEvent: () => {},
    onCancel: () => {}
})

const withSandbox = async (
    fn: (root: string) => Promise<void>
): Promise<void> => {
    const base = await mkdtemp(join(tmpdir(), 'mf-rpc-handlers-'))
    const priorConfigDir = process.env.MF_CONFIG_DIR
    const priorProfile = process.env.MF_PROFILE
    process.env.MF_CONFIG_DIR = join(base, 'config')
    delete process.env.MF_PROFILE
    const root = join(base, 'workspaces')
    setDeclaredWorkspaceRoot(root)
    try {
        await fn(root)
    } finally {
        setDeclaredWorkspaceRoot(null)
        if (priorConfigDir === undefined) delete process.env.MF_CONFIG_DIR
        else process.env.MF_CONFIG_DIR = priorConfigDir
        if (priorProfile !== undefined) process.env.MF_PROFILE = priorProfile
    }
}

const waitFor = async (
    predicate: () => boolean,
    label: string
): Promise<void> => {
    const deadline = Date.now() + 1_000
    while (!predicate() && Date.now() < deadline)
        await new Promise((resolve) => setTimeout(resolve, 5))
    assert.ok(predicate(), label)
}

test('fs.write applies an octal mode and corrects a looser existing file', async () => {
    await withSandbox(async (root) => {
        const target = join(root, 'agent-1', 'settings.json')
        const first = await rpcHandler(
            'fs.write',
            { path: target, content: '{}', mode: '600' },
            ctx('ref-mode-1')
        )
        assert.equal(first.ok, true)
        assert.equal((await stat(target)).mode & 0o777, 0o600)

        await writeFile(target, '{}', { mode: 0o644 })
        const again = await rpcHandler(
            'fs.write',
            { path: target, content: '{"a":1}', mode: '600' },
            ctx('ref-mode-2')
        )
        assert.equal(again.ok, true)
        assert.equal((await stat(target)).mode & 0o777, 0o600)
        assert.equal(await readFile(target, 'utf8'), '{"a":1}')
    })
})

test('fs.write without a valid mode keeps the default permissions', async () => {
    await withSandbox(async (root) => {
        const plain = join(root, 'agent-1', 'plain.json')
        await rpcHandler(
            'fs.write',
            { path: plain, content: '{}' },
            ctx('ref-plain')
        )
        const defaultMode = (await stat(plain)).mode & 0o777

        const garbled = join(root, 'agent-1', 'garbled.json')
        await rpcHandler(
            'fs.write',
            { path: garbled, content: '{}', mode: 'rw-r--r--' },
            ctx('ref-garbled')
        )
        assert.equal((await stat(garbled)).mode & 0o777, defaultMode)
    })
})

test('exec.start keeps env out of the exec-buffer meta.json (#781)', async () => {
    await withSandbox(async () => {
        const refId = 'ref-meta-env'
        const ack = await rpcHandler(
            'exec.start',
            {
                cmd: ['/bin/echo', 'hello'],
                env: { SECRET_TOKEN: 'gho_do_not_persist' }
            },
            ctx(refId)
        )
        assert.equal(ack.ok, true)
        const metaRaw = await readFile(
            join(daemonPaths.execDir, refId, 'meta.json'),
            'utf8'
        )
        assert.ok(!metaRaw.includes('SECRET_TOKEN'))
        assert.ok(!metaRaw.includes('gho_do_not_persist'))
        const meta = JSON.parse(metaRaw) as {
            payload: Record<string, unknown>
        }
        assert.equal('env' in meta.payload, false)
        assert.deepEqual(meta.payload.cmd, ['/bin/echo', 'hello'])
    })
})

test('cancelling exec.resume stops the original child idempotently', async () => {
    await withSandbox(async () => {
        const originalRefId = 'ref-resume-original'
        const startResult = rpcHandler(
            'exec.start',
            {
                cmd: [process.execPath, '-e', 'setInterval(() => {}, 1000)']
            },
            ctx(originalRefId)
        )
        let resumeResult: ReturnType<typeof rpcHandler> | null = null
        let cancelResume: (() => void) | null = null
        try {
            await waitFor(
                () => daemonActivitySnapshot().activeExecs === 1,
                'expected the original child to be running'
            )
            resumeResult = rpcHandler(
                'exec.resume',
                { originalRefId, fromSeq: 0 },
                {
                    ...ctx('ref-resume-attach'),
                    onCancel: (handler) => {
                        cancelResume = handler
                    }
                }
            )
            const cancel = cancelResume as (() => void) | null
            assert.ok(cancel)
            cancel()

            const aborted = await rpcHandler(
                'exec.abort',
                { refId: originalRefId },
                ctx('ref-resume-abort')
            )

            assert.deepEqual(aborted, { ok: true })
            assert.deepEqual(await startResult, {
                ok: false,
                payload: { exitCode: 0 },
                error: 'cancelled'
            })
            assert.deepEqual(await resumeResult, {
                ok: false,
                error: 'cancelled'
            })
            assert.equal(daemonActivitySnapshot().activeExecs, 0)
        } finally {
            await rpcHandler(
                'exec.abort',
                { refId: originalRefId },
                ctx('ref-resume-cleanup')
            )
            await startResult.catch(() => undefined)
            await resumeResult?.catch(() => undefined)
        }
    })
})
