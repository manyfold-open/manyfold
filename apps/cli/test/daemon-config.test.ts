import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    loadDaemonConfig,
    loadOrCreateDaemonUuid,
    saveDaemonConfig,
    type DaemonConfigPaths
} from '../src/daemon/config'

const withDaemonPaths = async (
    fn: (paths: DaemonConfigPaths) => Promise<void>
): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-daemon-config-'))
    const paths = {
        configPath: join(dir, 'config.json'),
        idPath: join(dir, 'daemon.id')
    }
    try {
        await fn(paths)
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

test('loadDaemonConfig returns null only when config is missing', async () => {
    await withDaemonPaths(async (paths) => {
        assert.equal(await loadDaemonConfig(paths), null)
        await writeFile(paths.configPath, '{"token":"mf_secret"')
        const err = await loadDaemonConfig(paths).then(
            () => undefined,
            (reason: unknown) => reason as Error
        )
        assert.ok(err)
        assert.match(err.message, new RegExp(paths.configPath))
        assert.match(err.message, /mf daemon register/)
        assert.doesNotMatch(err.message, /mf_secret/)
    })
})

test('daemon config save and load roundtrip with private permissions', async () => {
    await withDaemonPaths(async (paths) => {
        const config = {
            apiUrl: 'https://api.test',
            token: 'ldt_secret',
            daemonId: 'ldh_test',
            daemonUuid: '00000000-0000-7000-8000-000000000001'
        }
        await saveDaemonConfig(config, paths)
        assert.deepEqual(await loadDaemonConfig(paths), config)
        assert.equal((await stat(paths.configPath)).mode & 0o777, 0o600)
    })
})

test('daemon UUID is minted once, persisted, and kept private', async () => {
    await withDaemonPaths(async (paths) => {
        const first = await loadOrCreateDaemonUuid(paths)
        assert.match(first, /^[0-9a-f-]{36}$/)
        assert.equal(await readFile(paths.idPath, 'utf8'), first)
        assert.equal(await loadOrCreateDaemonUuid(paths), first)
        assert.equal((await stat(paths.idPath)).mode & 0o777, 0o600)
    })
})

test('empty daemon identity fails instead of silently replacing it', async () => {
    await withDaemonPaths(async (paths) => {
        await writeFile(paths.idPath, '  \n')
        await assert.rejects(
            () => loadOrCreateDaemonUuid(paths),
            /previous identity will be lost/
        )
        assert.equal(await readFile(paths.idPath, 'utf8'), '  \n')
    })
})

test('unreadable daemon identity fails instead of minting a replacement', async () => {
    await withDaemonPaths(async (paths) => {
        await writeFile(paths.idPath, 'not a directory')
        const nestedPaths = {
            ...paths,
            idPath: join(paths.idPath, 'nested')
        }
        await assert.rejects(
            () => loadOrCreateDaemonUuid(nestedPaths),
            /previous identity will be lost/
        )
        assert.equal(await readFile(paths.idPath, 'utf8'), 'not a directory')
    })
})
