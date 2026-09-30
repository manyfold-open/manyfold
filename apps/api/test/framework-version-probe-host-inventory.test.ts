import assert from 'node:assert/strict'
import test from 'node:test'
import { agentRuntimes, hostDaemons } from '@manyfold/db'
import type { DetectedFramework } from '@manyfold/shared'
import { FrameworkVersionProbeService } from '../src/modules/agents/framework-versions/framework-version-probe.service'

// After an agent's upgrade the API probes the CLI and stores the version on
// the runtime; the host's inventory has to carry it too, stamped, or the
// sandbox page's next detect copies the daemon's cached, older version back
// onto the runtime.
const setup = (inventory: DetectedFramework[]) => {
    const writes: Array<{ table: unknown; set: Record<string, unknown> }> = []
    const db = {
        update: (table: unknown) => ({
            set: (set: Record<string, unknown>) => ({
                where: async () => {
                    writes.push({ table, set })
                }
            })
        }),
        select: () => ({
            from: () => ({
                where: () => ({
                    limit: async () => [{ detectedFrameworks: inventory }]
                })
            })
        })
    }
    const service = new FrameworkVersionProbeService(
        db as never,
        {
            forRuntime: async () => ({
                runtime: { id: 'art_1', hostId: 'sbx_1' },
                placement: 'sprites'
            })
        } as never,
        {
            forRuntime: async () => ({
                run: async () => ({
                    exitCode: 0,
                    stdout: '2.1.283 (Claude Code)\n',
                    stderr: ''
                })
            })
        } as never
    )
    return { service, writes }
}

const runtime = { id: 'art_1', framework: 'claude-code' }

test('a probed version lands on the runtime and, stamped, in the inventory', async () => {
    const pi = { framework: 'pi', version: '0.87.1', path: '~/.local/bin/pi' }
    const { service, writes } = setup([
        pi,
        {
            framework: 'claude-code',
            version: '2.1.251 (Claude Code)',
            path: '/home/sprite/.local/bin/claude'
        }
    ] as DetectedFramework[])

    assert.equal(await service.probeAndPersist(runtime), '2.1.283')

    assert.equal(writes[0].table, agentRuntimes)
    assert.equal(writes[0].set.frameworkVersion, '2.1.283')
    assert.equal(writes[1].table, hostDaemons)
    const inventory = writes[1].set.detectedFrameworks as DetectedFramework[]
    assert.deepEqual(inventory[0], pi)
    assert.equal(inventory[1].framework, 'claude-code')
    assert.equal(inventory[1].version, '2.1.283')
    assert.equal(inventory[1].path, '/home/sprite/.local/bin/claude')
    assert.ok(inventory[1].probedAt)
})

test('a CLI the daemon has not reported is left to its next detection', async () => {
    const { service, writes } = setup([
        { framework: 'pi', version: '0.87.1', path: '~/.local/bin/pi' }
    ] as DetectedFramework[])

    await service.probeAndPersist(runtime)

    assert.deepEqual(
        writes.map((write) => write.table),
        [agentRuntimes]
    )
})
