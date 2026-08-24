import { mkdir, chmod, writeFile, rm, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { cliChannelOfVersion, compareCliSemver } from '@manyfold/shared'
import type { Command } from 'commander'
import kleur from 'kleur'
import {
    channelManifestUrl,
    CLI_CHANNEL,
    CLI_INSTALL_URL,
    type CliChannel,
    normalizeUpdateChannelFlag,
    resolveEffectiveUpdateChannel,
    versionManifestUrl
} from '@/channel'
import { loadUpdateChannelPref, saveUpdateChannelPref } from '@/channel-pref'
import { daemonPaths } from '@/daemon/config'
import {
    fetchReleaseManifest,
    manifestArtifact,
    type ReleaseManifest
} from '@/release-manifest'
import {
    extractUpdateBinary,
    replaceExecutable,
    resolveUpdateTarget
} from '@/self-update'
import { isBunStandalone } from '@/standalone'
import { MF_CLI_COMMIT, MF_CLI_VERSION } from '@/version'

interface UpdateOptions {
    force?: boolean
    yes?: boolean
    check?: boolean
    to?: string
    channel?: string
}

const downloadAndHash = async (
    url: string,
    fetchImpl: typeof fetch = fetch
): Promise<{ data: Buffer; hash: string }> => {
    const res = await fetchImpl(url)
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
    const data = Buffer.from(await res.arrayBuffer())
    const hash = createHash('sha256').update(data).digest('hex')
    return { data, hash }
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

export type UpdateStatus = 'up-to-date' | 'update' | 'ahead'

// The dev channel is ordered by COMMIT, not semver: consecutive dev builds
// share a base version, so compareCliSemver reports them equal forever. A
// cross-channel move is unconditionally an update for the same reason —
// `0.24.0-dev.…` and `0.24.0` both parse to 0.24.0.
export const resolveUpdateStatus = (input: {
    channel: CliChannel
    currentVersion: string
    currentCommit?: string | null
    targetVersion: string
    targetCommit?: string | null
}): UpdateStatus => {
    if (cliChannelOfVersion(input.currentVersion) !== input.channel)
        return 'update'
    if (input.channel === 'dev') {
        const sameCommit =
            Boolean(input.currentCommit) &&
            input.currentCommit === input.targetCommit
        return sameCommit || input.currentVersion === input.targetVersion
            ? 'up-to-date'
            : 'update'
    }
    const cmp = compareCliSemver(input.currentVersion, input.targetVersion)
    if (cmp === null) return 'update'
    return cmp === 0 ? 'up-to-date' : cmp < 0 ? 'update' : 'ahead'
}

const runningDaemonPid = async (): Promise<number | null> => {
    let raw: string
    try {
        raw = await readFile(daemonPaths.pidPath, 'utf8')
    } catch {
        return null
    }
    const pid = Number.parseInt(raw.trim(), 10)
    if (!Number.isFinite(pid) || pid <= 0) return null
    try {
        process.kill(pid, 0)
        return pid
    } catch {
        return null
    }
}

export interface SelfUpdateResult {
    from: string
    to: string
    commit: string | null
    execPath: string
    changed: boolean
}

// Core of `mf update`, reused by the daemon's `daemon.update` RPC so a remote
// upgrade runs the exact same manifest → download → sha256 verify → in-process
// extract → recoverable replacement of process.execPath. Throws on any
// failure; the caller decides how to surface it (and whether to restart).
export const performSelfUpdate = async (opts: {
    targetVersion?: string
    channel?: CliChannel
    force?: boolean
    onProgress?: (msg: string) => void
    // `mf update` already fetched a manifest to render --check and the
    // confirmation prompt; passing it back avoids a second fetch and the
    // window where the channel head moves between prompt and install.
    manifest?: ReleaseManifest
    fetchImpl?: typeof fetch
    // Test seams, same idiom as resolveUpdateTarget/replaceExecutable: both
    // default to the real process so production behaviour is unchanged.
    standalone?: boolean
    execPath?: string
}): Promise<SelfUpdateResult> => {
    if (!(opts.standalone ?? isBunStandalone()))
        throw new Error('self-update only works on installed mf binaries')
    const target = resolveUpdateTarget()
    const current = MF_CLI_VERSION
    const fetchImpl = opts.fetchImpl ?? fetch
    // A caller-supplied channel (the API's daemon.update) resolves that
    // channel's manifest instead of this binary's baked one — used to install a
    // dev build on a stable daemon (or vice versa). Every URL comes from a
    // manifest, never from caller-supplied input.
    const manifest =
        opts.manifest ??
        (await fetchReleaseManifest(
            opts.targetVersion
                ? versionManifestUrl(opts.targetVersion)
                : channelManifestUrl(opts.channel ?? CLI_CHANNEL),
            { fetchImpl }
        ))
    const artifact = manifestArtifact(manifest, target)
    const targetVersion = manifest.version
    const execPath = opts.execPath ?? process.execPath
    if (current === targetVersion && !opts.force)
        return {
            from: current,
            to: targetVersion,
            commit: manifest.commit,
            execPath,
            changed: false
        }

    const execDir = dirname(execPath)
    const tmpDir = join(execDir, `.mf-update-${randomBytes(6).toString('hex')}`)

    try {
        await mkdir(tmpDir, { recursive: true })

        opts.onProgress?.(`downloading ${artifact.url}`)
        const { data: archive, hash: computedHash } = await downloadAndHash(
            artifact.url,
            fetchImpl
        )

        if (artifact.sha256.toLowerCase() !== computedHash.toLowerCase())
            throw new Error(
                `sha256 mismatch (expected ${artifact.sha256}, got ${computedHash})`
            )
        opts.onProgress?.(`sha256 ok ${computedHash.slice(0, 12)}…`)

        const newBinary = join(tmpDir, target.binaryName)
        await writeFile(newBinary, extractUpdateBinary(archive, target))
        if (target.os !== 'windows') await chmod(newBinary, 0o755)

        try {
            await replaceExecutable(newBinary, execPath)
        } catch (err) {
            const e = err as NodeJS.ErrnoException
            if (e.code === 'EACCES' || e.code === 'EPERM')
                throw new Error(
                    `permission denied writing ${execPath}; re-run with sudo, or set MF_INSTALL_DIR and re-install via ${CLI_INSTALL_URL}`
                )
            throw err
        }
    } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }

    return {
        from: current,
        to: targetVersion,
        commit: manifest.commit,
        execPath,
        changed: true
    }
}

export const registerUpdate = (program: Command): void => {
    program
        .command('update')
        .description('Update the mf CLI to the latest version')
        .option('--to <version>', 'install a specific version (e.g. 0.1.0)')
        .option(
            '--channel <channel>',
            'update channel: dev or stable (remembers your choice)'
        )
        .option('--force', 'reinstall even when already on the target version')
        .option('--check', 'show available update without installing')
        .option('--yes', 'skip the confirmation prompt')
        .action(async (opts: UpdateOptions) => {
            if (!isBunStandalone()) {
                console.error(
                    kleur.red('update only works on installed mf binaries.')
                )
                console.error(
                    kleur.dim(
                        '  In dev mode, rebuild via `pnpm build` instead.'
                    )
                )
                process.exit(1)
                return
            }

            try {
                resolveUpdateTarget()
            } catch (err) {
                console.error(kleur.red((err as Error).message))
                process.exit(1)
                return
            }

            let channel: CliChannel
            try {
                const flagChannel = opts.channel
                    ? normalizeUpdateChannelFlag(opts.channel)
                    : null
                if (
                    flagChannel &&
                    opts.to &&
                    cliChannelOfVersion(opts.to) !== flagChannel
                )
                    throw new Error(
                        `--to ${opts.to} is a ${cliChannelOfVersion(opts.to)} build but --channel is ${flagChannel}`
                    )
                channel = resolveEffectiveUpdateChannel({
                    flagChannel,
                    savedPref: await loadUpdateChannelPref(),
                    toVersion: opts.to,
                    baked: CLI_CHANNEL
                })
                if (flagChannel && !opts.check) {
                    await saveUpdateChannelPref(flagChannel)
                    console.log(
                        kleur.dim(`pinned update channel to ${flagChannel}`)
                    )
                }
            } catch (err) {
                console.error(kleur.red((err as Error).message))
                process.exit(1)
                return
            }

            const current = MF_CLI_VERSION
            let manifest: ReleaseManifest
            try {
                manifest = await fetchReleaseManifest(
                    opts.to
                        ? versionManifestUrl(opts.to)
                        : channelManifestUrl(channel)
                )
            } catch (err) {
                console.error(
                    kleur.red('failed to resolve the target release:'),
                    (err as Error).message
                )
                process.exit(1)
                return
            }
            const targetVersion = manifest.version

            if (opts.check) {
                const status = resolveUpdateStatus({
                    channel,
                    currentVersion: current,
                    currentCommit: MF_CLI_COMMIT || null,
                    targetVersion,
                    targetCommit: manifest.commit
                })
                const suffix =
                    channel === CLI_CHANNEL ? '' : kleur.dim(` [${channel}]`)
                if (status === 'up-to-date') {
                    console.log(
                        `${kleur.green('✓')} up to date (${kleur.cyan(current)})${suffix}`
                    )
                } else if (status === 'update') {
                    console.log(
                        `${kleur.yellow('↑')} update available: ${kleur.dim(current)} → ${kleur.cyan(targetVersion)}${suffix}`
                    )
                } else {
                    console.log(
                        `${kleur.dim('current')} ${kleur.cyan(current)} ${kleur.dim('is ahead of latest')} ${kleur.cyan(targetVersion)}${suffix}`
                    )
                }
                return
            }

            if (
                resolveUpdateStatus({
                    channel,
                    currentVersion: current,
                    currentCommit: MF_CLI_COMMIT || null,
                    targetVersion,
                    targetCommit: manifest.commit
                }) === 'up-to-date' &&
                !opts.force
            ) {
                console.log(
                    `${kleur.green('✓')} already on ${kleur.cyan(current)} ${kleur.dim('(use --force to reinstall)')}`
                )
                return
            }

            if (!opts.yes) {
                if (!process.stdin.isTTY) {
                    console.error(
                        kleur.red(
                            'non-interactive shell; pass --yes to skip the confirmation prompt'
                        )
                    )
                    process.exit(1)
                    return
                }
                const channelNote =
                    channel === CLI_CHANNEL
                        ? ''
                        : kleur.dim(` on the ${channel} channel`)
                const verb =
                    current === targetVersion
                        ? `Reinstall ${kleur.cyan(current)}${channelNote}?`
                        : `Update ${kleur.dim(current)} → ${kleur.cyan(targetVersion)}${channelNote}?`
                const ok = await promptYesNo(`${verb} [Y/n] `)
                if (!ok) {
                    console.log(kleur.dim('cancelled.'))
                    return
                }
            }

            let result: SelfUpdateResult
            try {
                result = await performSelfUpdate({
                    manifest,
                    channel,
                    force: opts.force,
                    onProgress: (msg) => console.log(kleur.dim(msg))
                })
            } catch (err) {
                console.error(
                    kleur.red('update failed:'),
                    (err as Error).message
                )
                process.exit(1)
                return
            }

            console.log(
                `${kleur.green('✓')} installed ${kleur.cyan(result.to)} at ${kleur.dim(result.execPath)}`
            )

            const verify = spawnSync(result.execPath, ['--version'], {
                encoding: 'utf8',
                timeout: 5000
            })
            const installedVer = verify.stdout?.trim() ?? ''
            if (installedVer && installedVer !== result.to) {
                console.log(
                    kleur.yellow(
                        `warning: new binary reports version ${installedVer}, expected ${result.to}`
                    )
                )
            }

            if (channel !== CLI_CHANNEL) {
                const apiNote =
                    channel === 'dev'
                        ? ' The dev channel is an update policy only: it still defaults to the production API, so target a pre-production API with an explicit `--api-url` at login.'
                        : ''
                console.log(
                    kleur.yellow(
                        `note: the ${channel} binary defaults to profile '${channel === 'stable' ? 'default' : channel}' — a fresh profile needs \`mf login\` once; your current profile keeps its own credentials and daemon (select it with --profile or MF_PROFILE, see \`mf profile list\`).${apiNote}`
                    )
                )
            }

            const pid = await runningDaemonPid()
            if (pid !== null) {
                const channelSwitchNote =
                    channel === CLI_CHANNEL
                        ? ''
                        : ' the daemon keeps its registration across the channel switch and will only log a channel warning.'
                console.log(
                    kleur.yellow(
                        `note: daemon is running (pid=${pid}) with the previous binary; restart with \`mf daemon stop && mf daemon start\` to pick up the new code.${channelSwitchNote}`
                    )
                )
            }
        })
}
