import { readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import { createInterface } from 'node:readline/promises'
import type { Command } from 'commander'
import kleur from 'kleur'
import {
    isValidProfileName,
    profilePaths,
    profilesRoot,
    type ProfilePaths
} from '@manyfold/shared'
import { DEFAULT_API_URL } from '@/channel'
import {
    resolveConfigDir,
    resolveProfile,
    resolveProfileSource
} from '@/config'
import { isProcessRunning } from '@/daemon/pid'
import { uninstallInitUnit } from '@/daemon/init-unit'
import { readJsonState } from '@/json-state'
import { emit, fail, jsonOption } from '@/output'

interface ProfileInfo {
    name: string
    current: boolean
    dir: string
    apiUrl: string | null
    loggedIn: boolean
    daemonRegistered: boolean
    daemonPid: number | null
}

const readJsonQuiet = async (path: string): Promise<unknown | undefined> => {
    try {
        return await readJsonState(path)
    } catch {
        return undefined
    }
}

const readPidAlive = async (paths: ProfilePaths): Promise<number | null> => {
    try {
        const pid = Number.parseInt(
            (
                await readFile(join(paths.daemonDir, 'daemon.pid'), 'utf8')
            ).trim(),
            10
        )
        if (!Number.isFinite(pid) || pid <= 0) return null
        return isProcessRunning(pid) ? pid : null
    } catch {
        return null
    }
}

const readProfileInfo = async (
    root: string,
    name: string,
    currentName: string
): Promise<ProfileInfo> => {
    const paths = profilePaths(root, name)
    const config = (await readJsonQuiet(paths.configPath)) as
        | { apiUrl?: string; token?: string }
        | undefined
    const daemonConfig = await readJsonQuiet(paths.daemonConfigPath)
    return {
        name,
        current: name === currentName,
        dir: paths.dir,
        apiUrl: config?.apiUrl ?? null,
        loggedIn: Boolean(config?.token),
        daemonRegistered: daemonConfig !== undefined,
        daemonPid: await readPidAlive(paths)
    }
}

const listProfileNames = async (root: string): Promise<string[]> => {
    let entries: string[]
    try {
        entries = await readdir(profilesRoot(root))
    } catch {
        entries = []
    }
    return entries.filter((name) => isValidProfileName(name)).sort()
}

const assertProfileName = (name: string): string => {
    if (!isValidProfileName(name))
        throw new Error(
            `invalid profile name '${name}': use 1-32 characters of a-z, 0-9, '_' or '-', starting with a letter or digit`
        )
    return name
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

const formatProfileLine = (info: ProfileInfo): string => {
    const marker = info.current ? kleur.green('*') : ' '
    const apiUrl = info.apiUrl ?? kleur.dim('(channel default)')
    const login = info.loggedIn ? kleur.green('logged in') : kleur.gray('logged out')
    const daemon = info.daemonPid
        ? kleur.green(`daemon pid=${info.daemonPid}`)
        : info.daemonRegistered
          ? kleur.gray('daemon registered')
          : kleur.gray('no daemon')
    return `${marker} ${info.name.padEnd(16)} ${login}  ${daemon}  ${apiUrl}`
}

export const registerProfile = (program: Command): void => {
    const profile = program
        .command('profile')
        .description('Inspect and manage CLI profiles (ADR-0014)')

    jsonOption(
        profile
            .command('show')
            .argument('[name]', 'profile to inspect (default: the current one)')
            .description('Show a profile: source, paths, login and daemon state')
    ).action(async (name: string | undefined, opts: { json?: boolean }) => {
        try {
            const current = resolveProfile()
            const target = name ? assertProfileName(name) : current
            const root = resolveConfigDir()
            const info = await readProfileInfo(root, target, current)
            const paths = profilePaths(root, target)
            const source = target === current ? resolveProfileSource() : null
            emit(
                opts,
                { ...info, source, configPath: paths.configPath },
                () => {
                    console.log(`profile:   ${kleur.cyan(info.name)}`)
                    if (source)
                        console.log(
                            `source:    ${source}${source === 'channel-default' ? kleur.dim(' (no --profile / MF_PROFILE set)') : ''}`
                        )
                    console.log(`dir:       ${kleur.gray(info.dir)}`)
                    console.log(
                        `apiUrl:    ${info.apiUrl ?? `${DEFAULT_API_URL} ${kleur.dim('(channel default; pinned at login)')}`}`
                    )
                    console.log(
                        `login:     ${info.loggedIn ? kleur.green('logged in') : kleur.yellow('logged out — run `mf login`')}`
                    )
                    console.log(
                        `daemon:    ${
                            info.daemonPid
                                ? kleur.green(`running pid=${info.daemonPid}`)
                                : info.daemonRegistered
                                  ? kleur.gray('registered, not running')
                                  : kleur.gray('not registered')
                        }`
                    )
                }
            )
        } catch (error) {
            fail(opts, error)
        }
    })

    jsonOption(
        profile
            .command('list')
            .description('List profiles on this machine')
    ).action(async (opts: { json?: boolean }) => {
        try {
            const current = resolveProfile()
            const root = resolveConfigDir()
            const names = new Set(await listProfileNames(root))
            names.add(current)
            const infos = await Promise.all(
                [...names]
                    .sort()
                    .map((name) => readProfileInfo(root, name, current))
            )
            emit(opts, { profiles: infos }, () => {
                for (const info of infos) console.log(formatProfileLine(info))
                console.log(
                    kleur.dim(
                        '\nselect one with --profile <name> or MF_PROFILE=<name>'
                    )
                )
            })
        } catch (error) {
            fail(opts, error)
        }
    })

    jsonOption(
        profile
            .command('delete')
            .argument('<name>', 'profile to delete')
            .description(
                'Delete a profile: credentials, pending login, daemon state and init units. Agent data lives in the machine-shared ~/.manyfold/workspaces and is never touched.'
            )
            .option('--force', 'allow deleting the default profile', false)
            .option('-y, --yes', 'skip the confirmation prompt', false)
    ).action(
        async (
            name: string,
            opts: {
                json?: boolean
                force?: boolean
                yes?: boolean
            }
        ) => {
            try {
                const target = assertProfileName(name)
                const current = resolveProfile()
                const root = resolveConfigDir()
                if (target === 'default' && !opts.force)
                    throw new Error(
                        "refusing to delete the 'default' profile (pass --force if you really mean it)"
                    )
                const paths = profilePaths(root, target)
                const pid = await readPidAlive(paths)
                if (pid !== null)
                    throw new Error(
                        `profile '${target}' has a running daemon (pid=${pid}); stop it first: MF_PROFILE=${target} mf daemon stop`
                    )
                if (!opts.yes) {
                    if (!process.stdin.isTTY)
                        throw new Error(
                            'non-interactive shell; pass --yes to skip the confirmation prompt'
                        )
                    const ok = await promptYesNo(
                        `Delete profile '${target}' — credentials and daemon state? [Y/n] `
                    )
                    if (!ok) {
                        console.log(kleur.dim('cancelled.'))
                        return
                    }
                }
                // Init units first: a unit surviving its state dir would
                // respawn a daemon that can no longer load a registration.
                for (const scope of ['user', 'system'] as const) {
                    try {
                        await uninstallInitUnit({ scope, profile: target })
                    } catch {}
                }
                // The profile dir holds control plane only (ADR-0014), so
                // removing it cannot touch agent data by construction.
                await rm(paths.dir, { recursive: true, force: true })
                emit(
                    opts,
                    {
                        ok: true,
                        profile: target,
                        removed: [paths.dir],
                        wasCurrent: target === current
                    },
                    () => {
                        console.log(
                            `${kleur.green('✓')} deleted profile ${kleur.cyan(target)}`
                        )
                        console.log(`  removed: ${kleur.gray(paths.dir)}`)
                    }
                )
            } catch (error) {
                fail(opts, error)
            }
        }
    )
}
