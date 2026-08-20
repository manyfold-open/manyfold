import { spawn } from 'node:child_process'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { createInterface } from 'node:readline/promises'
import type { AddressInfo } from 'node:net'
import type { Command } from 'commander'
import kleur from 'kleur'
import {
    grantableScopes,
    isGrantableScope,
    type CliLoginPollResponse,
    type GrantableScope
} from '@manyfold/shared'
import { DEFAULT_API_URL } from '@/client'
import {
    clearPendingLogin,
    loadConfig,
    saveConfig,
    savePendingLogin
} from '@/config'
import { resumePendingLogin } from '@/pending-login'
import { printJson } from '@/output'
import { resolveSecretInput } from '@/secret-input'
import { createCliClient } from '@/transport'

interface LoginOptions {
    apiUrl?: string
    token?: string
    // Commander maps `--no-launch-browser` to `launchBrowser: false`, so the
    // negated name never reaches us.
    launchBrowser?: boolean
    authCode?: string
    poll?: boolean
    wait?: boolean
    resume?: boolean
    scopes?: string
    forAgent?: string
    limitToAgent?: boolean
    json?: boolean
}

interface RootOptions {
    apiUrl?: string
    token?: string
    agentId?: string
}

export type LoginMode =
    | 'token'
    | 'auth-code'
    | 'browser'
    | 'headless'
    | 'poll'
    | 'resume'

export const resolveLoginMode = (
    opts: LoginOptions,
    stdinIsTTY = Boolean(process.stdin.isTTY),
    agentContext = false
): LoginMode => {
    if (opts.resume) {
        if (opts.poll) throw new Error('--resume cannot combine with --poll')
        if (opts.token) throw new Error('--resume cannot combine with --token')
        if (opts.authCode)
            throw new Error('--resume cannot combine with --auth-code')
        return 'resume'
    }
    if (opts.wait && !opts.poll) throw new Error('--wait requires --poll')
    if (opts.poll) {
        if (opts.token) throw new Error('--poll cannot combine with --token')
        if (!opts.scopes) throw new Error('--poll requires --scopes <list>')
        return 'poll'
    }
    if (opts.scopes)
        throw new Error(
            'capability scopes are managed with `mf auth ensure --scopes <list>`; `mf login` only authenticates this machine'
        )
    if (opts.authCode) return 'auth-code'
    if (opts.token) return 'token'
    if (opts.launchBrowser === false) {
        if (!stdinIsTTY)
            throw new Error(
                '--no-launch-browser requires an interactive terminal or --auth-code <code>'
            )
        return 'headless'
    }
    if (agentContext) {
        if (opts.scopes) return 'poll'
        throw new Error(
            'agent runtimes are already authenticated; run `mf auth ensure --scopes <list>` to add capabilities'
        )
    }
    return 'browser'
}

export const shouldWaitForPollApproval = (
    opts: { wait?: boolean },
    agentContext: boolean
): boolean => opts.wait === true || !agentContext

export const parseScopes = (csv: string): GrantableScope[] => {
    const seen = new Set<GrantableScope>()
    const out: GrantableScope[] = []
    for (const part of csv.split(',')) {
        const trimmed = part.trim()
        if (!trimmed) continue
        if (!isGrantableScope(trimmed))
            throw new Error(
                `unknown grant scope: ${trimmed}\n` +
                    `valid scopes: ${grantableScopes.join(', ')}`
            )
        if (seen.has(trimmed)) continue
        seen.add(trimmed)
        out.push(trimmed)
    }
    if (out.length === 0)
        throw new Error('--scopes must list at least one grant scope')
    return out
}

export interface PollResult {
    token: string
    scopes: GrantableScope[]
    userEmail: string | null
}

export const pollUntilApproved = async (
    apiUrl: string,
    deviceCode: string,
    opts: { intervalMs: number; timeoutMs: number },
    pollFn?: (deviceCode: string) => Promise<CliLoginPollResponse>,
    nowFn: () => number = () => Date.now(),
    sleepFn: (ms: number) => Promise<void> = (ms) =>
        new Promise((r) => setTimeout(r, ms))
): Promise<PollResult> => {
    const poll =
        pollFn ??
        ((deviceCode: string) => {
            const client = createCliClient({ baseUrl: apiUrl })
            return client.auth.pollCliLogin({ deviceCode })
        })
    const deadline = nowFn() + opts.timeoutMs
    while (nowFn() < deadline) {
        const res = await poll(deviceCode)
        if (res.status === 'approved') {
            const scopes = res.scopes.filter(isGrantableScope)
            return {
                token: res.token,
                scopes,
                userEmail: res.userEmail
            }
        }
        if (res.status === 'expired')
            throw new Error('login session expired before approval')
        await sleepFn(opts.intervalMs)
    }
    throw new Error('login timed out')
}

export const parseCallbackRequestUrl = (
    rawUrl: string | undefined
): { authCode?: string; error?: string } => {
    if (!rawUrl) return { error: 'missing callback URL' }
    const url = new URL(rawUrl, 'http://127.0.0.1')
    if (url.pathname !== '/callback') return { error: 'unknown callback path' }
    const error = url.searchParams.get('error')
    if (error) return { error }
    const code = url.searchParams.get('code')
    if (!code) return { error: 'missing auth code' }
    return { authCode: code }
}

export const registerLogin = (program: Command): void => {
    program
        .command('login')
        .description('Authenticate this machine with Manyfold')
        .option('--api-url <url>', 'API base URL')
        .option(
            '--token <token>',
            'API token ("-" reads stdin; direct values may appear in shell history and process lists)'
        )
        .option(
            '--no-launch-browser',
            'print the auth URL instead of launching a browser'
        )
        .option('--auth-code <code>', 'auth code copied from the browser')
        .option(
            '--poll',
            'use the legacy device-code grant flow (requires --scopes)'
        )
        .option(
            '--wait',
            'with --poll, wait for approval before exiting'
        )
        .option(
            '--resume',
            'complete a pending poll-mode login whose process exited before approval'
        )
        .option(
            '--scopes <list>',
            'legacy --poll grant scopes (e.g. channels:read,channels:edit)'
        )
        .option(
            '--for-agent <id>',
            'legacy --poll grant target (defaults to --agent-id / $MF_AGENT_ID)'
        )
        .option(
            '--limit-to-agent',
            'request that the user limit the token to a single agent (sets the consent-page toggle default)'
        )
        .option('--json', 'output the result as JSON (token is never echoed)', false)
        .action(async (opts: LoginOptions) => {
            const current = await loadConfig()
            const root = program.opts<RootOptions>()
            const apiUrl =
                opts.apiUrl ?? root.apiUrl ?? current.apiUrl ?? DEFAULT_API_URL
            const loginOpts = {
                ...opts,
                token: resolveSecretInput(opts.token ?? root.token)
            }
            const json = opts.json === true
            // In --json mode stdout is reserved for the final result object, so
            // human progress lines are routed to stderr instead.
            const out = (line: string): void => {
                if (json) console.error(line)
                else console.log(line)
            }
            const mode = resolveLoginMode(
                loginOpts,
                Boolean(process.stdin.isTTY),
                Boolean(root.agentId)
            )

            if (mode === 'token') {
                await saveAndConfirm(apiUrl, loginOpts.token!, json)
                return
            }

            if (mode === 'auth-code') {
                const token = await exchangeAuthCode(
                    apiUrl,
                    loginOpts.authCode!
                )
                await saveAndConfirm(apiUrl, token, json)
                return
            }

            if (mode === 'resume') {
                await runResume(apiUrl, json)
                return
            }

            if (mode === 'poll') {
                const scopes = parseScopes(loginOpts.scopes!)
                const forAgent = loginOpts.forAgent ?? root.agentId
                if (!forAgent)
                    throw new Error(
                        '--for-agent or MF_AGENT_ID is required for --poll'
                    )
                const started = await startCliLogin(apiUrl, undefined, {
                    requestedScopes: scopes,
                    requestedAgentId: forAgent
                })
                if (!started.deviceCode)
                    throw new Error(
                        'API did not return a deviceCode; the API may be out of date'
                    )
                await savePendingLogin({
                    requestId: started.requestId,
                    deviceCode: started.deviceCode,
                    authUrl: started.authUrl,
                    userCode: started.userCode,
                    scopes,
                    forAgent,
                    apiUrl,
                    expiresAt: started.expiresAt
                })
                printLoginStart(started.authUrl, started.userCode, json)
                out(
                    kleur.dim(
                        'If this process exits before approval, the next mf command ' +
                            '(or `mf login --resume`) completes the login automatically.'
                    )
                )
                if (loginOpts.limitToAgent) {
                    out(
                        kleur.yellow(
                            "When approving, check 'Limit to this agent only'"
                        ) +
                            kleur.dim(
                                ` (binds the token to ${forAgent} so it cannot act on other agents)`
                            )
                    )
                }
                if (
                    !shouldWaitForPollApproval(loginOpts, Boolean(root.agentId))
                ) {
                    if (json)
                        printJson({
                            ok: false,
                            status: 'pending',
                            authUrl: started.authUrl,
                            userCode: started.userCode
                        })
                    return
                }
                const timeoutMs = Math.max(
                    1_000,
                    new Date(started.expiresAt).getTime() - Date.now()
                )
                let grant: PollResult
                try {
                    grant = await pollUntilApproved(
                        apiUrl,
                        started.deviceCode,
                        {
                            intervalMs: 2_000,
                            timeoutMs
                        }
                    )
                } catch (error) {
                    // Only a definitively dead session invalidates the pending
                    // file; transient poll failures keep it resumable.
                    if (isTerminalLoginError(error)) await clearPendingLogin()
                    throw error
                }
                await saveConfig({ apiUrl, token: grant.token })
                await clearPendingLogin()
                if (json)
                    printJson({
                        ok: true,
                        userEmail: grant.userEmail,
                        scopes: grant.scopes
                    })
                else
                    console.log(
                        kleur.green(
                            `Logged in as ${grant.userEmail ?? 'agent'} ` +
                                `(scopes: ${grant.scopes.join(', ')}). ` +
                                'Credentials saved locally.'
                        )
                    )
                return
            }

            if (mode === 'headless') {
                await runHeadlessLogin(apiUrl, json)
                return
            }

            await runBrowserLogin(apiUrl, json)
        })
}

// Shared by `mf login` (default mode) and `mf setup`: loopback callback
// server → browser → auth-code exchange → config save.
export const runBrowserLogin = async (
    apiUrl: string,
    json: boolean
): Promise<void> => {
    const callback = await createCallbackServer()
    try {
        const started = await startCliLogin(apiUrl, callback.redirectUri)
        printLoginStart(started.authUrl, started.userCode, json)
        launchBrowser(started.authUrl)
        const timeoutMs = Math.max(
            1_000,
            new Date(started.expiresAt).getTime() - Date.now()
        )
        const authCode = await callback.waitForCode(timeoutMs)
        const token = await exchangeAuthCode(apiUrl, authCode)
        await saveAndConfirm(apiUrl, token, json)
    } finally {
        await callback.close()
    }
}

// Shared by `mf login --no-launch-browser` and `mf setup --no-launch-browser`:
// no loopback redirect, so the consent page shows a copyable auth code that the
// operator pastes back into this terminal. Required when the browser runs on a
// different machine than the CLI (SSH), where 127.0.0.1 is not shared.
export const runHeadlessLogin = async (
    apiUrl: string,
    json: boolean
): Promise<void> => {
    const started = await startCliLogin(apiUrl)
    printLoginStart(started.authUrl, started.userCode, json)
    const authCode = await promptAuthCode()
    const token = await exchangeAuthCode(apiUrl, authCode)
    await saveAndConfirm(apiUrl, token, json)
}

const startCliLogin = async (
    apiUrl: string,
    redirectUri?: string,
    grant?: { requestedScopes: GrantableScope[]; requestedAgentId: string }
): Promise<{
    requestId: string
    authUrl: string
    userCode: string
    expiresAt: string
    deviceCode?: string
}> => {
    const client = createCliClient({ baseUrl: apiUrl })
    try {
        return await client.auth.startCliLogin({
            redirectUri,
            requestedScopes: grant?.requestedScopes,
            requestedAgentId: grant?.requestedAgentId
        })
    } catch (error) {
        throw withCliAuthEndpointHint(error, apiUrl, '/auth/cli/start')
    }
}

const exchangeAuthCode = async (
    apiUrl: string,
    authCode: string
): Promise<string> => {
    const client = createCliClient({ baseUrl: apiUrl })
    let exchanged: { token: string }
    try {
        exchanged = await client.auth.exchangeCliLogin({ authCode })
    } catch (error) {
        throw withCliAuthEndpointHint(error, apiUrl, '/auth/cli/exchange')
    }
    return exchanged.token
}

const saveAndConfirm = async (
    apiUrl: string,
    token: string,
    json: boolean
): Promise<void> => {
    const client = createCliClient({ baseUrl: apiUrl, token })
    const user = await client.auth.me()
    await saveConfig({ apiUrl, token })
    // A fresh interactive login supersedes any dangling poll-mode request;
    // drop it so auto-resume cannot later overwrite this token.
    await clearPendingLogin()
    if (json) {
        printJson({ ok: true, userEmail: user.email || user.id })
        return
    }
    console.log(
        kleur.green(
            `Logged in as ${user.email || user.id}. Credentials saved locally.`
        )
    )
}

const runResume = async (apiUrl: string, json: boolean): Promise<void> => {
    const resumed = await resumePendingLogin(apiUrl)
    if (resumed.status === 'completed') {
        if (json) {
            printJson({
                ok: true,
                userEmail: resumed.userEmail,
                scopes: resumed.scopes
            })
            return
        }
        console.log(
            kleur.green(
                `Logged in as ${resumed.userEmail ?? 'agent'} ` +
                    `(scopes: ${resumed.scopes.join(', ')}). ` +
                    'Credentials saved locally.'
            )
        )
        return
    }
    if (resumed.status === 'pending') {
        printLoginStart(resumed.pending.authUrl, resumed.pending.userCode, json)
        throw new Error(
            'pending login is not approved yet; ask the user to open the URL above, then run `mf login --resume` again'
        )
    }
    if (resumed.status === 'expired')
        throw new Error(
            'pending login expired before approval; use `mf auth ensure --scopes <list>` to request capabilities'
        )
    throw new Error(
        'no pending login to resume; use `mf auth ensure --scopes <list>` to request capabilities'
    )
}

const isTerminalLoginError = (error: unknown): boolean =>
    error instanceof Error &&
    /login session expired|login timed out/.test(error.message)

const printLoginStart = (
    authUrl: string,
    userCode: string,
    json = false
): void => {
    const line = (text: string): void => {
        if (json) console.error(text)
        else console.log(text)
    }
    line(kleur.bold('Manyfold login'))
    line(`Open: ${kleur.cyan(authUrl)}`)
    line(`Code: ${kleur.bold(userCode)}`)
}

const promptAuthCode = async (): Promise<string> => {
    const rl = createInterface({
        input: process.stdin,
        output: process.stdout
    })
    try {
        const code = await rl.question('Paste auth code: ')
        const trimmed = code.trim()
        if (!trimmed) throw new Error('auth code is required')
        return trimmed
    } finally {
        rl.close()
    }
}

interface CallbackServer {
    redirectUri: string
    waitForCode: (timeoutMs: number) => Promise<string>
    close: () => Promise<void>
}

const createCallbackServer = async (): Promise<CallbackServer> => {
    let settled = false
    let resolveCode!: (code: string) => void
    let rejectCode!: (err: Error) => void
    const codePromise = new Promise<string>((resolve, reject) => {
        resolveCode = resolve
        rejectCode = reject
    })

    const server: Server = createServer((req, res) => {
        const parsed = parseCallbackRequestUrl(req.url)
        if (parsed.authCode) {
            settle(res, true)
            resolveCode(parsed.authCode)
            return
        }
        settle(res, false, parsed.error)
        rejectCode(new Error(parsed.error ?? 'login callback failed'))
    })

    await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, '127.0.0.1', () => resolve())
    })

    const address = server.address() as AddressInfo
    const redirectUri = `http://127.0.0.1:${address.port}/callback`

    return {
        redirectUri,
        waitForCode: (timeoutMs) =>
            new Promise<string>((resolve, reject) => {
                const timer = setTimeout(
                    () => reject(new Error('login timed out')),
                    timeoutMs
                )
                codePromise.then(resolve, reject).finally(() => {
                    clearTimeout(timer)
                })
            }),
        close: () =>
            new Promise<void>((resolve) => {
                if (!server.listening || settled) {
                    resolve()
                    return
                }
                settled = true
                server.close(() => resolve())
            })
    }
}

const settle = (res: ServerResponse, ok: boolean, error?: string): void => {
    res.statusCode = ok ? 200 : 400
    res.setHeader('content-type', 'text/html; charset=utf-8')
    res.end(
        ok
            ? '<!doctype html><title>Manyfold login</title><p>Login complete. You can close this window.</p>'
            : `<!doctype html><title>Manyfold login</title><p>Login failed: ${escapeHtml(
                  error ?? 'unknown error'
              )}</p>`
    )
}

const launchBrowser = (url: string): void => {
    const command =
        process.platform === 'darwin'
            ? 'open'
            : process.platform === 'win32'
              ? 'cmd'
              : 'xdg-open'
    const args = process.platform === 'win32' ? ['/c', 'start', '', url] : [url]
    try {
        const child = spawn(command, args, {
            detached: true,
            stdio: 'ignore'
        })
        child.on('error', () => {})
        child.unref()
    } catch {}
}

const escapeHtml = (value: string): string =>
    value
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;')

export const formatCliAuthEndpointHint = (
    apiUrl: string,
    path: string
): string =>
    [
        `Browser login endpoint is not available at ${apiUrl.replace(/\/$/, '')}${path}.`,
        '',
        'If you are testing local changes, start the updated API and run the CLI through the local helper:',
        '  just db-migrate',
        '  just dev-api',
        '  just cli login',
        '',
        'If you are using the hosted API, deploy the API/web changes before running mf login.'
    ].join('\n')

const withCliAuthEndpointHint = (
    error: unknown,
    apiUrl: string,
    path: string
): Error => {
    if (isNotFoundError(error)) {
        return new Error(formatCliAuthEndpointHint(apiUrl, path))
    }
    return error instanceof Error ? error : new Error(String(error))
}

const isNotFoundError = (error: unknown): boolean =>
    error instanceof Error && /^404\b/.test(error.message)
