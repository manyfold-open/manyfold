import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    loadUpdateChannelPref,
    saveUpdateChannelPref,
    updateChannelPrefPath
} from '../src/channel-pref'

const withTmpConfigDir = async (fn: () => Promise<void>): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-channel-pref-'))
    const previous = process.env.MF_CONFIG_DIR
    process.env.MF_CONFIG_DIR = dir
    try {
        await fn()
    } finally {
        if (previous === undefined) delete process.env.MF_CONFIG_DIR
        else process.env.MF_CONFIG_DIR = previous
        await rm(dir, { recursive: true, force: true })
    }
}

test('saveUpdateChannelPref round-trips through loadUpdateChannelPref', async () => {
    await withTmpConfigDir(async () => {
        await saveUpdateChannelPref('dev')
        assert.equal(await loadUpdateChannelPref(), 'dev')
        await saveUpdateChannelPref('stable')
        assert.equal(await loadUpdateChannelPref(), 'stable')
    })
})

test('loadUpdateChannelPref returns null when no preference is saved', async () => {
    await withTmpConfigDir(async () => {
        assert.equal(await loadUpdateChannelPref(), null)
    })
})

test('loadUpdateChannelPref tolerates invalid JSON', async () => {
    await withTmpConfigDir(async () => {
        await writeFile(updateChannelPrefPath(), 'not json', 'utf8')
        assert.equal(await loadUpdateChannelPref(), null)
    })
})

test('loadUpdateChannelPref rejects an unknown channel value', async () => {
    await withTmpConfigDir(async () => {
        await writeFile(
            updateChannelPrefPath(),
            JSON.stringify({ channel: 'beta' }),
            'utf8'
        )
        assert.equal(await loadUpdateChannelPref(), null)
    })
})
