import { CommanderError, type Command } from 'commander'
import kleur from 'kleur'
import { ApiError } from '@manyfold/sdk'
import { resolveConfigPath, resolveProfile } from '@/config'

// Single source of truth for `--json`. Register the flag with jsonOption(cmd),
// then read it through emit(opts, payload, renderHuman). Every command prints
// the raw, unwrapped payload (2-space indented) so output stays scriptable and
// matches the shape the first wave of --json commands already shipped.
export const jsonOption = (cmd: Command): Command =>
    cmd.option('--json', 'output the result as JSON', false)

export const printJson = (payload: unknown): void => {
    console.log(JSON.stringify(payload ?? null, null, 2))
}

export const emit = (
    opts: { json?: boolean },
    payload: unknown,
    renderHuman: () => void
): void => {
    if (opts?.json) {
        printJson(payload)
        return
    }
    renderHuman()
}

export interface CliErrorDetail {
    code: string
    status?: number
    message: string
    hint?: string
    scopes?: string[]
    consentUrl?: string
}

export interface CliFailure {
    error: CliErrorDetail
    exitCode: number
}

export interface CliErrorExtra {
    hint?: string
    scopes?: string[]
    consentUrl?: string
}

type NetworkErrorCode =
    | 'network_timeout'
    | 'network_dns'
    | 'network_refused'
    | 'network_tls'
    | 'network_offline'

const causeCode = (error: unknown): string | undefined => {
    let current = error
    const seen = new Set<unknown>()
    while (current && typeof current === 'object' && !seen.has(current)) {
        seen.add(current)
        const code = (current as { code?: unknown }).code
        if (typeof code === 'string') return code
        current = (current as { cause?: unknown }).cause
    }
    return undefined
}

const networkErrorCode = (error: unknown): NetworkErrorCode | undefined => {
    if (!(error instanceof Error)) return undefined
    if (error.name === 'AbortError' || error.name === 'TimeoutError')
        return 'network_timeout'
    const code = causeCode(error)
    if (
        code?.startsWith('ERR_TLS_') ||
        code?.startsWith('CERT_') ||
        code?.startsWith('DEPTH_') ||
        code?.startsWith('UNABLE_')
    )
        return 'network_tls'
    if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return 'network_dns'
    if (code === 'ECONNREFUSED') return 'network_refused'
    if (
        code === 'ABORT_ERR' ||
        code === 'ETIMEDOUT' ||
        code === 'UND_ERR_CONNECT_TIMEOUT' ||
        code === 'UND_ERR_HEADERS_TIMEOUT'
    )
        return 'network_timeout'
    if (
        code === 'ECONNRESET' ||
        code === 'EHOSTUNREACH' ||
        code === 'ENETUNREACH' ||
        code === 'UND_ERR_SOCKET'
    )
        return 'network_offline'
    if (error instanceof TypeError && error.message === 'fetch failed')
        return 'network_offline'
    return undefined
}

const exitCodeForStatus = (status?: number): number => {
    if (status === 401 || status === 403) return 3
    if (status === 404) return 4
    if (status === 400 || status === 422) return 5
    return 1
}

// error.message carries the caller's prefix (which call failed) plus the
// server's cause — don't strip it back down to the bare serverMessage. But
// only when it is envelope-derived (serverMessage present) or curated by a
// subclass: otherwise message holds the unparsed response body, and that
// never belongs on the terminal.
const apiErrorMessage = (error: ApiError): string =>
    error.name !== 'ApiError' || error.serverMessage
        ? error.message
        : `Manyfold API request failed with status ${error.status}`

const traceIdOf = (error: ApiError): string | undefined => {
    const details = error.details as { traceId?: unknown } | undefined
    return typeof details?.traceId === 'string' ? details.traceId : undefined
}

// A 401 is profile-shaped since ADR-0014: signing in fixes the CURRENT
// profile only, so name it (and its config path) instead of leaving the user
// to guess which credentials file went stale. Resolution can itself throw on
// an invalid MF_PROFILE — an error hint must never do that.
const profileHint = (): string => {
    try {
        return ` (profile '${resolveProfile()}', config ${resolveConfigPath()})`
    } catch {
        return ''
    }
}

const apiErrorHint = (error: ApiError): string | undefined => {
    const status = error.status
    if (status === 401) return `Run mf login to sign in again${profileHint()}.`
    if (status === 403)
        return 'Check that this token has the required scope and resource access.'
    if (status === 404)
        return 'Check the resource ID or run the matching list command.'
    if (status === 400 || status === 422)
        return 'Check the command arguments and run with --help for the expected format.'
    if (status === 409)
        return 'Refresh the resource state, then try the command again.'
    if (status === 429) return 'Wait a moment before retrying the request.'
    if (status >= 500) {
        // A 5xx is not necessarily transient — with a trace id in hand,
        // point at support instead of promising a retry will help.
        const traceId = traceIdOf(error)
        return traceId
            ? `Contact support with trace id ${traceId} if this keeps failing.`
            : 'Try again later; contact support if the problem persists.'
    }
    return undefined
}

const networkErrorHint = (code: NetworkErrorCode): string => {
    if (code === 'network_timeout')
        return 'The request timed out. Try again or raise MF_HTTP_TIMEOUT.'
    if (code === 'network_dns')
        return 'Check your network connection and the --api-url or MF_API_URL setting.'
    if (code === 'network_refused')
        return 'Check that the Manyfold API address is correct and reachable.'
    if (code === 'network_tls')
        return 'Check your system clock and trusted CA certificates.'
    return 'Check your network connection and try again.'
}

const errorExtra = (extra: CliErrorExtra): CliErrorExtra => ({
    ...(extra.hint ? { hint: extra.hint } : {}),
    ...(extra.scopes ? { scopes: extra.scopes } : {}),
    ...(extra.consentUrl ? { consentUrl: extra.consentUrl } : {})
})

export const normalizeCliError = (
    error: unknown,
    extra: CliErrorExtra = {}
): CliFailure => {
    if (error instanceof CommanderError) {
        return {
            error: {
                code: 'invalid_usage',
                message: error.message,
                ...errorExtra({
                    hint: 'Run the command with --help to see the expected usage.',
                    ...extra
                })
            },
            exitCode: 5
        }
    }
    if (error instanceof ApiError) {
        return {
            error: {
                code: error.code,
                status: error.status,
                message: apiErrorMessage(error),
                ...errorExtra({ hint: apiErrorHint(error), ...extra })
            },
            exitCode: exitCodeForStatus(error.status)
        }
    }
    const networkCode = networkErrorCode(error)
    if (networkCode) {
        return {
            error: {
                code: networkCode,
                message:
                    'Could not reach the Manyfold API. Check your network connection and API URL.',
                ...errorExtra({ hint: networkErrorHint(networkCode), ...extra })
            },
            exitCode: 2
        }
    }
    return {
        error: {
            code: 'cli_error',
            message: error instanceof Error ? error.message : String(error),
            ...errorExtra(extra)
        },
        exitCode: 1
    }
}

export const renderCliError = (
    opts: { json?: boolean; humanPrefix?: string },
    error: unknown,
    extra: CliErrorExtra = {}
): number => {
    const failure = normalizeCliError(error, extra)
    if (opts.json) {
        console.error(JSON.stringify({ error: failure.error }))
        return failure.exitCode
    }
    console.error(
        kleur.red(`${opts.humanPrefix ?? ''}${failure.error.message}`)
    )
    if (failure.error.scopes && failure.error.consentUrl) {
        console.error(
            kleur.yellow(
                `\nAccount scope needs permission (${failure.error.scopes.join(', ')}).`
            )
        )
        console.error(`Consent URL: ${kleur.cyan(failure.error.consentUrl)}`)
    } else if (failure.error.scopes) {
        console.error(
            kleur.dim(
                `\nThis is an account-scope action — grant it with: mf auth ensure --scopes ${failure.error.scopes.join(',')}`
            )
        )
    } else if (failure.error.consentUrl) {
        console.error(`Consent URL: ${kleur.cyan(failure.error.consentUrl)}`)
    } else if (failure.error.hint) {
        console.error(kleur.dim(failure.error.hint))
    }
    return failure.exitCode
}

// One error sink for command actions that catch locally (whoami, a2a, login).
export const fail = (
    opts: { json?: boolean },
    error: unknown,
    extra?: CliErrorExtra
): void => {
    process.exitCode = renderCliError(opts, error, extra)
}

// The top-level error handler runs outside any parsed command opts, so it reads
// the intent straight off argv.
export const argvWantsJson = (argv: string[] = process.argv): boolean =>
    argv.includes('--json')
