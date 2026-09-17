import { createServer, type IncomingHttpHeaders } from 'node:http'
import { once } from 'node:events'
import type { TestContext } from 'node:test'

export const REVISION_A = 'a'.repeat(40)
export const REVISION_B = 'b'.repeat(40)

export type GitHubFixtureRequest = {
    host: string
    path: string
    headers: IncomingHttpHeaders
}

export const githubFixture = async (t: TestContext) => {
    const requests: GitHubFixtureRequest[] = []
    const state = {
        revision: REVISION_A,
        paths: ['skills/one/SKILL.md'],
        truncated: false,
        malformed: false,
        failPath: '',
        failStatus: 503,
        failBody: 'fixture upstream response',
        failHeaders: {} as Record<string, string>,
        delayMs: 0,
        active: 0,
        peak: 0
    }
    const server = createServer(async (req, res) => {
        const url = new URL(req.url!, 'http://fixture')
        const host = url.searchParams.get('fixture_host') ?? ''
        url.searchParams.delete('fixture_host')
        requests.push({
            host,
            path: url.pathname + url.search,
            headers: req.headers
        })
        state.active++
        state.peak = Math.max(state.peak, state.active)
        try {
            if (state.delayMs)
                await new Promise((resolve) =>
                    setTimeout(resolve, state.delayMs)
                )
            if (state.failPath && url.pathname.includes(state.failPath)) {
                res.writeHead(state.failStatus, state.failHeaders).end(
                    state.failBody
                )
                return
            }
            res.setHeader('x-ratelimit-remaining', '57')
            const json = (body: unknown) => {
                res.setHeader('content-type', 'application/json')
                res.end(JSON.stringify(body))
            }
            if (url.pathname.includes('/commits/'))
                json({ sha: state.revision })
            else if (url.pathname.includes('/git/trees/'))
                json(
                    state.malformed
                        ? {}
                        : {
                              sha: state.revision,
                              truncated: state.truncated,
                              tree: state.paths.map((path) => ({
                                  type: 'blob',
                                  path,
                                  size: 64
                              }))
                          }
                )
            else if (url.pathname.includes('/contents/'))
                json({
                    encoding: 'base64',
                    content: Buffer.from(
                        '---\nname: fixture skill\n---\nfixture description'
                    ).toString('base64')
                })
            else if (host === 'raw.githubusercontent.com')
                res.end('---\nname: fixture skill\n---\nfixture description')
            else json({ default_branch: 'main' })
        } finally {
            state.active--
        }
    })
    server.listen(0, '127.0.0.1')
    await once(server, 'listening')
    const address = server.address()
    if (!address || typeof address === 'string')
        throw new Error('fixture address missing')
    const fetch = globalThis.fetch
    t.mock.method(
        globalThis,
        'fetch',
        (input: string | URL | Request, init?: RequestInit) => {
            const url = new URL(
                typeof input === 'string'
                    ? input
                    : input instanceof URL
                      ? input
                      : input.url
            )
            if (
                !['api.github.com', 'raw.githubusercontent.com'].includes(
                    url.hostname
                )
            )
                throw new Error('unexpected non-fixture request')
            const host = url.hostname
            url.protocol = 'http:'
            url.host = `127.0.0.1:${address.port}`
            url.searchParams.set('fixture_host', host)
            return fetch(url, init)
        }
    )
    t.after(async () => {
        server.closeAllConnections()
        await new Promise<void>((resolve) => server.close(() => resolve()))
    })
    return { state, requests, origin: `http://127.0.0.1:${address.port}` }
}
