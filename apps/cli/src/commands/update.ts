import { mkdir, chmod, writeFile, rm, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { createInterface } from 'node:readline/promises'
import { cliChannelOfVersion } from '@manyfold/shared'
import type { Command } from 'commander'
import kleur from 'kleur'
import {
    CDN_BASE,
    CLI_CHANNEL,
    type CliChannel,
    normalizeUpdateChannelFlag,
    requireChannelCdn,
    resolveEffectiveUpdateChannel
} from '@/channel'
import { loadUpdateChannelPref, saveUpdateChannelPref } from '@/channel-pref'
import { daemonPaths } from '@/daemon/config'
import {
    extractUpdateBinary,
    replaceExecutable,
    resolveUpdateTarget
} from '@/self-update'
import { isBunStandalone } from '@/standalone'
import { MF_CLI_VERSION } from '@/version'

const CDN = CDN_BASE

interface UpdateOptions {
    force?: boolean
    yes?: boolean
    check?: boolean
    to?: string
    channel?: string
}

const fetchText = async (url: string): Promise<string> => {
    const res = await fetch(url)
    if (!res.ok) throw new Error(`GET ${url} → ${res.status}`)
    return (await res.text()).trim()
}

const downloadAndHash = async (
    url: string
): Promise<{ data: Buffer; hash: string }> => {
    const res = await fetch(url)
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

const cmpSemver = (a: string, b: string): number => {
    const parse = (v: string): number[] =>
        v.split('.').map((p) => Number.parseInt(p, 10) || 0)
    const ap = parse(a)
    const bp = parse(b)
    for (let i = 0; i < 3; i++) {
        const diff = (ap[i] ?? 0) - (bp[i] ?? 0)
        if (diff !== 0) return diff
    }
    return 0
}

export type UpdateStatus = 'up-to-date' | 'update' | 'ahead'

// Dev builds share the same x.y.z base (cmpSemver cannot order
// `x.y.z-dev.<stamp>.<sha7>` prereleases), so any difference from the
// channel's latest counts as an update.
export const resolveUpdateStatus = (
    channel: CliChannel,
    current: string,
    target: string
): UpdateStatus => {
    if (channel === 'dev')
        return current === target ? 'up-to-date' : 'update'
    const cmp = cmpSemver(current, target)
    if (cmp === 0) return 'up-to-date'
    return cmp < 0 ? 'update' : 'ahead'
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
    execPath: string
    changed: boolean
}

// Core of `mf update`, reused by the daemon's `daemon.update` RPC so a remote
// upgrade runs the exact same download → sha256 verify → in-process extract →
// recoverable replacement of process.execPath. Throws on any failure; the
// caller decides how to surface it (and whether to restart).
export const performSelfUpdate = async (opts: {
    targetVersion?: string
    channel?: CliChannel
    force?: boolean
    onProgress?: (msg: string) => void
}): Promise<SelfUpdateResult> => {
    if (!isBunStandalone())
        throw new Error('self-update only works on installed mf binaries')
    const target = resolveUpdateTarget()
    const current = MF_CLI_VERSION
    // A caller-supplied channel (the API's daemon.update) downloads from that
    // channel's CDN instead of this binary's baked one — used to install a
    // staging build on a stable daemon (or vice versa). Both resolve to
    // build-time-baked CDN paths, never an arbitrary URL.
    const cdn = opts.channel ? requireChannelCdn(opts.channel) : CDN
    const targetVersion =
        opts.targetVersion ?? (await fetchText(`${cdn}/latest/version.txt`))
    const execPath = process.execPath
    if (current === targetVersion && !opts.force)
        return { from: current, to: targetVersion, execPath, changed: false }

    const execDir = dirname(execPath)
    const tmpDir = join(execDir, `.mf-update-${randomBytes(6).toString('hex')}`)
    const assetName = `mf-${targetVersion}-${target.os}-${target.arch}.${target.archiveFormat}`
    const assetUrl = `${cdn}/v${targetVersion}/${assetName}`
    const sumUrl = `${assetUrl}.sha256`

    try {
        await mkdir(tmpDir, { recursive: true })

        opts.onProgress?.(`downloading ${assetUrl}`)
        const { data: archive, hash: computedHash } =
            await downloadAndHash(assetUrl)

        const sumText = await fetchText(sumUrl)
        const expectedHash = sumText.split(/\s+/)[0] ?? ''
        if (expectedHash.toLowerCase() !== computedHash.toLowerCase())
            throw new Error(
                `sha256 mismatch (expected ${expectedHash}, got ${computedHash})`
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
                    `permission denied writing ${execPath}; re-run with sudo, or set MF_INSTALL_DIR and re-install via the install script`
                )
            throw err
        }
    } finally {
        await rm(tmpDir, { recursive: true, force: true }).catch(() => {})
    }

    return { from: current, to: targetVersion, execPath, changed: true }
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
            let targetVersion: string
            try {
                targetVersion =
                    opts.to ??
                    (await fetchText(
                        `${requireChannelCdn(channel)}/latest/version.txt`
                    ))
            } catch (err) {
                console.error(
                    kleur.red('failed to resolve target version:'),
                    (err as Error).message
                )
                process.exit(1)
                return
            }

            if (opts.check) {
                const status = resolveUpdateStatus(
                    channel,
                    current,
                    targetVersion
                )
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

            if (current === targetVersion && !opts.force) {
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
                    targetVersion,
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
                const nextDefault = channel === 'dev' ? 'staging' : 'default'
                console.log(
                    kleur.yellow(
                        `note: the ${channel} binary defaults to profile '${nextDefault}' — a fresh profile needs \`mf login\` once; your current profile keeps its own credentials and daemon (select it with --profile or MF_PROFILE, see \`mf profile list\`).`
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
