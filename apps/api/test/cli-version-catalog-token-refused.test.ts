import test from 'node:test'
import assert from 'node:assert/strict'
import { CliVersionCatalogService } from '../src/modules/daemon/cli-version-catalog.service'

// The org's token policy answers 403 with this body for a fine-grained token
// whose lifetime it refuses; githubResponseError classifies it credential_policy.
const POLICY_BODY = JSON.stringify({
    message:
        "The 'fixture-org' organization forbids access via a fine-grained personal access tokens if the token's lifetime is greater than 366 days."
})

const catalog = () =>
    new CliVersionCatalogService(
        {
            get: (key: string) =>
                key === 'GITHUB_TOKEN' ? 'synthetic-platform-credential' : 'production'
        } as never,
        { getCachedCliMinimumVersion: async () => ({ minVersion: null }) } as never
    )

const mockFetch = (
    t: { mock: { method: (...args: never[]) => unknown } },
    answer: (url: string, authorized: boolean) => Response
): Array<{ url: string; authorized: boolean }> => {
    const calls: Array<{ url: string; authorized: boolean }> = []
    ;(t.mock.method as (o: object, k: string, f: unknown) => void)(
        globalThis,
        'fetch',
        async (input: string | URL | Request, init?: RequestInit) => {
            const url = String(input)
            const authorized = new Headers(init?.headers).has('authorization')
            calls.push({ url, authorized })
            return answer(url, authorized)
        }
    )
    return calls
}

// The API list endpoint, not the channel manifest (itself a release asset under
// /releases/download/).
const isList = (url: string): boolean => url.includes('/releases?')

const releases = new Response(
    JSON.stringify([{ tag_name: 'cli-v5.11.0' }, { tag_name: 'cli-v5.9.0' }]),
    { status: 200 }
)

test('a token the org refuses by policy does not hide the public release list', async (t) => {
    const calls = mockFetch(t, (url, authorized) =>
        isList(url) && authorized
            ? new Response(POLICY_BODY, { status: 403 })
            : releases.clone()
    )
    assert.deepEqual((await catalog().getCachedCatalog()).stable, ['5.11.0', '5.9.0'])
    const reads = calls.filter((c) => isList(c.url))
    assert.deepEqual(
        reads.map((c) => c.authorized),
        [true, false],
        'the refused read is retried once without the token'
    )
})

test('an invalid token is retried without it too', async (t) => {
    const calls = mockFetch(t, (url, authorized) =>
        isList(url) && authorized
            ? new Response('{"message":"Bad credentials"}', { status: 401 })
            : releases.clone()
    )
    assert.deepEqual((await catalog().getCachedCatalog()).stable, ['5.11.0', '5.9.0'])
    assert.equal(calls.filter((c) => isList(c.url)).length, 2)
})

test('a token GitHub accepts is the only read', async (t) => {
    const calls = mockFetch(t, () => releases.clone())
    assert.deepEqual((await catalog().getCachedCatalog()).stable, ['5.11.0', '5.9.0'])
    assert.deepEqual(
        calls.filter((c) => isList(c.url)).map((c) => c.authorized),
        [true]
    )
})

test('other failures still fall back to the channel latest without a second read', async (t) => {
    const calls = mockFetch(t, (url) =>
        isList(url)
            ? new Response('{"message":"Not Found"}', { status: 404 })
            : new Response(JSON.stringify({ version: '5.11.0' }), { status: 200 })
    )
    assert.deepEqual((await catalog().getCachedCatalog()).stable, ['5.11.0'])
    assert.equal(calls.filter((c) => isList(c.url)).length, 1)
})
