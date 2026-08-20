import test from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { Command, CommanderError } from 'commander'
import { ApiError } from '@manyfold/sdk'
import {
    fail,
    normalizeCliError,
    renderCliError,
    type CliFailure
} from '../src/output'
import { handleTopLevelError, runCli } from '../src/run'

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
