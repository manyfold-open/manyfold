import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type Server } from 'node:http'
import { buildProgram } from '../src/program'

// The --json contract for `mf skills discover`: since the discoverPage
// migration the payload is the paged envelope {items, nextCursor}, printed
// verbatim (cli.md — raw, unwrapped API payload, 2-space indent). Nothing
// pinned the previous bare-array shape, which is how it survived unowned;
// this file is the pin for the new one.
const PAGE = {
    items: [
        {
            skillId: 'sk_alpha',
            name: 'alpha',
            description: 'first skill'
        },
        {
            skillId: 'sk_beta',
            name: 'beta',
            description: null
        }
    ],
    nextCursor: '100'
}

const withApi = async (
    run: (baseUrl: string, urls: string[]) => Promise<void>
): Promise<void> => {
    const urls: string[] = []
    const server: Server = createServer((req, res) => {
        urls.push(req.url ?? '')
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify(PAGE))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
        await run(`http://127.0.0.1:${port}/api`, urls)
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
}

const withCapturedOutput = async (
    fn: () => Promise<void>
): Promise<{ out: string[]; err: string[] }> => {
    const out: string[] = []
    const err: string[] = []
    const previousLog = console.log
    const previousError = console.error
    console.log = ((...values: unknown[]) => {
        out.push(values.join(' '))
    }) as typeof console.log
    console.error = ((...values: unknown[]) => {
        err.push(values.join(' '))
    }) as typeof console.error
    try {
        await fn()
    } finally {
        console.log = previousLog
        console.error = previousError
    }
    return { out, err }
}

const runCli = async (baseUrl: string, argv: string[]): Promise<void> => {
    const program = buildProgram()
    program.exitOverride()
    await program.parseAsync(
        ['node', 'mf', '--api-url', baseUrl, '--token', 'test-token', ...argv],
        { from: 'node' }
    )
}

test('skills discover --json prints the paged envelope verbatim', async () => {
    await withApi(async (baseUrl, urls) => {
        const { out } = await withCapturedOutput(() =>
            runCli(baseUrl, ['skills', 'discover', '--json'])
        )
        assert.deepEqual(out, [JSON.stringify(PAGE, null, 2)])
        assert.equal(urls.length, 1)
        const query = new URL(`http://x${urls[0]}`).searchParams
        // Always the envelope branch: sort is unconditionally sent, and the
        // default page is the server max so short catalogs keep the old
        // single-response behavior.
        assert.equal(query.get('sort'), 'featured')
        assert.equal(query.get('limit'), '100')
    })
})

test('skills discover human output lists items and hints at the next page on stderr', async () => {
    await withApi(async (baseUrl) => {
        const { out, err } = await withCapturedOutput(() =>
            runCli(baseUrl, ['skills', 'discover'])
        )
        assert.equal(out.length, 2)
        assert.match(out[0], /sk_alpha/)
        assert.match(out[1], /sk_beta/)
        assert.equal(err.length, 1)
        assert.match(err[0], /--cursor 100/)
    })
})

test('skills discover forwards --sort/--cursor/--limit and rejects unknown sorts', async () => {
    await withApi(async (baseUrl, urls) => {
        await withCapturedOutput(() =>
            runCli(baseUrl, [
                'skills',
                'discover',
                '--json',
                '--sort',
                'latest',
                '--cursor',
                '24',
                '--limit',
                '24'
            ])
        )
        const query = new URL(`http://x${urls[0]}`).searchParams
        assert.equal(query.get('sort'), 'latest')
        assert.equal(query.get('cursor'), '24')
        assert.equal(query.get('limit'), '24')

        await assert.rejects(
            withCapturedOutput(() =>
                runCli(baseUrl, ['skills', 'discover', '--sort', 'name'])
            ),
            /--sort must be 'featured' or 'latest'/
        )
    })
})
