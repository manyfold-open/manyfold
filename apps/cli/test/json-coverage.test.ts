import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { Command } from 'commander'
import { buildProgram } from '../src/program'

// Leaf commands intentionally WITHOUT `--json`: raw byte streams, unbounded
// text streams, or interactive/long-lived flows. Each entry is the full command
// path. Adding `--json` to any of these is a deliberate choice — delete it from
// here when that happens.
const JSON_EXEMPT = new Set<string>([
    'files read', // streams raw file bytes to stdout / --output
    'daemon logs', // tails a text log (--follow)
    'daemon start', // long-lived foreground / init-unit install
    'daemon register', // interactive daemon enrolment
    'daemon stop', // progressive teardown output (json deferred, see B3)
    'setup', // interactive onboarding (browser login + init-unit install)
    'update' // interactive self-update (json deferred)
])

const commandPath = (cmd: Command): string => {
    const parts: string[] = []
    let cur: Command | undefined = cmd
    while (cur && cur.parent) {
        parts.unshift(cur.name())
        cur = cur.parent ?? undefined
    }
    return parts.join(' ')
}

const collectLeaves = (cmd: Command, out: Command[]): void => {
    if (cmd.commands.length === 0) {
        out.push(cmd)
        return
    }
    for (const sub of cmd.commands) collectLeaves(sub, out)
}

const hasJsonOption = (cmd: Command): boolean =>
    cmd.options.some((o) => o.long === '--json')

const allLeaves = (): Command[] => {
    const out: Command[] = []
    for (const top of buildProgram().commands) collectLeaves(top, out)
    return out
}

test('every leaf command supports --json unless explicitly exempt', () => {
    const missing = allLeaves()
        .filter((leaf) => !JSON_EXEMPT.has(commandPath(leaf)))
        .filter((leaf) => !hasJsonOption(leaf))
        .map(commandPath)
    assert.deepEqual(
        missing,
        [],
        `leaf commands missing --json (add it, or add to JSON_EXEMPT with a reason): ${missing.join(', ')}`
    )
})

test('JSON_EXEMPT entries are real leaves that still lack --json', () => {
    const byPath = new Map(allLeaves().map((l) => [commandPath(l), l]))
    for (const path of JSON_EXEMPT) {
        const leaf = byPath.get(path)
        assert.ok(
            leaf,
            `JSON_EXEMPT lists '${path}' which is not a leaf command`
        )
        assert.ok(
            !hasJsonOption(leaf as Command),
            `'${path}' now has --json — remove it from JSON_EXEMPT`
        )
    }
})

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

const captureOutput = async (
    fn: () => Promise<void>
): Promise<{ out: string[]; err: string[] }> => {
    const prevLog = console.log
    const prevErr = console.error
    const out: string[] = []
    const err: string[] = []
    console.log = ((...args: unknown[]) => {
        out.push(args.map(String).join(' '))
    }) as typeof console.log
    console.error = ((...args: unknown[]) => {
        err.push(args.map(String).join(' '))
    }) as typeof console.error
    try {
        await fn()
        return { out, err }
    } finally {
        console.log = prevLog
        console.error = prevErr
    }
}

const runCli = async (
    args: string[],
    fetchImpl: typeof fetch
): Promise<{
    out: string[]
    err: string[]
    exitCode: number | string | undefined
}> => {
    const dir = await mkdtemp(join(tmpdir(), 'mf-cli-json-'))
    const previousFetch = globalThis.fetch
    const previousExitCode = process.exitCode
    process.exitCode = 0
    globalThis.fetch = fetchImpl
    try {
        const captured = await captureOutput(() =>
            withEnv(
                {
                    MF_CONFIG_DIR: dir,
                    MF_PROFILE: 'test',
                    MF_API_TOKEN: 'nca_rt_env',
                    MF_AGENT_ID: 'agt_env'
                },
                async () => {
                    const program = buildProgram()
                    await program.parseAsync(
                        [
                            'node',
                            'mf',
                            '--api-url',
                            'https://api.test/api',
                            ...args
                        ],
                        { from: 'node' }
                    )
                }
            )
        )
        return { ...captured, exitCode: process.exitCode }
    } finally {
        globalThis.fetch = previousFetch
        process.exitCode = previousExitCode
        await rm(dir, { recursive: true, force: true })
    }
}

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    })

test('agent list --json prints a JSON array', async () => {
    const { out } = await runCli(['agent', 'list', '--json'], (async () =>
        json([
            {
                id: 'agt_1',
                name: 'demo',
                framework: 'claude-code',
                runtime: 'sprite',
                status: 'ready'
            }
        ])) as typeof fetch)
    const parsed = JSON.parse(out.join('\n'))
    assert.ok(Array.isArray(parsed))
    assert.equal(parsed[0].id, 'agt_1')
})

test('channels get --json keeps secrets redacted', async () => {
    const { out } = await runCli(
        ['channels', 'get', 'chn_1', '--json'],
        (async () =>
            json({
                id: 'chn_1',
                provider: 'telegram',
                label: 'demo',
                config: {},
                credentials: { token: 'SUPER_SECRET' },
                apiKey: 'ALSO_SECRET'
            })) as typeof fetch
    )
    const text = out.join('\n')
    assert.match(text, /\[redacted\]/)
    assert.doesNotMatch(text, /SUPER_SECRET/)
    assert.doesNotMatch(text, /ALSO_SECRET/)
})

test('skills installed forwards the requested agent filter', async () => {
    let seenUrl = ''
    const { out } = await runCli(
        ['skills', 'installed', '--agent-id', 'agt_target', '--json'],
        (async (input) => {
            seenUrl = String(input)
            return json([])
        }) as typeof fetch
    )

    assert.equal(
        seenUrl,
        'https://api.test/api/skills/installed?agentId=agt_target'
    )
    assert.deepEqual(JSON.parse(out.join('\n')), [])
})

test('a2a exposure enable targets the current agent context', async () => {
    let seenUrl = ''
    let seenMethod = ''
    let seenBody: unknown
    const { out } = await runCli(
        ['a2a', 'exposure', 'enable', '--json'],
        (async (input, init) => {
            seenUrl = String(input)
            seenMethod = init?.method ?? 'GET'
            seenBody = JSON.parse(String(init?.body))
            return json({
                agentId: 'agt_env',
                enabled: true,
                cardUrl:
                    'https://api.test/api/a2a/agents/agt_env/agent-card.json',
                rpcUrl: 'https://api.test/api/a2a/agents/agt_env/rpc'
            })
        }) as typeof fetch
    )

    assert.equal(
        seenUrl,
        'https://api.test/api/agent-self/a2a/exposure?agentId=agt_env'
    )
    assert.equal(seenMethod, 'PUT')
    assert.deepEqual(seenBody, { enabled: true })
    assert.equal(JSON.parse(out.join('\n')).enabled, true)
})

test('a2a external caller prints only the one-time token to stdout', async () => {
    let seenBody: unknown
    const { out, err } = await runCli(
        [
            'a2a',
            'callers',
            'add',
            '--external',
            '--name',
            'zapier',
            '--expires-in-days',
            '7'
        ],
        (async (_input, init) => {
            seenBody = JSON.parse(String(init?.body))
            return json(
                {
                    kind: 'external',
                    agentId: 'agt_env',
                    token: 'nca_one_time_secret',
                    tokenId: 'pat_external',
                    scopes: ['a2a:edit'],
                    callerAgentId: null,
                    expiresAt: '2026-08-04T00:00:00.000Z',
                    cardUrl:
                        'https://api.test/api/a2a/agents/agt_env/agent-card.json',
                    rpcUrl: 'https://api.test/api/a2a/agents/agt_env/rpc'
                },
                201
            )
        }) as typeof fetch
    )

    assert.deepEqual(seenBody, {
        kind: 'external',
        name: 'zapier',
        expiresInDays: 7
    })
    assert.deepEqual(out, ['nca_one_time_secret'])
    assert.doesNotMatch(err.join('\n'), /nca_one_time_secret/)
    assert.match(err.join('\n'), /shown once/)
    assert.match(err.join('\n'), /\/rpc/)
})

test('a2a peer caller add uses the no-plaintext response', async () => {
    let seenBody: unknown
    const { out } = await runCli(
        [
            'a2a',
            'callers',
            'add',
            '--caller-agent-id',
            'agt_peer',
            '--replace-existing',
            '--json'
        ],
        (async (_input, init) => {
            seenBody = JSON.parse(String(init?.body))
            return json(
                {
                    kind: 'peer',
                    agentId: 'agt_env',
                    callerAgentId: 'agt_peer',
                    tokenId: 'pat_peer',
                    expiresAt: null
                },
                201
            )
        }) as typeof fetch
    )

    assert.deepEqual(seenBody, {
        kind: 'peer',
        callerAgentId: 'agt_peer',
        replaceExisting: true
    })
    const parsed = JSON.parse(out.join('\n'))
    assert.equal(parsed.tokenId, 'pat_peer')
    assert.equal('token' in parsed, false)
})

test('a2a caller revoke is target-contextual and emits a stable JSON result', async () => {
    let seenUrl = ''
    let seenMethod = ''
    const { out } = await runCli(
        ['a2a', 'callers', 'revoke', 'pat_1', '--yes', '--json'],
        (async (input, init) => {
            seenUrl = String(input)
            seenMethod = init?.method ?? 'GET'
            return new Response(null, { status: 204 })
        }) as typeof fetch
    )

    assert.equal(
        seenUrl,
        'https://api.test/api/agent-self/a2a/callers/pat_1?agentId=agt_env'
    )
    assert.equal(seenMethod, 'DELETE')
    assert.deepEqual(JSON.parse(out.join('\n')), { ok: true, id: 'pat_1' })
})

test('a2a caller revoke refuses to run without explicit confirmation', async () => {
    let called = false
    await assert.rejects(
        () =>
            runCli(
                ['a2a', 'callers', 'revoke', 'pat_1', '--json'],
                (async () => {
                    called = true
                    return new Response(null, { status: 204 })
                }) as typeof fetch
            ),
        /without --yes/
    )
    assert.equal(called, false)
})

test('whoami --json emits a JSON error and exits non-zero on failure', async () => {
    const { err, exitCode } = await runCli(['whoami', '--json'], (async () =>
        json({ message: 'unauthorized' }, 401)) as typeof fetch)
    const parsed = JSON.parse(err.join('\n'))
    assert.equal(parsed.error.code, 'unauthorized')
    assert.equal(parsed.error.status, 401)
    assert.equal(parsed.error.message, 'unauthorized')
    assert.match(parsed.error.hint, /mf login/)
    assert.equal(exitCode, 3)
})

test('login --token --json prints a result without echoing the token', async () => {
    const { out } = await runCli(
        ['login', '--token', 'nca_secret_token', '--json'],
        (async () =>
            json({ id: 'user-1', email: 'demo@example.com' })) as typeof fetch
    )
    const text = out.join('\n')
    const parsed = JSON.parse(text)
    assert.equal(parsed.ok, true)
    assert.doesNotMatch(text, /nca_secret_token/)
    assert.ok(!('token' in parsed))
})
