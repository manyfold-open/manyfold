import test from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { mkdtemp, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { DAEMON_CLIENT_FEATURES, DAEMON_FEATURE_EXEC_ROOTS } from '@manyfold/shared'
import { rpcHandler, setDeclaredWorkspaceRoot } from '../src/daemon/rpc'
import type { RpcContext } from '../src/daemon/ws-client'

// DAEMON_FEATURE_EXEC_ROOTS: exec.start carries the directories the platform
// vouches for, admitted for that exec's cwd only. Everything runs against a
// throwaway MF_CONFIG_DIR + declared workspace root; the cwd under test lives
// OUTSIDE that root, where only a declared root can admit it.

const ctx = (refId: string): RpcContext => ({
    refId,
    sendEvent: () => {},
    onCancel: () => {}
})

const withSandbox = async (
    fn: (dirs: { root: string; outside: string }) => Promise<void>
): Promise<void> => {
    const base = await mkdtemp(join(tmpdir(), 'mf-exec-roots-'))
    const priorConfigDir = process.env.MF_CONFIG_DIR
    const priorProfile = process.env.MF_PROFILE
    process.env.MF_CONFIG_DIR = join(base, 'config')
    delete process.env.MF_PROFILE
    const root = join(base, 'workspaces')
    const outside = join(base, 'elsewhere', 'project')
    await mkdir(root, { recursive: true })
    await mkdir(outside, { recursive: true })
    setDeclaredWorkspaceRoot(root)
    try {
        await fn({ root, outside })
    } finally {
        setDeclaredWorkspaceRoot(null)
        if (priorConfigDir === undefined) delete process.env.MF_CONFIG_DIR
        else process.env.MF_CONFIG_DIR = priorConfigDir
        if (priorProfile !== undefined) process.env.MF_PROFILE = priorProfile
    }
}

test('the daemon advertises exec.roots.v1', () => {
    assert.ok(DAEMON_CLIENT_FEATURES.includes(DAEMON_FEATURE_EXEC_ROOTS))
})

test('a cwd under a declared root is admitted for that exec', async () => {
    await withSandbox(async ({ outside }) => {
        const ack = await rpcHandler(
            'exec.start',
            { cmd: ['/bin/pwd'], dir: outside, roots: [outside] },
            ctx('ref-roots-admitted')
        )
        assert.equal(ack.ok, true, ack.error)
    })
})

test('a cwd outside every root is still refused, declared roots or not', async () => {
    await withSandbox(async ({ outside, root }) => {
        const bare = await rpcHandler(
            'exec.start',
            { cmd: ['/bin/pwd'], dir: outside },
            ctx('ref-roots-refused-bare')
        )
        assert.equal(bare.ok, false)
        assert.match(String(bare.error), /outside allowed roots/)
        const elsewhere = await rpcHandler(
            'exec.start',
            { cmd: ['/bin/pwd'], dir: outside, roots: [join(root, 'other')] },
            ctx('ref-roots-refused-other')
        )
        assert.equal(elsewhere.ok, false)
        assert.match(String(elsewhere.error), /outside allowed roots/)
    })
})

test('declared roots must be absolute paths', async () => {
    await withSandbox(async ({ outside }) => {
        const ack = await rpcHandler(
            'exec.start',
            { cmd: ['/bin/pwd'], dir: outside, roots: ['elsewhere/project'] },
            ctx('ref-roots-relative')
        )
        assert.equal(ack.ok, false)
        assert.match(String(ack.error), /roots must be absolute paths/)
    })
})

test('declared roots admit only this exec: the next one without them is refused', async () => {
    await withSandbox(async ({ outside }) => {
        const first = await rpcHandler(
            'exec.start',
            { cmd: ['/bin/pwd'], dir: outside, roots: [outside] },
            ctx('ref-roots-once-a')
        )
        assert.equal(first.ok, true, first.error)
        const second = await rpcHandler(
            'exec.start',
            { cmd: ['/bin/pwd'], dir: outside },
            ctx('ref-roots-once-b')
        )
        assert.equal(second.ok, false)
        assert.match(String(second.error), /outside allowed roots/)
    })
})
