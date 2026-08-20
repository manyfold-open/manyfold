import os from 'node:os'
import { createInterface } from 'node:readline/promises'
import type { Command } from 'commander'
import kleur from 'kleur'
import { buildApiError } from '@manyfold/sdk'
import type {
    DetectedFramework,
    RegisterDaemonRequest,
    RegisterDaemonResponse
} from '@manyfold/shared'
import {
    apiPaths,
    machineSkillsDir,
    machineWorkspacesRoot
} from '@manyfold/shared'
import { CLI_CHANNEL, DEFAULT_API_URL } from '@/channel'
import { loadConfig, resolveConfigDir, resolveProfile } from '@/config'
import {
    loadOrCreateDaemonUuid,
    saveDaemonConfig,
    type DaemonConfig
} from '@/daemon/config'
import { detectFrameworks } from '@/daemon/detect'
import { checkPtySupport } from '@/daemon/pty-backend'
import { defaultScope } from '@/daemon/init-unit'
import { MF_CLI_VERSION } from '@/version'
import { resolveSecretInput } from '@/secret-input'
import { createCliFetch } from '@/transport'
import { installInitUnitAndStart } from './start'

const DAEMON_TOKEN_PREFIX = 'ldt_'

interface DaemonRegisterOptions {
    token?: string
    name?: string
    workspaceRoot?: string
    skillsDir?: string
    yes?: boolean
}

const promptYesNo = async (q: string): Promise<boolean> => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    try {
        const ans = (await rl.question(q)).trim().toLowerCase()
        return ans === '' || ans.startsWith('y')
    } finally {
        rl.close()
    }
}

interface RootOptions {
    apiUrl?: string
    token?: string
}

export const resolveDaemonRegisterToken = (
    options: DaemonRegisterOptions,
    rootOptions?: RootOptions,
    readStdin?: () => string
): string => {
    const token = resolveSecretInput(
        options.token ?? rootOptions?.token,
        '--token',
        readStdin
    )
    if (!token)
        throw new Error(
            'daemon register requires --token <token> or --token - from the web UI'
        )
    if (!token.startsWith(DAEMON_TOKEN_PREFIX))
        throw new Error(
            'daemon register token must start with ldt_; issue one from Settings > Self-owned computers'
        )
    return token
}

// Seen on a self-hosted daemon enrolment [2026-08-20]: `mf login` had stored
// the local API in the profile, but register resolved flag-or-default only,
// sent the ldt_ token to the channel-default API and surfaced its misleading
// "daemon token not found". Same chain as buildClient: explicit root
// --api-url > profile-stored apiUrl > channel default.
export const resolveDaemonRegisterApiUrl = (
    rootApiUrl: string | undefined,
    stored: { apiUrl?: string }
): string => rootApiUrl ?? stored.apiUrl ?? DEFAULT_API_URL

export const buildRegisteredDaemonConfig = (input: {
    apiUrl: string
    token: string
    daemonId: string
    daemonUuid: string
    workspaceBaseDir: string
    skillsDir: string
}): DaemonConfig => ({
    ...input,
    profile: resolveProfile(),
    channel: CLI_CHANNEL
})

export interface DaemonRegistrationResult {
    daemonId: string
    detectedFrameworks: DetectedFramework[]
}

// Shared by `mf daemon register` and `mf setup`: enrol this machine under an
// ldt_ daemon token and persist the daemon config for the current profile.
// ADR-0014: the registration DECLARES this host's filesystem contract —
// workspace root and skill store. The server must never re-derive these from
// homeDir. Defaults are the machine-scoped shared roots (the data plane is
// per-agent, not per-profile); --workspace-root/--skills-dir express
// isolation only where a host actually wants it.
export const registerDaemonHost = async (opts: {
    apiUrl: string
    token: string
    name?: string
    workspaceRoot?: string
    skillsDir?: string
}): Promise<DaemonRegistrationResult> => {
    const daemonUuid = await loadOrCreateDaemonUuid()
    const detectedFrameworks = await detectFrameworks()
    const terminalSupport = await checkPtySupport()
    const homeDir = os.homedir()
    const configDir = resolveConfigDir()
    const workspaceBaseDir = opts.workspaceRoot ?? machineWorkspacesRoot(configDir)
    const skillsDir = opts.skillsDir ?? machineSkillsDir(configDir)
    const request: RegisterDaemonRequest = {
        daemonUuid,
        name: opts.name ?? os.hostname(),
        hostname: os.hostname(),
        os: process.platform,
        arch: process.arch,
        cliVersion: MF_CLI_VERSION,
        homeDir,
        workspaceBaseDir,
        skillsDir,
        detectedFrameworks,
        terminalPty: !('problem' in terminalSupport)
    }

    const url = `${opts.apiUrl}${apiPaths.DAEMON_REGISTER}`
    const res = await createCliFetch()(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${opts.token}`
        },
        body: JSON.stringify(request)
    })
    if (!res.ok) throw await buildApiError(res, { prefix: 'daemon register' })
    const responseBody = (await res.json()) as
        | { data: RegisterDaemonResponse }
        | RegisterDaemonResponse
    const data = (
        'data' in responseBody ? responseBody.data : responseBody
    ) as RegisterDaemonResponse

    await saveDaemonConfig(
        buildRegisteredDaemonConfig({
            apiUrl: opts.apiUrl,
            token: opts.token,
            daemonId: data.daemonId,
            daemonUuid,
            workspaceBaseDir,
            skillsDir
        })
    )
    return { daemonId: data.daemonId, detectedFrameworks }
}

export const registerDaemonRegister = (program: Command): void => {
    program
        .command('register')
        .description('Register this machine as a Manyfold local daemon')
        .option(
            '--token <token>',
            'PAT issued from the web UI ("-" reads stdin; direct values may appear in shell history and process lists)'
        )
        .option('--name <name>', 'human-readable machine name')
        .option(
            '--workspace-root <path>',
            'workspace base dir this daemon manages (default: the shared ~/.manyfold/workspaces)'
        )
        .option(
            '--skills-dir <path>',
            'skill store dir this daemon manages (default: the shared ~/.manyfold/skills)'
        )
        .option(
            '-y, --yes',
            'skip confirmation and start the daemon after registering',
            false
        )
        .action(async (options: DaemonRegisterOptions) => {
            const parent = program.parent
            const rootOptions = parent?.opts() as RootOptions | undefined
            const token = resolveDaemonRegisterToken(options, rootOptions)
            const apiUrl = resolveDaemonRegisterApiUrl(
                rootOptions?.apiUrl,
                await loadConfig()
            )

            const { daemonId, detectedFrameworks } = await registerDaemonHost({
                apiUrl,
                token,
                name: options.name,
                workspaceRoot: options.workspaceRoot,
                skillsDir: options.skillsDir
            })

            console.log(kleur.green('✓ daemon registered'))
            console.log(
                `  daemonId: ${kleur.cyan(daemonId)}\n  apiUrl:   ${kleur.cyan(
                    apiUrl
                )}`
            )
            if (detectedFrameworks.length === 0)
                console.log(
                    kleur.yellow(
                        '  no frameworks detected (claude / codex / gemini not on PATH)'
                    )
                )
            else
                for (const f of detectedFrameworks)
                    console.log(
                        `  detected: ${kleur.cyan(f.framework)} ${f.version ?? '(no version)'}`
                    )
            console.log('')

            const scope = defaultScope()

            if (options.yes) {
                await installInitUnitAndStart(scope)
                return
            }

            if (process.stdin.isTTY) {
                const when = scope === 'system' ? 'on boot' : 'on login'
                const ok = await promptYesNo(
                    `Start the daemon now? It will auto-start ${when}. [Y/n] `
                )
                if (ok) {
                    await installInitUnitAndStart(scope)
                    return
                }
            }

            console.log('Next: run', kleur.bold('mf daemon start'))
        })
}
