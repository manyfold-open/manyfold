import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    daemonChannelWarning,
    loadDaemonConfigForStart,
    saveDaemonConfig,
    type DaemonConfig,
    type DaemonConfigPaths
} from '../src/daemon/config'

const baseConfig = (overrides: Partial<DaemonConfig> = {}): DaemonConfig => ({
    apiUrl: 'https://api.manyfold.ai/api',
    token: 'ldt_secret',
    daemonId: 'ldh_test',
    daemonUuid: 'daemon-uuid',
    ...overrides
})

const withPaths = async (
    fn: (paths: DaemonConfigPaths) => Promise<void>
): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-daemon-profile-start-'))
    const paths: DaemonConfigPaths = {
        configPath: join(dir, 'config.json'),
        idPath: join(dir, 'daemon.id')
    }
    try {
        await fn(paths)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

// ADR-0014: the profile dir structurally owns the registration, apiUrl is the
// environment truth, and the binary channel is only worth a warning.
test('a channel mismatch warns instead of refusing to start', () => {
    const crossChannel = baseConfig({
        profile: 'staging',
        channel: 'staging',
        apiUrl: 'https://api.dev.example/api'
    })
    const warning = daemonChannelWarning(crossChannel)
    assert.ok(warning)
    assert.match(warning, /staging-channel binary/)
    assert.match(warning, /still serves https:\/\/api\.dev\.example\/api/)
    assert.doesNotMatch(warning, /re-register/)

    const sameChannel = baseConfig({ profile: 'default', channel: 'stable' })
    assert.equal(daemonChannelWarning(sameChannel), null)
})

test('start loads a metadata-bound registration and preserves a custom API URL', async () => {
    await withPaths(async (paths) => {
        const config = baseConfig({
            profile: 'team-a',
            channel: 'stable',
            apiUrl: 'https://self-hosted.example.test/api',
            workspaceBaseDir: '/home/test/.manyfold/workspaces',
            skillsDir: '/home/test/.manyfold/skills'
        })
        await saveDaemonConfig(config, paths)
        assert.deepEqual(await loadDaemonConfigForStart(paths), config)
    })
})

test('start rejects a pre-ADR-0014 registration with re-register guidance', async () => {
    await withPaths(async (paths) => {
        await saveDaemonConfig(baseConfig(), paths)
        await assert.rejects(
            () => loadDaemonConfigForStart(paths),
            (error: unknown) => {
                const message = (error as Error).message
                assert.match(message, /predates the per-profile layout/)
                assert.match(message, /ADR-0014/)
                assert.match(message, /mf daemon register --token -/)
                return true
            }
        )
    })
})

test('start returns null when no registration exists', async () => {
    await withPaths(async (paths) => {
        assert.equal(await loadDaemonConfigForStart(paths), null)
    })
})
