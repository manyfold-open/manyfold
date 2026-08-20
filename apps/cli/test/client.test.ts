import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildClient } from '../src/client'

// buildClient resolves the token in order: --token (opts.token) >
// MF_API_TOKEN > pending-login > config.json (§3.4). These cover the new
// env-var tier. Pointing MF_CONFIG_DIR at an empty dir isolates from any real
// config, and the env token short-circuits the network-touching pending-login.
const withEnv = async (
    env: Record<string, string | undefined>,
    fn: () => Promise<void>
): Promise<void> => {
    const prev: Record<string, string | undefined> = {}
    for (const [key, value] of Object.entries(env)) {
        prev[key] = process.env[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
    try {
        await fn()
    } finally {
        for (const [key, value] of Object.entries(prev)) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

test('buildClient uses MF_API_TOKEN when no --token is given', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-cli-'))
    await withEnv(
        {
            MF_CONFIG_DIR: dir,
            MF_PROFILE: 'test',
            MF_API_TOKEN: 'nca_env_identity'
        },
        async () => {
            const { ctx } = await buildClient({})
            assert.equal(ctx.token, 'nca_env_identity')
        }
    )
    await rm(dir, { recursive: true, force: true })
})

test('buildClient: explicit --token beats MF_API_TOKEN', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-cli-'))
    await withEnv(
        {
            MF_CONFIG_DIR: dir,
            MF_PROFILE: 'test',
            MF_API_TOKEN: 'nca_env_identity'
        },
        async () => {
            const { ctx } = await buildClient({ token: 'nca_flag_override' })
            assert.equal(ctx.token, 'nca_flag_override')
        }
    )
    await rm(dir, { recursive: true, force: true })
})

test('buildClient: a blank MF_API_TOKEN is ignored', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-cli-'))
    await withEnv(
        { MF_CONFIG_DIR: dir, MF_PROFILE: 'test', MF_API_TOKEN: '   ' },
        async () => {
            const { ctx } = await buildClient({})
            assert.equal(ctx.token, undefined)
        }
    )
    await rm(dir, { recursive: true, force: true })
})
