import test from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { resolveSecretInput } from '../src/secret-input'

test('resolveSecretInput preserves literal secrets without reading stdin', () => {
    let reads = 0
    assert.equal(
        resolveSecretInput('  nca_literal  ', '--token', () => {
            reads += 1
            return 'unused'
        }),
        'nca_literal'
    )
    assert.equal(reads, 0)
})

test('resolveSecretInput reads a dash value from stdin', () => {
    assert.equal(
        resolveSecretInput('-', '--token', () => '  nca_piped\n'),
        'nca_piped'
    )
})

test('resolveSecretInput rejects empty or unreadable stdin without exposing a secret', () => {
    assert.throws(
        () => resolveSecretInput('-', '--token', () => ' \n'),
        /--token - received empty stdin/
    )
    assert.throws(
        () =>
            resolveSecretInput('-', '--token', () => {
                throw new Error('closed pipe')
            }),
        /--token - could not read stdin: closed pipe/
    )
})

const spawnCliWithStdinToken = async (
    commandArgs: string[],
    handleRequest: (path: string) => { status: number; body: unknown },
    onRequest: (path: string, authorization: string | null) => void
): Promise<{ code: number | null; stdout: string; stderr: string }> => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-secret-input-'))
    const server = createServer((req, res) => {
        const path = req.url ?? ''
        onRequest(path, req.headers.authorization ?? null)
        const { status, body } = handleRequest(path)
        res.writeHead(status, { 'content-type': 'application/json' })
        res.end(JSON.stringify(body))
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address() as AddressInfo
    const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
    const loader = fileURLToPath(
        new URL('./md-text-loader.mjs', import.meta.url)
    )
    const child = spawn(
        process.execPath,
        [
            '--import',
            'tsx',
            '--import',
            loader,
            entry,
            '--api-url',
            `http://127.0.0.1:${address.port}`,
            '--token',
            '-',
            ...commandArgs
        ],
        {
            cwd: fileURLToPath(new URL('..', import.meta.url)),
            env: {
                ...process.env,
                MF_CONFIG_DIR: dir,
                MF_PROFILE: 'test',
                MF_API_TOKEN: ''
            },
            stdio: ['pipe', 'pipe', 'pipe']
        }
    )
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
        stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
        stderr += chunk
    })
    child.stdin.end('nca_piped_secret\n')
    try {
        const code = await new Promise<number | null>((resolve, reject) => {
            child.once('error', reject)
            child.once('close', resolve)
        })
        return { code, stdout, stderr }
    } finally {
        await new Promise<void>((resolve, reject) =>
            server.close((error) => (error ? reject(error) : resolve()))
        )
        await rm(dir, { recursive: true, force: true })
    }
}

test('the real CLI reads a root --token - from stdin without echoing it', async () => {
    let authorization: string | null = null
    const { code, stdout, stderr } = await spawnCliWithStdinToken(
        ['whoami', '--json'],
        () => ({
            status: 200,
            body: {
                kind: 'agent-runtime',
                userId: 'user-1',
                agentId: 'agt_pipe'
            }
        }),
        (_path, auth) => {
            authorization = auth
        }
    )
    assert.equal(code, 0, stderr)
    assert.equal(authorization, 'Bearer nca_piped_secret')
    assert.equal(JSON.parse(stdout).agentId, 'agt_pipe')
    assert.doesNotMatch(`${stdout}\n${stderr}`, /nca_piped_secret/)
})

test('a root --token - is shared by every API request in one action', async () => {
    const authByPath = new Map<string, string | null>()
    const { code, stdout, stderr } = await spawnCliWithStdinToken(
        ['a2a', 'status', '--json'],
        (path) =>
            path.includes('/agent-self/a2a/peers')
                ? { status: 200, body: [] }
                : { status: 200, body: { tasks: [] } },
        (path, auth) => authByPath.set(path, auth)
    )
    assert.equal(code, 0, stderr)
    assert.equal(authByPath.size, 2, [...authByPath.keys()].join(', '))
    for (const [path, auth] of authByPath)
        assert.equal(auth, 'Bearer nca_piped_secret', path)
    assert.deepEqual(JSON.parse(stdout), { peers: [], inflight: [] })
    assert.doesNotMatch(`${stdout}\n${stderr}`, /nca_piped_secret/)
})
