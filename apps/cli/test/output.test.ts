import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Command, CommanderError } from 'commander'
import { ApiError } from '@manyfold/sdk'
import { A2aTransportError } from '@manyfold/a2a'
import {
    fail,
    normalizeCliError,
    renderCliError,
    type CliFailure
} from '../src/output'
import { handleTopLevelError, runCli } from '../src/run'
import { UsageError } from '../src/usage-error'

const apiError = (
    status: number,
    options: {
        code?: string
        message?: string
        serverMessage?: string
        name?: string
        details?: unknown
    } = {}
): ApiError => {
    // Mirrors buildApiError's invariant: message falls back to the raw body
    // only when the envelope did not parse (no serverMessage).
    const error = new ApiError({
        status,
        statusText: '',
        code: options.code ?? 'server_code',
        message:
            options.message ?? options.serverMessage ?? 'RAW_BODY_SECRET',
        serverMessage: options.serverMessage,
        body: 'RAW_BODY_SECRET',
        details: options.details ?? { token: 'DETAILS_SECRET' }
    })
    if (options.name) error.name = options.name
    return error
}

test('A2A HTTP errors retain their status, reason and authentication exit code', () => {
    for (const status of [401, 403, 429]) {
        const failure = normalizeCliError(new A2aTransportError(status, 'request refused'))
        assert.equal(failure.error.code, `a2a_http_${status}`)
        assert.equal(failure.error.status, status)
        assert.equal(failure.error.message, `A2A server returned HTTP ${status}: request refused`)
        assert.equal(failure.exitCode, status === 429 ? 1 : 3)
    }
})

test('ApiError normalization preserves safe fields and stable exit codes', () => {
    const cases: Array<{
        status: number
        exitCode: number
        hint: RegExp
    }> = [
        { status: 401, exitCode: 3, hint: /mf login/ },
        { status: 403, exitCode: 3, hint: /required scope/ },
        { status: 404, exitCode: 4, hint: /resource ID/ },
        { status: 400, exitCode: 5, hint: /--help/ },
        { status: 422, exitCode: 5, hint: /--help/ },
        { status: 409, exitCode: 1, hint: /Refresh/ },
        { status: 429, exitCode: 1, hint: /Wait/ },
        { status: 500, exitCode: 1, hint: /Try again later/ }
    ]

    for (const item of cases) {
        const failure = normalizeCliError(apiError(item.status))
        assert.equal(failure.error.code, 'server_code')
        assert.equal(failure.error.status, item.status)
        assert.match(failure.error.message, new RegExp(String(item.status)))
        assert.match(failure.error.hint ?? '', item.hint)
        assert.equal(failure.exitCode, item.exitCode)
        const serialized = JSON.stringify(failure)
        assert.doesNotMatch(serialized, /RAW_BODY_SECRET|DETAILS_SECRET/)
        assert.ok(!('body' in failure.error))
        assert.ok(!('details' in failure.error))
    }
})

// A failure a script can act on: its hint says what to do, and its details
// (the quota, the agent in the way) reach --json output. Other codes keep
// their details to themselves.
test('codes a script can act on get their own hint and keep their details', () => {
    const quota = {
        kind: 'sprites',
        current: 3,
        limit: 3,
        planName: 'Free'
    }
    const limit = normalizeCliError(
        apiError(403, {
            code: 'RUNTIME_LIMIT_REACHED',
            serverMessage: 'Stateful sandbox limit reached (3 for Free plan)',
            details: quota
        })
    )
    assert.match(
        limit.error.hint ?? '',
        /--sandbox <id\|name>.*mf sandbox delete/
    )
    assert.deepEqual(limit.error.details, quota)
    const taken = normalizeCliError(
        apiError(409, {
            code: 'AGENT_NAME_TAKEN',
            serverMessage: 'agent "x" already exists for this user',
            details: { agentId: 'agt_1' }
        })
    )
    assert.match(taken.error.hint ?? '', /mf agent get agt_1/)
    assert.deepEqual(taken.error.details, { agentId: 'agt_1' })
    const inSettings = normalizeCliError(
        apiError(400, {
            code: 'AGENT_MODEL_IN_MODEL_CONFIG',
            serverMessage:
                'Use /agents/agt_1/model-config to update claude-code models',
            details: { agentId: 'agt_1', framework: 'claude-code' }
        })
    )
    const tooOld = normalizeCliError(
        apiError(409, {
            code: 'SANDBOX_CLI_TOO_OLD',
            serverMessage:
                'sandbox-002 already runs the latest Manyfold CLI (4.8.0), which does not support this yet',
            details: {
                hostId: 'sbx_2',
                hostName: 'sandbox-002',
                cliVersion: '4.8.0',
                latestCliVersion: '4.8.0'
            }
        })
    )
    // Not the generic "contact support" of a 5xx.
    assert.match(
        tooOld.error.hint ?? '',
        /^Update it: mf sandbox update sandbox-002 \(--to <version> for a build newer than its channel's latest\), or from the Update Center/
    )
    assert.equal(
        (tooOld.error.details as { cliVersion?: string }).cliVersion,
        '4.8.0'
    )
    assert.equal(
        inSettings.error.hint,
        "claude-code keeps its model in the agent's model settings: mf model-config update agt_1 --model <model>."
    )
    const other = normalizeCliError(
        apiError(409, { code: 'SOMETHING_ELSE', serverMessage: 'no' })
    )
    assert.ok(!('details' in other.error))
    assert.match(other.error.hint ?? '', /Refresh/)
})

// The runner these codes are about lives inside the sandbox. Pointing at
// `mf daemon` (the daemon on this computer) sent a tester the wrong way.
test('sandbox runner failures say where the runner is and what to fix', () => {
    const unreachable = normalizeCliError(
        apiError(503, {
            code: 'SANDBOX_API_UNREACHABLE',
            serverMessage:
                'a sandbox cannot reach this API at http://localhost:7110/api',
            details: { apiUrl: 'http://localhost:7110/api' }
        })
    )
    assert.match(
        unreachable.error.hint ?? '',
        /at http:\/\/localhost:7110\/api\. Set PUBLIC_API_BASE_URL .*Nothing was created\./
    )
    assert.deepEqual(unreachable.error.details, {
        apiUrl: 'http://localhost:7110/api'
    })
    const notConnected = normalizeCliError(
        apiError(503, {
            code: 'SANDBOX_RUNNER_NOT_CONNECTED',
            serverMessage: "the new sandbox's runner did not connect",
            details: {
                hostId: 'sbx_1',
                apiUrl: 'https://tunnel.example.com/api',
                reason: 'runner_unavailable'
            }
        })
    )
    assert.match(
        notConnected.error.hint ?? '',
        /inside the new sandbox .*https:\/\/tunnel\.example\.com\/api/
    )
    for (const failure of [
        unreachable,
        notConnected,
        normalizeCliError(
            apiError(503, {
                code: 'SANDBOX_DAEMON_OFFLINE',
                serverMessage: 'sandbox sbx_1 has no reachable daemon'
            })
        )
    ])
        assert.doesNotMatch(failure.error.hint ?? '', /mf daemon/)
})

test('ApiError uses a server message but never an unparsed response body', () => {
    const withMessage = normalizeCliError(
        apiError(422, { serverMessage: 'title is required' })
    )
    assert.equal(withMessage.error.message, 'title is required')

    const withoutMessage = normalizeCliError(apiError(500))
    assert.equal(
        withoutMessage.error.message,
        'Manyfold API request failed with status 500'
    )
    assert.doesNotMatch(JSON.stringify(withoutMessage), /RAW_BODY_SECRET/)
})

test('the caller prefix on an envelope-derived message is preserved', () => {
    // The SDK builds 'daemon register: <server cause>'; stripping it back to
    // the bare serverMessage loses which call failed.
    const failure = normalizeCliError(
        apiError(500, {
            message: 'daemon register: PostgresError 23505',
            serverMessage: 'PostgresError 23505'
        })
    )
    assert.equal(failure.error.message, 'daemon register: PostgresError 23505')
})

test('a 5xx with a traceId points at support, not at retrying', () => {
    // Some 5xx failures are permanent — 'Try again later' misleads. With a
    // traceId the user can hand support something actionable instead.
    const withTrace = normalizeCliError(
        apiError(500, {
            serverMessage: 'boom',
            details: { traceId: 'abc123trace' }
        })
    )
    assert.match(withTrace.error.hint ?? '', /abc123trace/)
    assert.doesNotMatch(withTrace.error.hint ?? '', /Try again later/)

    const withoutTrace = normalizeCliError(
        apiError(500, { serverMessage: 'boom' })
    )
    assert.match(withoutTrace.error.hint ?? '', /Try again later/)
})

test('command-specific ApiError subclasses keep their safe message', () => {
    const custom = apiError(403, {
        message: 'request permission with mf auth ensure',
        name: 'CommandAuthError'
    })
    const failure = normalizeCliError(custom)
    assert.equal(
        failure.error.message,
        'request permission with mf auth ensure'
    )
    assert.equal(failure.exitCode, 3)
})

test('network failures have specific codes, actionable hints, and exit 2', () => {
    const withCause = (code: string): TypeError =>
        new TypeError('fetch failed', {
            cause: Object.assign(new Error('transport failed'), { code })
        })
    const cases: Array<[Error, string, RegExp]> = [
        [withCause('ETIMEDOUT'), 'network_timeout', /MF_HTTP_TIMEOUT/],
        [withCause('ENOTFOUND'), 'network_dns', /MF_API_URL/],
        [withCause('ECONNREFUSED'), 'network_refused', /reachable/],
        [withCause('CERT_HAS_EXPIRED'), 'network_tls', /certificates/],
        [withCause('ECONNRESET'), 'network_offline', /network connection/],
        [new TypeError('fetch failed'), 'network_offline', /network connection/]
    ]
    const aborted = new Error('request aborted')
    aborted.name = 'AbortError'
    cases.push([aborted, 'network_timeout', /MF_HTTP_TIMEOUT/])

    for (const [error, code, hint] of cases) {
        const failure = normalizeCliError(error)
        assert.equal(failure.error.code, code)
        assert.match(failure.error.hint ?? '', hint)
        assert.equal(failure.exitCode, 2)
        assert.doesNotMatch(failure.error.message, /transport failed/)
    }
})

test('Commander and unknown local errors have distinct stable fallbacks', () => {
    const usage = normalizeCliError(
        new CommanderError(1, 'commander.unknownOption', 'unknown option')
    )
    assert.deepEqual(usage, {
        error: {
            code: 'invalid_usage',
            message: 'unknown option',
            hint: 'Run the command with --help to see the expected usage.'
        },
        exitCode: 5
    })

    assert.deepEqual(normalizeCliError(new Error('local failure')), {
        error: { code: 'cli_error', message: 'local failure' },
        exitCode: 1
    })
})

test('a UsageError is a usage failure however far it travels', () => {
    assert.deepEqual(normalizeCliError(new UsageError('pass --name')), {
        error: {
            code: 'invalid_usage',
            message: 'pass --name',
            hint: 'Run the command with --help to see the expected usage.'
        },
        exitCode: 5
    })
})

const captureConsoleErrors = async (
    fn: () => Promise<void> | void
): Promise<string[]> => {
    const previous = console.error
    const lines: string[] = []
    console.error = ((...args: unknown[]) => {
        lines.push(args.map(String).join(' '))
    }) as typeof console.error
    try {
        await fn()
        return lines
    } finally {
        console.error = previous
    }
}

test('local fail and the top-level handler emit the same safe JSON envelope', async () => {
    const previousExitCode = process.exitCode
    const error = apiError(401, { serverMessage: 'sign in required' })
    try {
        process.exitCode = 0
        const local = await captureConsoleErrors(() =>
            fail({ json: true }, error)
        )
        assert.equal(process.exitCode, 3)

        process.exitCode = 0
        const top = await captureConsoleErrors(async () => {
            const exitCode = await handleTopLevelError(
                new Command(),
                error,
                true
            )
            assert.equal(exitCode, 3)
        })
        assert.equal(process.exitCode, 3)
        assert.deepEqual(top, local)
        const parsed = JSON.parse(top[0] ?? '') as CliFailure
        assert.equal(parsed.error.code, 'server_code')
        assert.equal(parsed.error.status, 401)
        assert.doesNotMatch(top.join('\n'), /RAW_BODY_SECRET|DETAILS_SECRET/)
    } finally {
        process.exitCode = previousExitCode
    }
})

test('explicit account guidance is preserved in JSON and human output', async () => {
    const extra = {
        hint: 'approve the requested scopes',
        scopes: ['channels:edit'],
        consentUrl: 'https://example.test/consent'
    }
    const jsonLines = await captureConsoleErrors(() => {
        assert.equal(
            renderCliError({ json: true }, new Error('denied'), extra),
            1
        )
    })
    const parsed = JSON.parse(jsonLines[0] ?? '') as CliFailure
    assert.deepEqual(parsed.error, {
        code: 'cli_error',
        message: 'denied',
        ...extra
    })

    const humanLines = await captureConsoleErrors(() => {
        renderCliError({}, new Error('denied'), extra)
    })
    assert.match(humanLines.join('\n'), /channels:edit/)
    assert.match(humanLines.join('\n'), /https:\/\/example\.test\/consent/)
})

const captureRun = async (
    argv: string[]
): Promise<{
    stdout: string
    stderr: string
    exitCode: typeof process.exitCode
}> => {
    const previousOut = process.stdout.write
    const previousErr = process.stderr.write
    const previousConsoleError = console.error
    const previousExitCode = process.exitCode
    let stdout = ''
    let stderr = ''
    process.stdout.write = ((chunk: string | Uint8Array) => {
        stdout += String(chunk)
        return true
    }) as typeof process.stdout.write
    process.stderr.write = ((chunk: string | Uint8Array) => {
        stderr += String(chunk)
        return true
    }) as typeof process.stderr.write
    console.error = ((...args: unknown[]) => {
        stderr += `${args.map(String).join(' ')}\n`
    }) as typeof console.error
    process.exitCode = 0
    try {
        await runCli(argv)
        return { stdout, stderr, exitCode: process.exitCode }
    } finally {
        process.stdout.write = previousOut
        process.stderr.write = previousErr
        console.error = previousConsoleError
        process.exitCode = previousExitCode
    }
}

test('JSON-mode Commander failures emit one envelope without plain prose', async () => {
    for (const argv of [
        ['node', 'mf', 'agent', 'list', '--json', '--bogus'],
        ['node', 'mf', 'runtime', 'get', '--json']
    ]) {
        const result = await captureRun(argv)
        assert.equal(result.stdout, '')
        assert.equal(result.exitCode, 5)
        const parsed = JSON.parse(result.stderr) as CliFailure
        assert.equal(parsed.error.code, 'invalid_usage')
        assert.match(parsed.error.hint ?? '', /--help/)
        assert.equal(result.stderr.trim().split('\n').length, 1)
    }
})

test('human-mode Commander usage failures keep commander prose and exit 5', async () => {
    const result = await captureRun(['node', 'mf', 'agent', 'list', '--bogus'])
    assert.equal(result.stdout, '')
    assert.equal(result.exitCode, 5)
    assert.match(result.stderr, /unknown option '--bogus'/)
    assert.doesNotMatch(result.stderr, /cli Error:/)
})

test('a usage mistake an action finds itself exits 5 in both output modes', async () => {
    const human = await captureRun([
        'node',
        'mf',
        'channels',
        'update',
        'chn_1'
    ])
    assert.equal(human.stdout, '')
    assert.equal(human.exitCode, 5)
    assert.equal(
        human.stderr,
        'error: pass at least one of --label, --status, --config, --credentials\n'
    )

    const json = await captureRun([
        'node',
        'mf',
        'channels',
        'update',
        'chn_1',
        '--json'
    ])
    assert.equal(json.stdout, '')
    assert.equal(json.exitCode, 5)
    const parsed = JSON.parse(json.stderr) as CliFailure
    assert.equal(parsed.error.code, 'invalid_usage')
    assert.match(parsed.error.message, /^pass at least one of --label/)
    assert.equal(json.stderr.trim().split('\n').length, 1)
})

test('JSON-mode help remains a successful human help flow', async () => {
    const result = await captureRun([
        'node',
        'mf',
        'agent',
        'list',
        '--json',
        '--help'
    ])
    assert.equal(result.exitCode, 0)
    assert.match(result.stdout, /Usage: mf agent list/)
    assert.equal(result.stderr, '')
})

test('normal entrypoint help and version still exit successfully', () => {
    const entry = fileURLToPath(new URL('../src/index.ts', import.meta.url))
    const loader = fileURLToPath(
        new URL('./md-text-loader.mjs', import.meta.url)
    )
    const base = ['--import', 'tsx', '--import', loader, entry]
    const help = spawnSync(process.execPath, [...base, '--help'], {
        encoding: 'utf8'
    })
    assert.equal(help.status, 0, help.stderr)
    assert.match(help.stdout, /Usage: mf/)
    assert.equal(help.stderr, '')

    const version = spawnSync(process.execPath, [...base, '--version'], {
        encoding: 'utf8'
    })
    assert.equal(version.status, 0, version.stderr)
    assert.match(version.stdout, /^\d+\.\d+\.\d+/)
    assert.equal(version.stderr, '')
})
