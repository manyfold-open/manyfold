import { spawn } from 'node:child_process'
import { createServer, type Server, type ServerResponse } from 'node:http'
import { createInterface } from 'node:readline/promises'
import type { AddressInfo } from 'node:net'
import type { Command } from 'commander'
import kleur from 'kleur'
import { DEFAULT_API_URL } from '@/client'
import { clearPendingLogin, loadConfig, saveConfig } from '@/config'
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
    json?: boolean
}

interface RootOptions {
    apiUrl?: string
    token?: string
    agentId?: string
}

export type LoginMode = 'token' | 'auth-code' | 'browser' | 'headless'

export const resolveLoginMode = (
    opts: LoginOptions,
    stdinIsTTY = Boolean(process.stdin.isTTY),
    agentContext = false
): LoginMode => {
    if (opts.authCode) return 'auth-code'
    if (opts.token) return 'token'
    if (opts.launchBrowser === false) {
        if (!stdinIsTTY)
            throw new Error(
                '--no-launch-browser requires an interactive terminal or --auth-code <code>'
            )
        return 'headless'
    }
    if (agentContext)
        throw new Error(
            'agent runtimes are already authenticated; run `mf auth ensure --scopes <list>` to add capabilities'
        )
    return 'browser'
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
    redirectUri?: string
): Promise<{
    requestId: string
    authUrl: string
    userCode: string
    expiresAt: string
}> => {
    const client = createCliClient({ baseUrl: apiUrl })
    try {
        return await client.auth.startCliLogin({ redirectUri })
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
    // Wipe any pending poll-mode file a pre-removal binary left behind so
    // nothing can later mistake it for state worth resuming.
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
