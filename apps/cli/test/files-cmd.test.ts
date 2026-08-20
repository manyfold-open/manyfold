import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer, type Server } from 'node:http'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildProgram } from '../src/program'

interface Seen {
    method: string
    url: string
    body: Buffer
}

const withApi = async (
    run: (baseUrl: string, calls: Seen[]) => Promise<void>
): Promise<void> => {
    const calls: Seen[] = []
    const server: Server = createServer((req, res) => {
        const chunks: Buffer[] = []
        req.on('data', (c: Buffer) => chunks.push(c))
        req.on('end', () => {
            calls.push({
                method: req.method ?? 'GET',
                url: req.url ?? '',
                body: Buffer.concat(chunks)
            })
            const url = req.url ?? ''
            if (url.includes('/files/read')) {
                const payload = Buffer.from('remote contents')
                res.writeHead(200, {
                    'content-type': 'application/octet-stream',
                    'content-length': String(payload.byteLength)
                })
                res.end(payload)
                return
            }
            if (url.includes('/files/roots')) {
                res.writeHead(200, { 'content-type': 'application/json' })
                res.end(JSON.stringify({ roots: [] }))
                return
            }
            res.writeHead(200, { 'content-type': 'application/json' })
            res.end('{"ok":true,"entries":[]}')
        })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    const port = typeof address === 'object' && address ? address.port : 0
    try {
        await run(`http://127.0.0.1:${port}/api`, calls)
    } finally {
        await new Promise<void>((resolve) => server.close(() => resolve()))
    }
}

const runCli = async (baseUrl: string, argv: string[]): Promise<void> => {
    const program = buildProgram()
    program.exitOverride()
    await program.parseAsync(
        ['node', 'mf', '--api-url', baseUrl, '--token', 'test-token', ...argv],
        { from: 'node' }
    )
}

const withAgentEnv = async (
    value: string | undefined,
    fn: () => Promise<void>
): Promise<void> => {
    const previous = process.env.MF_AGENT_ID
    if (value === undefined) delete process.env.MF_AGENT_ID
    else process.env.MF_AGENT_ID = value
    try {
        await fn()
    } finally {
        if (previous === undefined) delete process.env.MF_AGENT_ID
        else process.env.MF_AGENT_ID = previous
    }
}

const agentIdIn = (url: string): string =>
    /\/agents\/([^/]+)\//.exec(url)?.[1] ?? ''

const queryPath = (url: string): string =>
    new URL(url, 'http://x').searchParams.get('path') ?? ''

// the shipped syntax leads with a positional agent id; scripts depend on it
test('files list keeps the legacy "<agentId> <path>" form working', async () => {
    await withAgentEnv(undefined, async () => {
        await withApi(async (baseUrl, calls) => {
            await runCli(baseUrl, ['files', 'list', 'agt_legacy', 'src'])

            assert.equal(calls.length, 1)
            assert.equal(agentIdIn(calls[0].url), 'agt_legacy')
            assert.equal(queryPath(calls[0].url), 'src')
        })
    })
})

// the account-scope design says a self-scoped `mf files ls` should just work;
// arity decides, so one argument is a path and the agent comes from context
test('files ls with one argument takes the agent from MF_AGENT_ID', async () => {
    await withAgentEnv('agt_from_env', async () => {
        await withApi(async (baseUrl, calls) => {
            await runCli(baseUrl, ['files', 'ls', 'src'])

            assert.equal(agentIdIn(calls[0].url), 'agt_from_env')
            assert.equal(queryPath(calls[0].url), 'src')
        })
    })
})

test('files ls with no arguments lists the root of the context agent', async () => {
    await withAgentEnv('agt_from_env', async () => {
        await withApi(async (baseUrl, calls) => {
            await runCli(baseUrl, ['files', 'ls'])

            assert.equal(agentIdIn(calls[0].url), 'agt_from_env')
            assert.equal(queryPath(calls[0].url), '.')
        })
    })
})

test('files ls without an agent anywhere explains how to supply one', async () => {
    await withAgentEnv(undefined, async () => {
        await withApi(async (baseUrl, calls) => {
            await assert.rejects(
                () => runCli(baseUrl, ['files', 'ls', 'src']),
                /agent id is required/
            )
            assert.equal(calls.length, 0)
        })
    })
})

test('the global --agent-id works after the subcommand', async () => {
    await withAgentEnv('agt_from_env', async () => {
        await withApi(async (baseUrl, calls) => {
            await runCli(baseUrl, [
                'files',
                'ls',
                'src',
                '--agent-id',
                'agt_flag'
            ])

            assert.equal(agentIdIn(calls[0].url), 'agt_flag')
        })
    })
})

// mv has two paths, so three arguments means the first is an agent id
test('files mv distinguishes two paths from agentId plus two paths', async () => {
    await withAgentEnv('agt_from_env', async () => {
        await withApi(async (baseUrl, calls) => {
            await runCli(baseUrl, ['files', 'mv', 'a.txt', 'b.txt'])
            await runCli(baseUrl, [
                'files',
                'mv',
                'agt_explicit',
                'a.txt',
                'b.txt'
            ])

            assert.equal(agentIdIn(calls[0].url), 'agt_from_env')
            assert.deepEqual(JSON.parse(calls[0].body.toString()), {
                from: 'a.txt',
                to: 'b.txt'
            })
            assert.equal(agentIdIn(calls[1].url), 'agt_explicit')
            assert.deepEqual(JSON.parse(calls[1].body.toString()), {
                from: 'a.txt',
                to: 'b.txt'
            })
        })
    })
})

test('files upload sends the local file and defaults the remote name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-cmd-upload-'))
    const localPath = join(dir, 'report.csv')
    await writeFile(localPath, 'a,b\n1,2\n')

    await withAgentEnv('agt_upload', async () => {
        await withApi(async (baseUrl, calls) => {
            await runCli(baseUrl, ['files', 'upload', localPath])

            assert.equal(calls.length, 1)
            assert.equal(calls[0].method, 'PUT')
            assert.equal(agentIdIn(calls[0].url), 'agt_upload')
            assert.equal(queryPath(calls[0].url), 'report.csv')
            assert.equal(calls[0].body.toString(), 'a,b\n1,2\n')
        })
    })
})

test('files upload honours an explicit remote path and root', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-cmd-upload2-'))
    const localPath = join(dir, 'settings.json')
    await writeFile(localPath, '{}')

    await withAgentEnv('agt_upload', async () => {
        await withApi(async (baseUrl, calls) => {
            await runCli(baseUrl, [
                'files',
                'upload',
                localPath,
                'nested/dir/settings.json',
                '--root',
                'claude-home'
            ])

            assert.equal(queryPath(calls[0].url), 'nested/dir/settings.json')
            assert.ok(calls[0].url.includes('rootId=claude-home'))
        })
    })
})

test('files download writes the remote body to the defaulted local name', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-cmd-download-'))
    const previousCwd = process.cwd()
    process.chdir(dir)

    try {
        await withAgentEnv('agt_download', async () => {
            await withApi(async (baseUrl, calls) => {
                await runCli(baseUrl, ['files', 'download', 'logs/out.txt'])

                assert.equal(calls[0].method, 'GET')
                assert.equal(agentIdIn(calls[0].url), 'agt_download')
                assert.equal(queryPath(calls[0].url), 'logs/out.txt')
                assert.equal(
                    await readFile(join(dir, 'out.txt'), 'utf8'),
                    'remote contents'
                )
            })
        })
    } finally {
        process.chdir(previousCwd)
    }
})

test('files download requires an agent like every other command', async () => {
    await withAgentEnv(undefined, async () => {
        await withApi(async (baseUrl, calls) => {
            await assert.rejects(
                () => runCli(baseUrl, ['files', 'download', 'out.txt']),
                /agent id is required/
            )
            assert.equal(calls.length, 0)
        })
    })
})

test('files write rejects --content together with --file', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-cmd-write-'))
    const localPath = join(dir, 'body.txt')
    await writeFile(localPath, 'from file')

    await withAgentEnv('agt_write', async () => {
        await withApi(async (baseUrl, calls) => {
            await assert.rejects(
                () =>
                    runCli(baseUrl, [
                        'files',
                        'write',
                        'notes.md',
                        '--content',
                        'inline',
                        '--file',
                        localPath
                    ]),
                /mutually exclusive/
            )
            assert.equal(calls.length, 0)
        })
    })
})
