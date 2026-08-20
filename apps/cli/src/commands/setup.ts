import os from 'node:os'
import type { Command } from 'commander'
import kleur from 'kleur'
import { ApiError, buildApiError } from '@manyfold/sdk'
import type { IssueDaemonTokenResponse } from '@manyfold/shared'
import { apiPaths } from '@manyfold/shared'
import { buildClient } from '@/client'
import { DEFAULT_API_URL } from '@/channel'
import { loadConfig, saveConfig } from '@/config'
import { loadDaemonConfigForStart } from '@/daemon/config'
import { resolveScope } from '@/daemon/init-unit'
import { resolveSecretInput } from '@/secret-input'
import { createCliClient, createCliFetch } from '@/transport'
import { runBrowserLogin, runHeadlessLogin } from './login'
import { registerDaemonHost } from './daemon/register'
import { installInitUnitAndStart } from './daemon/start'

interface SetupOptions {
    apiUrl?: string
    token?: string
    name?: string
    system?: boolean
    user?: boolean
    // Commander maps `--no-launch-browser` to `launchBrowser: false`.
    launchBrowser?: boolean
}

interface RootOptions {
    apiUrl?: string
    token?: string
}

const issueDaemonToken = async (
    apiUrl: string,
    userToken: string,
    name: string
): Promise<string> => {
    const res = await createCliFetch()(`${apiUrl}${apiPaths.DAEMON_TOKENS}`, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${userToken}`
        },
        body: JSON.stringify({ name })
    })
    if (!res.ok)
        throw await buildApiError(res, { prefix: 'issue daemon token' })
    const body = (await res.json()) as
        | { data: IssueDaemonTokenResponse }
        | IssueDaemonTokenResponse
    return ('data' in body ? body.data : body).token
}

const normalizedUrl = (value: string): string =>
    value.trim().replace(/\/+$/, '')

export const ensureSignedIn = async (
    apiUrl: string,
    explicitToken: string | undefined,
    launchBrowser = true
): Promise<{ userToken: string; userEmail: string }> => {
    if (explicitToken) {
        const client = createCliClient({ baseUrl: apiUrl, token: explicitToken })
        const me = await client.auth.me()
        await saveConfig({ apiUrl, token: explicitToken })
        return { userToken: explicitToken, userEmail: me.email || me.id }
    }
    const probe = await buildClient({ apiUrl })
    try {
        const me = await probe.client.auth.me()
        return {
            userToken: probe.ctx.token ?? '',
            userEmail: me.email || me.id
        }
    } catch (err) {
        const status = err instanceof ApiError ? err.status : undefined
        if (status !== 401 && status !== 403) throw err
    }
    if (!process.stdin.isTTY)
        throw new Error(
            'not signed in; run `mf login` on this machine first, or pass --token'
        )
    if (launchBrowser) {
        console.log('Sign in to Manyfold — opening your browser…')
        await runBrowserLogin(apiUrl, false)
    } else {
        console.log(
            'Sign in to Manyfold — open the URL below in a browser on any machine:'
        )
        await runHeadlessLogin(apiUrl, false)
    }
    const after = await buildClient({ apiUrl })
    const me = await after.client.auth.me()
    return { userToken: after.ctx.token ?? '', userEmail: me.email || me.id }
}

export const registerSetup = (program: Command): void => {
    program
        .command('setup')
        .description(
            'One-command onboarding: sign in, register this machine as a daemon, start it'
        )
        .option('--api-url <url>', 'API base URL')
        .option(
            '--token <token>',
            'sign in with an existing user token instead of the browser ("-" reads stdin)'
        )
        .option(
            '--name <name>',
            'machine name shown in the dashboard (default: hostname)'
        )
        .option(
            '--system',
            'install the daemon at system scope (boot-time; needs root/sudo; default as root)'
        )
        .option(
            '--user',
            'install the daemon at user scope (per-login; default as non-root)'
        )
        .option(
            '--no-launch-browser',
            'print the auth URL and prompt for the auth code instead of launching a browser (use over SSH)'
        )
        .action(async (opts: SetupOptions) => {
            const root = program.opts<RootOptions>()
            const stored = await loadConfig()
            const apiUrl =
                opts.apiUrl ?? root.apiUrl ?? stored.apiUrl ?? DEFAULT_API_URL

            const { userToken, userEmail } = await ensureSignedIn(
                apiUrl,
                resolveSecretInput(opts.token ?? root.token),
                opts.launchBrowser !== false
            )
            console.log(
                `${kleur.green('✓')} signed in as ${kleur.cyan(userEmail)}`
            )

            const daemonConfig = await loadDaemonConfigForStart()
            if (daemonConfig) {
                console.log(
                    `${kleur.green('✓')} daemon already registered (${kleur.cyan(
                        daemonConfig.daemonId
                    )})`
                )
                if (
                    normalizedUrl(daemonConfig.apiUrl) !== normalizedUrl(apiUrl)
                )
                    console.log(
                        kleur.yellow(
                            `  note: the registration points at ${daemonConfig.apiUrl}; run \`mf daemon stop\` and re-run setup to move it`
                        )
                    )
            } else {
                const daemonToken = await issueDaemonToken(
                    apiUrl,
                    userToken,
                    `mf setup (${os.hostname()})`
                )
                const registration = await registerDaemonHost({
                    apiUrl,
                    token: daemonToken,
                    name: opts.name
                })
                console.log(
                    `${kleur.green('✓')} daemon registered (${kleur.cyan(
                        registration.daemonId
                    )})`
                )
                if (registration.detectedFrameworks.length === 0)
                    console.log(
                        kleur.yellow(
                            '  no frameworks detected (claude / codex / gemini not on PATH)'
                        )
                    )
                else
                    for (const f of registration.detectedFrameworks)
                        console.log(
                            `  detected: ${kleur.cyan(f.framework)} ${f.version ?? '(no version)'}`
                        )
            }

            await installInitUnitAndStart(resolveScope(opts))

            console.log('')
            console.log(
                `${kleur.green('✓')} setup complete — this machine now hosts Manyfold agents`
            )
            console.log(
                kleur.dim('  check anytime with `mf daemon status`')
            )
        })
}
