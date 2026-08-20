import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    clearPendingLogin,
    loadPendingLogin,
    resolvePendingLoginPath,
    savePendingLogin,
    type PendingLogin
} from '../src/config'
import { resumePendingLogin } from '../src/pending-login'

const withEnv = async (
    overrides: Record<string, string | undefined>,
    fn: () => Promise<void>
): Promise<void> => {
    const previous = new Map<string, string | undefined>()
    for (const [key, value] of Object.entries(overrides)) {
        previous.set(key, process.env[key])
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
    }
    try {
        await fn()
    } finally {
        for (const [key, value] of previous) {
            if (value === undefined) delete process.env[key]
            else process.env[key] = value
        }
    }
}

const withConfigDir = async (
    fn: (dir: string) => Promise<void>
): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-pending-'))
    try {
        await withEnv(
            {
                MF_CONFIG_DIR: dir,
                MF_PROFILE: undefined
            },
            () => fn(dir)
        )
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

const samplePending = (
    overrides: Partial<PendingLogin> = {}
): PendingLogin => ({
    requestId: 'cli_11111111-2222-3333-4444-555555555555',
    deviceCode: 'mf_dvc_secret',
    authUrl: 'https://app.test/cli-login?request=cli_1&code=AAAA-BBBB',
    userCode: 'AAAA-BBBB',
    scopes: ['channels:read'],
    forAgent: 'agt_x',
    apiUrl: 'https://api.test',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides
})

const fileExists = async (path: string): Promise<boolean> =>
    stat(path).then(
        () => true,
        () => false
    )

test('resolvePendingLoginPath scopes non-default profiles to their own file', async () => {
    await withEnv(
        {
            MF_CONFIG_DIR: '/tmp/mf-home',
            MF_PROFILE: 'staging'
        },
        async () => {
            assert.equal(
                resolvePendingLoginPath(),
                '/tmp/mf-home/profiles/staging/pending-login.json'
            )
        }
    )
})

test('pending login save/load/clear roundtrip', async () => {
    await withConfigDir(async () => {
        assert.equal(await loadPendingLogin(), null)
        const pending = samplePending()
        await savePendingLogin(pending)
        assert.deepEqual(await loadPendingLogin(), pending)
        await clearPendingLogin()
        assert.equal(await loadPendingLogin(), null)
        await clearPendingLogin()
    })
})

test('resumePendingLogin reports none without a pending file', async () => {
    await withConfigDir(async () => {
        assert.deepEqual(await resumePendingLogin('https://api.test'), {
            status: 'none'
        })
    })
})

test('resumePendingLogin ignores a pending file for another API', async () => {
    await withConfigDir(async () => {
        await savePendingLogin(samplePending({ apiUrl: 'https://other.api' }))
        const result = await resumePendingLogin('https://api.test', () => {
            throw new Error('poll must not be called')
        })
        assert.equal(result.status, 'none')
        assert.notEqual(await loadPendingLogin(), null)
    })
})

test('resumePendingLogin clears a locally expired pending login', async () => {
    await withConfigDir(async () => {
        await savePendingLogin(
            samplePending({ expiresAt: '2026-01-01T00:00:00.000Z' })
        )
        const result = await resumePendingLogin('https://api.test', () => {
            throw new Error('poll must not be called')
        })
        assert.equal(result.status, 'expired')
        assert.equal(await loadPendingLogin(), null)
    })
})

test('resumePendingLogin completes an approved login and saves the token', async () => {
    await withConfigDir(async (dir) => {
        await savePendingLogin(samplePending())
        const polled: string[] = []
        const result = await resumePendingLogin(
            'https://api.test',
            async (deviceCode) => {
                polled.push(deviceCode)
                return {
                    status: 'approved',
                    token: 'nca_grant_resumed',
                    scopes: ['channels:read', 'api.full' as never],
                    userEmail: 'user@example.com'
                }
            }
        )
        assert.deepEqual(result, {
            status: 'completed',
            token: 'nca_grant_resumed',
            scopes: ['channels:read'],
            userEmail: 'user@example.com'
        })
        assert.deepEqual(polled, ['mf_dvc_secret'])
        assert.deepEqual(
            JSON.parse(
                await readFile(
                    join(dir, 'profiles', 'default', 'config.json'),
                    'utf8'
                )
            ),
            { apiUrl: 'https://api.test', token: 'nca_grant_resumed' }
        )
        assert.equal(await loadPendingLogin(), null)
    })
})

test('resumePendingLogin keeps the pending file while unapproved', async () => {
    await withConfigDir(async () => {
        const pending = samplePending()
        await savePendingLogin(pending)
        const result = await resumePendingLogin(
            'https://api.test',
            async () => ({ status: 'pending' })
        )
        assert.deepEqual(result, { status: 'pending', pending })
        assert.deepEqual(await loadPendingLogin(), pending)
    })
})

test('resumePendingLogin clears the file when the API reports expiry', async () => {
    await withConfigDir(async () => {
        await savePendingLogin(samplePending())
        const result = await resumePendingLogin(
            'https://api.test',
            async () => ({ status: 'expired' })
        )
        assert.equal(result.status, 'expired')
        assert.equal(await loadPendingLogin(), null)
    })
})

test('resumePendingLogin clears the file on a 404 deviceCode', async () => {
    await withConfigDir(async () => {
        await savePendingLogin(samplePending())
        const result = await resumePendingLogin(
            'https://api.test',
            async () => {
                throw new Error('404 Not Found: deviceCode not found')
            }
        )
        assert.equal(result.status, 'expired')
        assert.equal(await loadPendingLogin(), null)
    })
})

test('resumePendingLogin keeps the file and rethrows on transport errors', async () => {
    await withConfigDir(async () => {
        await savePendingLogin(samplePending())
        await assert.rejects(
            () =>
                resumePendingLogin('https://api.test', async () => {
                    throw new Error('fetch failed')
                }),
            /fetch failed/
        )
        assert.notEqual(await loadPendingLogin(), null)
        assert.equal(await fileExists(resolvePendingLoginPath()), true)
    })
})
