import assert from 'node:assert/strict'
import test from 'node:test'
import { randomBytes } from 'node:crypto'
import { WorkspaceRuntimeService } from '../src/modules/backups/workspace-runtime.service'

// A restore to a self-owned computer writes the archive through the daemon.
// It used to be inlined into one `bash -lc` argument, which Linux caps at
// 128 KiB, so restoring any real workspace failed.

const agent = {
    id: 'agent-1',
    userId: 'user-1',
    workspacePath: '/Users/cy/.manyfold/workspaces/agent-1',
    mountPath: '/Users/cy/.manyfold/workspaces/agent-1'
}

const build = (clientFeatures: string[]) => {
    const rpcs: Array<{ method: string; payload: Record<string, unknown> }> = []
    const streams: string[] = []
    const ctx = {
        agent,
        placement: 'daemon',
        host: { id: 'dh_1', kind: 'local', name: 'laptop' },
        daemon: { hostId: 'dh_1', clientFeatures }
    }
    const service = new WorkspaceRuntimeService(
        { forAgent: async () => ctx } as never,
        {} as never,
        {
            rpc: async (call: { method: string; payload: Record<string, unknown> }) => {
                rpcs.push(call)
                return {}
            },
            streamRpc: (call: { payload: { cmd: string[] } }) => {
                streams.push(call.payload.cmd.join(' '))
                return { result: Promise.resolve({ exitCode: 0 }) }
            }
        } as never
    )
    return { service, rpcs, streams }
}

async function* chunked(bytes: Buffer): AsyncIterable<Uint8Array> {
    for (let at = 0; at < bytes.length; at += 64 * 1024)
        yield bytes.subarray(at, at + 64 * 1024)
}

test('a restore archive past the argv limit lands byte for byte in one fs.write', async () => {
    const { service, rpcs } = build(['fs.write.binary', 'fs.write.mode'])
    const archive = randomBytes(512 * 1024)

    const path = await service.writeRestoreArchive(
        agent as never,
        'rst_1',
        chunked(archive)
    )

    assert.equal(
        path,
        '/Users/cy/.manyfold/workspaces/agent-1/.nca-backup-tmp/restore-rst_1.tar.gz'
    )
    assert.equal(rpcs.length, 1)
    assert.equal(rpcs[0].method, 'fs.write')
    assert.equal(rpcs[0].payload.path, path)
    assert.equal(rpcs[0].payload.encoding, 'base64')
    assert.equal(rpcs[0].payload.mode, '600')
    assert.ok(
        Buffer.from(rpcs[0].payload.content as string, 'base64').equals(archive)
    )
})

// WHY: a daemon without binary writes would store the base64 text as the
// archive and the restore would unpack garbage; it is told to upgrade instead.
test('a daemon that cannot write binary files is asked to upgrade, and the partial path is cleaned', async () => {
    const { service, rpcs, streams } = build(['fs.write.mode'])

    await assert.rejects(
        service.writeRestoreArchive(
            agent as never,
            'rst_2',
            chunked(randomBytes(1024))
        ),
        /update the Manyfold CLI on laptop to restore a backup \(needs fs\.write\.binary\)/
    )
    assert.equal(rpcs.length, 0)
    assert.equal(streams.length, 1, 'the cleanup ran')
})
