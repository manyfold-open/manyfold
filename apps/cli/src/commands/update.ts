import { mkdir, chmod, writeFile, rm, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { spawnSync } from 'node:child_process'
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
    ReleaseManifestHttpError,
    type ReleaseManifest
} from '@/release-manifest'
import {
    extractUpdateBinary,
    replaceExecutable,
    resolveUpdateTarget
} from '@/self-update'
import { isBunStandalone } from '@/standalone'
import { emit, fail, jsonOption } from '@/output'
import { promptYesNo } from '@/prompt'
import { UsageError } from '@/usage-error'
import { keepPreviousBinary, precheckBinary } from '@/daemon/manual-update'
import { MF_CLI_COMMIT, MF_CLI_VERSION } from '@/version'

interface UpdateOptions {
    force?: boolean
    yes?: boolean
    check?: boolean
    to?: string
    channel?: string
    json?: boolean
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
    // ADR-0029 §5: keep the running binary reachable as `<execPath>.prev`
    // (same inode, hard link) so a handoff that fails can put it back.
    keepPrevious?: boolean
    // Seam for the `--version` precheck the new binary must pass before it
    // replaces anything (POSIX; defaults to running it).
    precheck?: (binary: string, targetVersion: string) => Promise<void>
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
        if (target.os !== 'windows') {
            await chmod(newBinary, 0o755)
            // A binary that cannot run `--version` never replaces the one
            // that can; on an init-unit install it would otherwise crash-loop
            // under the supervisor, on a manual one it would strand the host.
            await (opts.precheck ?? precheckBinary)(newBinary, targetVersion)
            if (opts.keepPrevious) await keepPreviousBinary(execPath)
        }

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

// Why this binary cannot update itself; the hint says what to do instead.
export class UpdateUnavailableError extends Error {
    constructor(
        message: string,
        readonly hint?: string
    ) {
        super(message)
        this.name = 'UpdateUnavailableError'
    }
}

const VERSION_RE = /^v?\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/

// A failure the sink files by its cause: a network one exits 2 and keeps
// these words, which name the host that could not be reached.
const failure = (message: string, err: unknown): Error => {
    const cause = err as Error | undefined
    const wrapped = new Error(`${message}: ${cause?.message ?? String(err)}`, {
        cause: err
    })
    if (cause?.name === 'AbortError' || cause?.name === 'TimeoutError')
        wrapped.name = 'TimeoutError'
    return wrapped
}

export interface SelfUpdateDeps {
    standalone: () => boolean
    resolveTarget: () => unknown
    fetchManifest: (url: string) => Promise<ReleaseManifest>
    loadChannelPref: () => Promise<CliChannel | null>
    saveChannelPref: (channel: CliChannel) => Promise<void>
    interactive: () => boolean
    confirm: (question: string) => Promise<boolean>
    install: (opts: {
        manifest: ReleaseManifest
        channel: CliChannel
        force?: boolean
        onProgress: (msg: string) => void
    }) => Promise<SelfUpdateResult>
    reportedVersion: (execPath: string) => string | null
    daemonPid: () => Promise<number | null>
    current: { version: string; commit: string | null; channel: CliChannel }
}

export const defaultSelfUpdateDeps = (): SelfUpdateDeps => ({
    standalone: isBunStandalone,
    resolveTarget: resolveUpdateTarget,
    fetchManifest: (url) => fetchReleaseManifest(url),
    loadChannelPref: loadUpdateChannelPref,
    saveChannelPref: saveUpdateChannelPref,
    interactive: () => Boolean(process.stdin.isTTY),
    confirm: promptYesNo,
    install: (opts) => performSelfUpdate(opts),
    reportedVersion: (execPath) =>
        spawnSync(execPath, ['--version'], {
            encoding: 'utf8',
            timeout: 5000
        }).stdout?.trim() || null,
    daemonPid: runningDaemonPid,
    current: {
        version: MF_CLI_VERSION,
        commit: MF_CLI_COMMIT || null,
        channel: CLI_CHANNEL
    }
})

export type SelfUpdateOutcome =
    | {
          action: 'check'
          status: UpdateStatus
          channel: CliChannel
          current: string
          latest: string
      }
    | { action: 'none'; channel: CliChannel; current: string }
    | { action: 'cancelled' }
    | {
          action: 'installed'
          channel: CliChannel
          from: string
          to: string
          commit: string | null
          execPath: string
          reportedVersion: string | null
          daemonPid: number | null
      }

// What `mf update` does, with every side effect behind `deps`. The channel
// preference is written only once the target resolved and nobody declined.
export const runSelfUpdate = async (
    opts: UpdateOptions,
    deps: SelfUpdateDeps,
    say: (line: string) => void
): Promise<SelfUpdateOutcome> => {
    if (!deps.standalone())
        throw new UpdateUnavailableError(
            'update only works on installed mf binaries',
            'In dev mode, rebuild via `pnpm build` instead.'
        )
    deps.resolveTarget()
    if (opts.to !== undefined && !VERSION_RE.test(opts.to.trim()))
        throw new UsageError(
            '--to takes a version such as 5.8.0; mf updates versions cli lists them'
        )
    let flagChannel: CliChannel | null = null
    try {
        flagChannel = opts.channel
            ? normalizeUpdateChannelFlag(opts.channel)
            : null
    } catch (err) {
        throw new UsageError((err as Error).message)
    }
    if (flagChannel && opts.to && cliChannelOfVersion(opts.to) !== flagChannel)
        throw new UsageError(
            `--to ${opts.to} is a ${cliChannelOfVersion(opts.to)} build but --channel is ${flagChannel}`
        )
    const channel = resolveEffectiveUpdateChannel({
        flagChannel,
        savedPref: await deps.loadChannelPref(),
        toVersion: opts.to,
        baked: deps.current.channel
    })

    const url = opts.to ? versionManifestUrl(opts.to) : channelManifestUrl(channel)
    let manifest: ReleaseManifest
    try {
        manifest = await deps.fetchManifest(url)
    } catch (err) {
        if (err instanceof ReleaseManifestHttpError && err.status === 404 && opts.to)
            throw new UsageError(
                `no mf release ${opts.to}; mf updates versions cli lists the versions you can install`
            )
        throw failure(
            `failed to resolve the target release at ${new URL(url).host}`,
            err
        )
    }
    const status = resolveUpdateStatus({
        channel,
        currentVersion: deps.current.version,
        currentCommit: deps.current.commit,
        targetVersion: manifest.version,
        targetCommit: manifest.commit
    })
    if (opts.check)
        return {
            action: 'check',
            status,
            channel,
            current: deps.current.version,
            latest: manifest.version
        }

    const pin = async (): Promise<void> => {
        if (!flagChannel) return
        await deps.saveChannelPref(flagChannel)
        say(kleur.dim(`pinned update channel to ${flagChannel}`))
    }
    if (status === 'up-to-date' && !opts.force) {
        await pin()
        return { action: 'none', channel, current: deps.current.version }
    }

    if (!opts.yes) {
        if (opts.json)
            throw new UsageError(
                '--json never prompts: pass --yes to install, or --check'
            )
        if (!deps.interactive())
            throw new UsageError(
                'non-interactive shell; pass --yes to skip the confirmation prompt'
            )
        const channelNote =
            channel === deps.current.channel
                ? ''
                : kleur.dim(` on the ${channel} channel`)
        const verb =
            deps.current.version === manifest.version
                ? `Reinstall ${kleur.cyan(deps.current.version)}${channelNote}?`
                : `Update ${kleur.dim(deps.current.version)} → ${kleur.cyan(manifest.version)}${channelNote}?`
        if (!(await deps.confirm(`${verb} [Y/n] `))) return { action: 'cancelled' }
    }

    await pin()
    let result: SelfUpdateResult
    try {
        result = await deps.install({
            manifest,
            channel,
            force: opts.force,
            onProgress: (msg) => say(kleur.dim(msg))
        })
    } catch (err) {
        throw failure('update failed', err)
    }
    return {
        action: 'installed',
        channel,
        from: result.from,
        to: result.to,
        commit: result.commit,
        execPath: result.execPath,
        reportedVersion: deps.reportedVersion(result.execPath),
        daemonPid: await deps.daemonPid()
    }
}

const renderInstalled = (
    outcome: Extract<SelfUpdateOutcome, { action: 'installed' }>,
    baked: CliChannel
): void => {
    console.log(
        `${kleur.green('✓')} installed ${kleur.cyan(outcome.to)} at ${kleur.dim(outcome.execPath)}`
    )
    if (outcome.reportedVersion && outcome.reportedVersion !== outcome.to)
        console.log(
            kleur.yellow(
                `warning: new binary reports version ${outcome.reportedVersion}, expected ${outcome.to}`
            )
        )
    if (outcome.channel !== baked) {
        const apiNote =
            outcome.channel === 'dev'
                ? ' The dev channel is an update policy only: it still defaults to the production API, so target a pre-production API with an explicit `--api-url` at login.'
                : ''
        console.log(
            kleur.yellow(
                `note: the ${outcome.channel} binary defaults to profile '${outcome.channel === 'stable' ? 'default' : outcome.channel}' — a fresh profile needs \`mf login\` once; your current profile keeps its own credentials and daemon (select it with --profile or MF_PROFILE, see \`mf profile list\`).${apiNote}`
            )
        )
    }
    if (outcome.daemonPid !== null) {
        const channelSwitchNote =
            outcome.channel === baked
                ? ''
                : ' the daemon keeps its registration across the channel switch and will only log a channel warning.'
        console.log(
            kleur.yellow(
                `note: daemon is running (pid=${outcome.daemonPid}) with the previous binary; restart with \`mf daemon stop && mf daemon start\` to pick up the new code.${channelSwitchNote}`
            )
        )
    }
}

const renderOutcome = (
    outcome: SelfUpdateOutcome,
    baked: CliChannel
): void => {
    const suffix = (channel: CliChannel): string =>
        channel === baked ? '' : kleur.dim(` [${channel}]`)
    switch (outcome.action) {
        case 'check':
            if (outcome.status === 'up-to-date')
                console.log(
                    `${kleur.green('✓')} up to date (${kleur.cyan(outcome.current)})${suffix(outcome.channel)}`
                )
            else if (outcome.status === 'update')
                console.log(
                    `${kleur.yellow('↑')} update available: ${kleur.dim(outcome.current)} → ${kleur.cyan(outcome.latest)}${suffix(outcome.channel)}`
                )
            else
                console.log(
                    `${kleur.dim('current')} ${kleur.cyan(outcome.current)} ${kleur.dim('is ahead of latest')} ${kleur.cyan(outcome.latest)}${suffix(outcome.channel)}`
                )
            return
        case 'none':
            console.log(
                `${kleur.green('✓')} already on ${kleur.cyan(outcome.current)} ${kleur.dim('(use --force to reinstall)')}`
            )
            return
        case 'cancelled':
            console.log(kleur.dim('cancelled.'))
            return
        case 'installed':
            renderInstalled(outcome, baked)
    }
}

const jsonOutcome = (outcome: SelfUpdateOutcome): unknown => {
    switch (outcome.action) {
        case 'check':
            return {
                channel: outcome.channel,
                current: outcome.current,
                latest: outcome.latest,
                status: outcome.status
            }
        case 'none':
            return {
                channel: outcome.channel,
                from: outcome.current,
                to: outcome.current,
                changed: false
            }
        case 'cancelled':
            return { cancelled: true }
        case 'installed':
            return {
                channel: outcome.channel,
                from: outcome.from,
                to: outcome.to,
                commit: outcome.commit,
                execPath: outcome.execPath,
                changed: true
            }
    }
}

export const registerUpdate = (
    program: Command,
    deps: () => SelfUpdateDeps = defaultSelfUpdateDeps
): void => {
    jsonOption(
        program
            .command('update')
            .description("Update this machine's mf CLI to the latest version")
            .option('--to <version>', 'install a specific version (e.g. 0.1.0)')
            .option(
                '--channel <channel>',
                'update channel: dev or stable (remembers your choice)'
            )
            .option(
                '--force',
                'reinstall even when already on the target version'
            )
            .option('--check', 'show available update without installing')
            .option('--yes', 'skip the confirmation prompt')
    ).action(async (opts: UpdateOptions) => {
        const resolved = deps()
        // With --json, stdout carries only the result.
        const say = (line: string): void =>
            opts.json ? console.error(line) : console.log(line)
        let outcome: SelfUpdateOutcome
        try {
            outcome = await runSelfUpdate(opts, resolved, say)
        } catch (err) {
            if (err instanceof UsageError) throw err
            fail(
                opts,
                err,
                err instanceof UpdateUnavailableError && err.hint
                    ? { hint: err.hint }
                    : {}
            )
            return
        }
        emit(opts, jsonOutcome(outcome), () =>
            renderOutcome(outcome, resolved.current.channel)
        )
    })
}
