import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureSignedIn } from '../src/commands/setup'

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

const withFetch = async (
    fetchImpl: typeof fetch,
    fn: () => Promise<void>
): Promise<void> => {
    const previous = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
        await fn()
    } finally {
        globalThis.fetch = previous
    }
}

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    })

const inConfigDir = async (
    fn: (dir: string) => Promise<void>
): Promise<void> => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-setup-'))
    try {
        await withEnv(
            {
                MF_CONFIG_DIR: dir,
                MF_PROFILE: 'default',
                MF_API_TOKEN: undefined,
                MF_TOKEN: undefined
            },
            () => fn(dir)
        )
    } finally {
        await rm(dir, { recursive: true, force: true })
    }
}

test('setup reuses an existing login instead of forcing a new one', async () => {
    await inConfigDir(async (dir) => {
        await mkdir(join(dir, 'profiles', 'default'), { recursive: true })
        await writeFile(
            join(dir, 'profiles', 'default', 'config.json'),
            JSON.stringify({
                apiUrl: 'https://api.test/api',
                token: 'mfs_stored'
            })
        )
        let authHeader = ''
        await withFetch((async (input: unknown, init?: RequestInit) => {
            authHeader = init?.headers
                ? (new Headers(init.headers).get('authorization') ?? '')
                : input instanceof Request
                  ? (input.headers.get('authorization') ?? '')
                  : ''
            return json({ id: 'user-1', email: 'ying@example.com' })
        }) as typeof fetch, async () => {
            const result = await ensureSignedIn('https://api.test/api', undefined)
            assert.equal(result.userEmail, 'ying@example.com')
            assert.equal(result.userToken, 'mfs_stored')
            assert.match(authHeader, /mfs_stored/)
        })
    })
})

test('setup on a headless machine fails with guidance instead of hanging on a browser', async () => {
    await inConfigDir(async () => {
        await withFetch((async () =>
            json({ message: 'unauthorized' }, 401)) as typeof fetch, async () => {
            await assert.rejects(
                ensureSignedIn('https://api.test/api', undefined),
                /run `mf login` on this machine first, or pass --token/
            )
        })
    })
})

test('setup --token validates then persists the credential', async () => {
    await inConfigDir(async (dir) => {
        await withFetch((async () =>
            json({ id: 'user-1', email: 'ying@example.com' })) as typeof fetch, async () => {
            const result = await ensureSignedIn(
                'https://api.test/api',
                'mfs_explicit'
            )
            assert.equal(result.userToken, 'mfs_explicit')
        })
        const saved = JSON.parse(
            await readFile(
                join(dir, 'profiles', 'default', 'config.json'),
                'utf8'
            )
        ) as { apiUrl: string; token: string }
        assert.equal(saved.token, 'mfs_explicit')
        assert.equal(saved.apiUrl, 'https://api.test/api')
    })
})

test('an invalid --token surfaces the API error, never a browser fallback', async () => {
    await inConfigDir(async () => {
        await withFetch((async () =>
            json({ message: 'unauthorized' }, 401)) as typeof fetch, async () => {
            await assert.rejects(
                ensureSignedIn('https://api.test/api', 'mfs_bad'),
                /unauthorized/
            )
        })
    })
})
