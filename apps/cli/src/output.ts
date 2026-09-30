import { CommanderError, type Command } from 'commander'
import kleur from 'kleur'
import { ApiError } from '@manyfold/sdk'
import { A2aError, A2aTransportError } from '@manyfold/a2a'
import { resolveConfigPath, resolveProfile } from '@/config'
import { UsageError } from '@/usage-error'

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
    details?: unknown
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
    // The standalone mf runs on Bun, whose fetch reports a name that does not
    // resolve and a closed port alike as ConnectionRefused.
    if (code === 'ECONNREFUSED' || code === 'ConnectionRefused')
        return 'network_refused'
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
        code === 'UND_ERR_SOCKET' ||
        code === 'FailedToOpenSocket' ||
        code === 'ConnectionClosed'
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

// What to do next for a failure a script can act on, by its code; these
// codes, and every plan limit or quota, also pass their `details` through to
// `--json` output.
type CodeHint = (details: Record<string, unknown>) => string

// " (2 of 2 on the Free plan)", when the API sent the numbers.
const planUse = (
    details: Record<string, unknown>,
    unit: (value: number) => string = String
): string =>
    typeof details.current === 'number' &&
    typeof details.limit === 'number' &&
    typeof details.planName === 'string'
        ? ` (${unit(details.current)} of ${unit(details.limit)} on the ${details.planName} plan)`
        : ''

const CODE_HINTS: Record<string, CodeHint> = {
    RUNTIME_LIMIT_REACHED: () =>
        'Every sandbox your plan includes is in use: add the agent to one with --sandbox <id|name>, or free one with mf sandbox list and mf sandbox delete.',
    AGENT_NAME_TAKEN: (details) =>
        typeof details.agentId === 'string'
            ? `Pick another name, or look at that agent with mf agent get ${details.agentId}.`
            : 'Pick another name.',
    AGENT_CREATE_IN_PROGRESS: () =>
        'A create of this name with other settings is under way: wait for it to finish, or pick another name.',
    AGENT_CREATE_INTERRUPTED: (details) =>
        typeof details.hostId === 'string'
            ? `Run the command again to start over; mf sandbox list shows the sandbox it may have left (${details.hostId}).`
            : 'Run the command again to start over.',
    AGENT_CREATE_NOT_FOUND: () =>
        'The create this connection followed is gone; check mf agent list before running the command again.',
    AGENT_MODEL_IN_MODEL_CONFIG: (details) =>
        `${typeof details.framework === 'string' ? details.framework : 'This framework'} keeps its model in the agent's model settings: mf model-config update ${typeof details.agentId === 'string' ? details.agentId : '<agent-id>'} --model <model>.`,
    SANDBOX_NOT_FOUND: () => 'Check the sandbox with mf sandbox list.',
    session_held_by_terminal: () =>
        'The session is open in a terminal: close it there or take the session back in the web chat, or leave out --session / --continue to start a new session.',
    session_import_pending: () =>
        'The session is still taking in what its terminal wrote; try again in a moment.',
    SANDBOX_API_UNREACHABLE: (details) =>
        `A sandbox's runner cannot reach this API${typeof details.apiUrl === 'string' ? ` at ${details.apiUrl}` : ''}. Set PUBLIC_API_BASE_URL on the API to an address reachable from the internet (for a local stack, a tunnel URL) and restart it. Nothing was created.`,
    SANDBOX_RUNNER_NOT_CONNECTED: (details) =>
        `The runner inside the new sandbox (not a daemon on this computer) could not connect to ${typeof details.apiUrl === 'string' ? details.apiUrl : 'this API'}. Check that the address is reachable from the internet (a stopped tunnel, a firewall); the sandbox was removed, so try again once it is.`,
    SANDBOX_CLI_TOO_OLD: (details) =>
        `Update it: mf sandbox update ${typeof details.hostName === 'string' ? details.hostName : typeof details.hostId === 'string' ? details.hostId : '<sandbox>'} (--to <version> for a build newer than its channel's latest), or from the Update Center in the web app.`,
    SANDBOX_DAEMON_OFFLINE: () =>
        'The runner inside the sandbox (not a daemon on this computer) is not answering. Try again in a minute; mf sandbox list shows the sandbox.',
    CHANNEL_LIMIT_REACHED: (details) =>
        `Every channel your plan includes is in use${planUse(details)}: delete one with mf channels delete <id> (mf channels list shows them), or upgrade your plan.`,
    AUTOMATION_LIMIT_REACHED: (details) =>
        `Every automation your plan includes is in use${planUse(details)}: delete one with mf automations delete <id> (mf automations list shows them), or upgrade your plan.`,
    AUTOMATION_RUN_QUOTA_REACHED: (details) =>
        `The automation runs included this billing period are used up${planUse(details)}${typeof details.resetAt === 'string' ? `; they renew at ${details.resetAt}` : ''}. Upgrade your plan to keep them running.`,
    ACTIVE_HOURS_QUOTA_REACHED: (details) =>
        `The sandbox active hours included this billing period are used up${planUse(details, (hours) => `${Math.round(hours * 10) / 10}h`)}. Upgrade your plan to keep going.`,
    STORAGE_LIMIT_REACHED: (details) =>
        `Sandbox storage is full${planUse(details, (bytes) => `${(bytes / 1e9).toFixed(1)} GB`)}: free up space (mf sandbox storage-usage shows where it goes), or upgrade your plan.`,
    CONCURRENT_ACTIVE_LIMIT_REACHED: (details) =>
        `As many sandboxes as your plan runs at once are running${planUse(details)}: try again once one goes to sleep, or upgrade your plan.`,
    ALWAYS_ONLINE_AGENT_LIMIT_REACHED: (details) =>
        `Every always-online agent your plan includes is in use${planUse(details)}: remove one with mf agent delete <id>, or upgrade your plan.`,
    ALWAYS_ONLINE_LIMIT_REACHED: (details) =>
        `Every always-online computer your plan includes is in use${planUse(details)}: remove one, or upgrade your plan.`,
    a2a_peer_not_found: () =>
        'mf a2a status lists the peers this agent may call; a peer shows up once it enables exposure and grants this agent (mf a2a callers add --caller-agent-id <id>, run by the peer).',
    a2a_grant_exists: () =>
        'Pass --replace-existing to replace the active grant, or revoke it first: mf a2a callers list shows it, mf a2a callers revoke <id> removes it.',
    delegation_limit: () =>
        'Wait for one of your A2A calls to finish (mf a2a tasks list --state working shows them), then retry.',
    channel_session_archived: (details) =>
        `A deleted session stays archived: start a new one with mf channels sessions new ${typeof details.channelId === 'string' ? details.channelId : '<channelId>'} --scope-key '${typeof details.scopeKey === 'string' ? details.scopeKey : '<key>'}'.`
}

// A plan limit is a 403 like a missing scope, but no token fixes it.
const PLAN_LIMIT_CODE = /_(?:LIMIT|QUOTA)_REACHED$/

const planLimitHint: CodeHint = (details) =>
    `This is a limit of your plan, not of the token${planUse(details)}: free up what it counts, or upgrade your plan.`

const codeHint = (code: string): CodeHint | undefined =>
    CODE_HINTS[code] ?? (PLAN_LIMIT_CODE.test(code) ? planLimitHint : undefined)

const recordOf = (value: unknown): Record<string, unknown> =>
    value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}

const apiErrorHint = (error: ApiError): string | undefined => {
    const byCode = codeHint(error.code)
    if (byCode) return byCode(recordOf(error.details))
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
    if (error instanceof CommanderError || error instanceof UsageError) {
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
                ...errorExtra({ hint: apiErrorHint(error), ...extra }),
                ...(codeHint(error.code) && error.details !== undefined
                    ? { details: error.details }
                    : {})
            },
            exitCode: exitCodeForStatus(error.status)
        }
    }
    // A Manyfold A2A server puts the code of a refusal it hit (a sandbox CLI
    // too old for files, the delegation cap) in the JSON-RPC error's data.
    if (error instanceof A2aError) {
        const data = recordOf(error.data)
        if (typeof data.code === 'string') {
            const status =
                typeof data.status === 'number' ? data.status : undefined
            const hint = codeHint(data.code)
            return {
                error: {
                    code: data.code,
                    ...(status !== undefined ? { status } : {}),
                    message: error.message,
                    ...errorExtra({
                        hint: hint?.(recordOf(data.details)),
                        ...extra
                    }),
                    ...(hint && data.details !== undefined
                        ? { details: data.details }
                        : {})
                },
                exitCode: exitCodeForStatus(status)
            }
        }
    }
    if (error instanceof A2aTransportError) {
        return {
            error: {
                code: `a2a_http_${error.status}`,
                status: error.status,
                message: error.message,
                ...errorExtra(extra)
            },
            exitCode: exitCodeForStatus(error.status)
        }
    }
    const networkCode = networkErrorCode(error)
    if (networkCode) {
        // A failure its thrower put into words (an A2A endpoint that does not
        // resolve) keeps them; a bare transport failure is the Manyfold API's.
        const described =
            error instanceof Error &&
            error.cause !== undefined &&
            !(error instanceof TypeError)
        return {
            error: {
                code: networkCode,
                message: described
                    ? error.message
                    : 'Could not reach the Manyfold API. Check your network connection and API URL.',
                ...errorExtra({
                    hint: described
                        ? "Check the address and this machine's network connection."
                        : networkErrorHint(networkCode),
                    ...extra
                })
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
// the intent straight off argv, up to a `--`: what follows it is a command
// line of its own (an MCP server's).
export const argvWantsJson = (argv: string[] = process.argv): boolean => {
    const end = argv.indexOf('--')
    return (end === -1 ? argv : argv.slice(0, end)).includes('--json')
}
