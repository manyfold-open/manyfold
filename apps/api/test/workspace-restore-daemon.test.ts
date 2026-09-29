import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash, randomBytes } from 'node:crypto'
import {
    DAEMON_FEATURE_FS_ROOTS,
    DAEMON_FEATURE_FS_WRITE_STREAM
} from '@manyfold/shared'
import { WorkspaceRuntimeService } from '../src/modules/backups/workspace-runtime.service'
import { HostDaemonOfflineError } from '../src/modules/agents/adapters/host-daemon-access'

// A restore archive streams into the machine through its daemon, in chunks,
// into an owner-only part file that becomes the archive once its size and
// sha256 match. It was once inlined into one `bash -lc` argument, which Linux
// caps at 128 KiB, and later sent as one fs.write frame capped at a few MiB.

const agent = {
    id: 'agent-1',
    userId: 'user-1',
    workspacePath: '/Users/cy/.manyfold/workspaces/agent-1',
    mountPath: '/Users/cy/.manyfold/workspaces/agent-1'
}

const build = (opts: { hosted?: boolean; features?: string[] } = {}) => {
    const rpcs: Array<{ method: string; payload: Record<string, unknown> }> = []
    const execs: string[] = []
    const sessions: Array<readonly string[] | undefined> = []
    const host = opts.hosted
        ? { id: 'sbx_1', kind: 'hosted', name: 'sandbox' }
        : { id: 'dh_1', kind: 'local', name: 'laptop' }
    const ctx = {
        agent,
        placement: opts.hosted ? 'sprites' : 'daemon',
        host,
        daemon: { hostId: host.id, clientFeatures: opts.features ?? [] }
    }
    const service = new WorkspaceRuntimeService(
        { forAgent: async () => ctx } as never,
        {
            withHost: async (
                args: { requiredFeatures?: readonly string[] },
                work: (session: unknown) => Promise<unknown>
            ) => {
                sessions.push(args.requiredFeatures)
                const missing = (args.requiredFeatures ?? []).filter(
                    (f) => !(opts.features ?? []).includes(f)
                )
                if (missing.length)
                    throw new HostDaemonOfflineError(
                        host as never,
                        'runner_cli_too_old'
                    )
                return work({
                    host,
                    rpc: async (call: {
                        method: string
                        payload: Record<string, unknown>
                    }) => {
                        rpcs.push(call)
                        return call.method === 'fs.write.begin'
                            ? { uploadId: 'upl-1', chunkMaxBytes: 256 * 1024 }
                            : {}
                    },
                    exec: async (req: { cmd: string[] }) => {
                        execs.push(req.cmd.join(' '))
                        return { exitCode: 0, stdout: '', stderr: '' }
                    }
                })
            }
        } as never
    )
    return { service, rpcs, execs, sessions }
}

async function* chunked(bytes: Buffer): AsyncIterable<Uint8Array> {
    for (let at = 0; at < bytes.length; at += 64 * 1024)
        yield bytes.subarray(at, at + 64 * 1024)
}

test('a restore archive streams into the daemon byte for byte, owner-only', async () => {
    const { service, rpcs } = build({
        features: [DAEMON_FEATURE_FS_WRITE_STREAM]
    })
    const archive = randomBytes(600 * 1024)

    const path = await service.writeRestoreArchive(
        agent as never,
        'rst_1',
        chunked(archive)
    )

    assert.equal(
        path,
        '/Users/cy/.manyfold/workspaces/agent-1/.nca-backup-tmp/restore-rst_1.tar.gz'
    )
    assert.deepEqual(rpcs[0], {
        method: 'fs.write.begin',
        payload: { path, mode: '600' },
        timeoutMs: 30_000
    } as never)
    const chunks = rpcs.filter((c) => c.method === 'fs.write.chunk')
    assert.equal(chunks.length, 3)
    assert.ok(
        Buffer.concat(
            chunks.map((c) => Buffer.from(String(c.payload.data), 'base64'))
        ).equals(archive)
    )
    const commit = rpcs.at(-1)!
    assert.equal(commit.method, 'fs.write.commit')
    assert.equal(commit.payload.size, archive.byteLength)
    assert.equal(
        commit.payload.sha256,
        createHash('sha256').update(archive).digest('hex')
    )
})

// The platform owns a sandbox's filesystem: its workspace is vouched for on
// the write, and the daemon has to honour that.
test('a sandbox restore vouches for its workspace', async () => {
    const { service, rpcs, sessions } = build({
        hosted: true,
        features: [DAEMON_FEATURE_FS_ROOTS, DAEMON_FEATURE_FS_WRITE_STREAM]
    })
    await service.writeRestoreArchive(
        agent as never,
        'rst_3',
        chunked(randomBytes(1024))
    )
    assert.deepEqual(rpcs[0].payload.roots, [agent.mountPath])
    assert.deepEqual(sessions[0], [
        DAEMON_FEATURE_FS_ROOTS,
        DAEMON_FEATURE_FS_WRITE_STREAM
    ])
})

// WHY: a self-owned computer is its user's to update; a daemon that cannot
// stream a write is told so, and the partial path is cleaned.
test('a daemon that cannot stream writes is asked to upgrade, and the partial path is cleaned', async () => {
    const { service, rpcs, execs } = build({ features: [] })

    await assert.rejects(
        service.writeRestoreArchive(
            agent as never,
            'rst_2',
            chunked(randomBytes(1024))
        ),
        /the Manyfold CLI on laptop is too old for this; update it and retry/
    )
    assert.equal(rpcs.length, 0)
    assert.equal(execs.length, 1, 'the cleanup ran')
})
