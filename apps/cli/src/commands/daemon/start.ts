import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { dirname } from 'node:path'
import type { Command } from 'commander'
import kleur from 'kleur'
import type { HeartbeatRequest } from '@manyfold/shared'
import {
    apiPaths,
    DAEMON_CLIENT_FEATURES,
    DAEMON_FRAMEWORK_DETECT_INTERVAL_MS
} from '@manyfold/shared'
import { channelManifestUrl, CLI_CHANNEL } from '@/channel'
import { loadUpdateChannelPref } from '@/channel-pref'
import { fetchReleaseManifest } from '@/release-manifest'
import { resolveProfile } from '@/config'
import {
    DaemonAutoUpdater,
    resolveAutoUpdateEnabled
} from '@/daemon/auto-update'
import {
    daemonChannelWarning,
    daemonPaths,
    loadDaemonConfigForStart
} from '@/daemon/config'
import {
    queryDaemonHealth,
    startControlServer,
    waitForDaemonHealth,
    type DaemonLocalHealth
} from '@/daemon/control'
import { detectFrameworks } from '@/daemon/detect'
import { checkPtySupport } from '@/daemon/pty-backend'
import { DaemonWsClient } from '@/daemon/ws-client'
import { createCliFetch } from '@/transport'
import {
    daemonActivitySnapshot,
    requestDaemonUpdateIfIdle,
    rpcHandler,
    setDeclaredWorkspaceRoot
} from '@/daemon/rpc'
import { isBunStandalone } from '@/standalone'
import {
    claimDaemonPid,
    clearDaemonPid,
    DaemonAlreadyRunningError,
    isProcessRunning,
    runningDaemonPid
} from '@/daemon/pid'
import {
    getInitUnitStatus,
    installInitUnit,
    isLikelyDevBinary,
    resolveScope,
    type Scope
} from '@/daemon/init-unit'
import { detectStartupMethod } from '@/daemon/startup-method'
import { boundErrSink, createDaemonLog } from '@/daemon/log-file'
import { MF_CLI_COMMIT, MF_CLI_VERSION } from '@/version'

const HEARTBEAT_INTERVAL_MS = 15_000
const DETECT_REFRESH_MS = DAEMON_FRAMEWORK_DETECT_INTERVAL_MS

// Launchd / systemd start daemons with a stripped PATH (typically just
// /usr/bin:/bin:/usr/sbin:/sbin). User-installed tools like node (via mise /
// nvm / volta), pnpm-installed CLIs, and python venvs live outside this set
// and become invisible to spawned children — so `openclaw` (a wrapper that
// `exec`s node) and `hermes profile list` (uses a venv python) blow up with
// ENOENT. We mirror what the user's interactive shell sees by sourcing
// `$SHELL -lic 'printf %s "$PATH"'` and prepending it to process.env.PATH;
// we always also prepend the directory of our own node binary as a
// belt-and-braces fallback in case the shell can't be invoked.
const augmentPathFromUserShell = (): void => {
    const ourBinDir = dirname(process.execPath)
    const additions: string[] = [ourBinDir]
    const shell = process.env.SHELL?.trim()
    if (shell) {
        try {
            const res = spawnSync(shell, ['-lic', 'printf %s "$PATH"'], {
                encoding: 'utf8',
                timeout: 3_000,
                stdio: ['ignore', 'pipe', 'ignore']
            })
            const shellPath = res.stdout?.trim()
            if (shellPath)
                additions.unshift(
                    ...shellPath.split(':').filter((p) => p.length > 0)
                )
        } catch {}
    }
    const current = (process.env.PATH ?? '')
        .split(':')
        .filter((p) => p.length > 0)
    const seen = new Set<string>()
    const merged: string[] = []
    for (const dir of [...additions, ...current]) {
        if (seen.has(dir)) continue
        seen.add(dir)
        merged.push(dir)
    }
    process.env.PATH = merged.join(':')
}

const runForeground = async (): Promise<void> => {
    const beforePath = process.env.PATH ?? ''
    augmentPathFromUserShell()
    const pathLog = `PATH augmented: before=${beforePath.split(':').length} entries, after=${(process.env.PATH ?? '').split(':').length} entries`
    const config = await loadDaemonConfigForStart()
    if (!config) {
        console.error(
            kleur.red(
                'no daemon config; run `mf daemon register --token …` first'
            )
        )
        process.exit(1)
        return
    }
    setDeclaredWorkspaceRoot(config.workspaceBaseDir)
    const channelWarning = daemonChannelWarning(config)
    if (channelWarning) console.error(kleur.yellow(channelWarning))

    try {
        await claimDaemonPid(process.pid)
    } catch (err) {
        if (err instanceof DaemonAlreadyRunningError) {
            console.error(kleur.yellow(err.message))
            process.exit(1)
            return
        }
        throw err
    }

    await boundErrSink(daemonPaths.errLogPath)
    const startupMethod = detectStartupMethod()
    const daemonLog = await createDaemonLog(daemonPaths.logPath, {
        echo:
            process.stdout.isTTY || startupMethod === 'manual'
                ? process.stdout
                : undefined,
        onError: (message) => process.stderr.write(`${message}\n`)
    })
    const log = daemonLog.log
    await log(pathLog)
    if (channelWarning) await log(channelWarning)

    // Declared here, FILLED after the WS dial: the five `--version` probes
    // took ~120s on a freshly-thawed sprite under CPU contention, and nothing
    // before the first heartbeat needs the result.
    let detectedFrameworks: Awaited<ReturnType<typeof detectFrameworks>> = []
    let lastDetectAt = 0
    await log(`startup method: ${startupMethod}`)
    const terminalSupport = await checkPtySupport()
    const terminalPty = !('problem' in terminalSupport)
    if ('problem' in terminalSupport)
        await log(`terminal limited: ${terminalSupport.problem}`)

    const startedAt = Date.now()
    const localState: { status: DaemonLocalHealth['status']; ws: boolean } = {
        status: 'starting',
        ws: false
    }
    const autoUpdate = resolveAutoUpdateEnabled({
        envValue: process.env.MF_DAEMON_AUTO_UPDATE,
        apiUrl: config.apiUrl,
        channel: CLI_CHANNEL,
        standalone: isBunStandalone(),
        startupMethod
    })
    await log(
        `auto-update: ${autoUpdate.enabled ? 'on' : 'off'} (${autoUpdate.reason})`
    )
    // The control socket is auxiliary: a bind failure must not take the
    // daemon down, it only degrades `daemon status`/`daemon start` output.
    let stopControlServer: (() => Promise<void>) | null = null
    try {
        stopControlServer = await startControlServer({
            socketPath: daemonPaths.controlSocketPath,
            getHealth: () => ({
                status: localState.status,
                pid: process.pid,
                version: MF_CLI_VERSION,
                channel: CLI_CHANNEL,
                profile: resolveProfile(),
                daemonId: config.daemonId,
                apiUrl: config.apiUrl,
                startedAt: new Date(startedAt).toISOString(),
                uptimeMs: Date.now() - startedAt,
                wsConnected: localState.ws,
                ...daemonActivitySnapshot(),
                autoUpdate: autoUpdate.enabled,
                startupMethod,
                logPath: daemonPaths.logPath
            })
        })
    } catch (err) {
        await log(`control socket unavailable: ${(err as Error).message}`)
    }

    const cliFetch = createCliFetch()
    const heartbeat = async (): Promise<void> => {
        if (Date.now() - lastDetectAt > DETECT_REFRESH_MS) {
            detectedFrameworks = await detectFrameworks()
            lastDetectAt = Date.now()
        }
        const body: HeartbeatRequest = {
            detectedFrameworks,
            cliVersion: MF_CLI_VERSION,
            startupMethod,
            terminalPty,
            clientFeatures: DAEMON_CLIENT_FEATURES
        }
        try {
            await cliFetch(`${config.apiUrl}${apiPaths.DAEMON_HEARTBEAT}`, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${config.token}`
                },
                body: JSON.stringify(body)
            })
        } catch (err) {
            await log(`heartbeat failed: ${(err as Error).message}`)
        }
    }

    const ws = new DaemonWsClient({
        apiUrl: config.apiUrl,
        token: config.token,
        daemonUuid: config.daemonUuid,
        cliVersion: MF_CLI_VERSION,
        log: (m) => void log(m),
        onConnected: () => {
            localState.ws = true
        },
        onDisconnected: () => {
            localState.ws = false
        },
        onWelcome: (frame) =>
            void log(
                `welcome daemonId=${frame.daemonId} runtimes=${frame.runtimeIds.length}`
            ),
        handleRpc: rpcHandler
    })
    ws.start()
    localState.status = 'running'

    // The WS dial goes FIRST. Framework detection — five `--version` child
    // processes — used to run before it, and on a freshly-thawed sprite whose
    // resident services were also booting it took ~120s of CPU contention:
    // exactly the runner-manager's whole wait-online budget, so the platform
    // gave up on the runner moments before it dialled (staging 2026-07-29,
    // chat.runner.resolve fallback at 123.2s, runner log silent for 122s
    // between boot and `startup method`). Connectivity never queues behind
    // telemetry; the first heartbeat still carries a FULL detection because an
    // empty frameworks list would wipe the host row's detected set.
    detectedFrameworks = await detectFrameworks()
    lastDetectAt = Date.now()
    await heartbeat()
    const heartbeatTimer = setInterval(() => {
        void heartbeat()
    }, HEARTBEAT_INTERVAL_MS)

    let autoUpdater: DaemonAutoUpdater | null = null
    if (autoUpdate.enabled) {
        // Follow the SAVED update channel, not the baked one: a machine where
        // someone ran `mf update --channel dev` previously kept auto-updating
        // along stable, silently undoing their choice on the next tick.
        const updateChannel = (await loadUpdateChannelPref()) ?? CLI_CHANNEL
        await log(
            `auto-update channel: ${updateChannel}${
                updateChannel === CLI_CHANNEL ? '' : ' (saved preference)'
            }`
        )
        autoUpdater = new DaemonAutoUpdater({
            channel: updateChannel,
            currentVersion: MF_CLI_VERSION,
            currentCommit: MF_CLI_COMMIT || null,
            fetchLatest: async () => {
                const manifest = await fetchReleaseManifest(
                    channelManifestUrl(updateChannel)
                )
                return {
                    version: manifest.version,
                    commit: manifest.commit
                }
            },
            applyIfIdle: (targetVersion) =>
                requestDaemonUpdateIfIdle({ targetVersion }),
            log: (m) => void log(m)
        })
        autoUpdater.start()
    }

    const shutdown = async (signal: string): Promise<void> => {
        await log(`received ${signal}; shutting down`)
        clearInterval(heartbeatTimer)
        autoUpdater?.stop()
        ws.stop()
        await stopControlServer?.().catch(() => {})
        await clearDaemonPid(process.pid)
        await daemonLog.close()
        process.exit(0)
    }
    process.on('SIGINT', () => void shutdown('SIGINT'))
    process.on('SIGTERM', () => void shutdown('SIGTERM'))

    await log(
        `daemon running pid=${process.pid} apiUrl=${config.apiUrl} hostname=${os.hostname()}`
    )

    await new Promise(() => {})
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

const killAndWait = async (pid: number): Promise<void> => {
    try {
        process.kill(pid, 'SIGTERM')
    } catch {}
    const deadline = Date.now() + 5_000
    while (Date.now() < deadline) {
        await sleep(200)
        if (!isProcessRunning(pid)) {
            await clearDaemonPid(pid)
            return
        }
    }
    try {
        process.kill(pid, 'SIGKILL')
    } catch {}
    await clearDaemonPid(pid)
}

const waitForPidClaim = async (timeoutMs: number): Promise<number | null> => {
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
        const pid = await runningDaemonPid()
        if (pid !== null) return pid
        await sleep(200)
    }
    return null
}

export const describeHealth = (health: DaemonLocalHealth): string => {
    const parts = [
        kleur.cyan(`v${health.version}`),
        health.wsConnected
            ? kleur.green('ws connected')
            : kleur.yellow('ws connecting'),
        kleur.dim(`profile ${health.profile}`)
    ]
    if (health.updatePending) parts.push(kleur.yellow('update pending'))
    return parts.join(kleur.dim(' · '))
}

export const installInitUnitAndStart = async (scope: Scope): Promise<void> => {
    const config = await loadDaemonConfigForStart()
    if (!config) {
        console.error(
            kleur.red(
                'no daemon config; run `mf daemon register --token …` first'
            )
        )
        process.exit(1)
        return
    }
    const channelWarning = daemonChannelWarning(config)
    if (channelWarning) console.error(kleur.yellow(channelWarning))

    const existing = await getInitUnitStatus(scope)
    const livePid = await runningDaemonPid()

    if (existing.installed && existing.active && livePid !== null) {
        console.log(
            `${kleur.green('✓')} daemon already running pid=${kleur.cyan(String(livePid))}`
        )
        const health = await queryDaemonHealth(daemonPaths.controlSocketPath)
        if (health) console.log(`  health: ${describeHealth(health)}`)
        console.log(`  scope: ${kleur.cyan(scope)}`)
        console.log(`  unit:  ${kleur.gray(existing.unitPath)}`)
        console.log(`  log:   ${kleur.gray(daemonPaths.logPath)}`)
        return
    }

    if (livePid !== null) {
        console.log(
            kleur.yellow(
                `stopping existing daemon pid=${livePid} (will be replaced by init-managed instance)`
            )
        )
        await killAndWait(livePid)
    }

    if (isLikelyDevBinary()) {
        console.log(
            kleur.yellow(
                'warning: running from a dev binary (node/bun) — init unit will reference the current entry point; rerun after building a release binary'
            )
        )
    }

    let info
    try {
        info = await installInitUnit({ scope })
    } catch (err) {
        const msg = (err as Error).message
        console.error(kleur.red(`install failed: ${msg}`))
        if (scope === 'system' && /EACCES|permission|denied/i.test(msg)) {
            console.error(
                kleur.gray(
                    'hint: system scope requires sudo (`sudo mf daemon start --system`)'
                )
            )
        }
        process.exit(1)
    }
    console.log(`${kleur.green('✓')} init unit installed (${scope} scope)`)
    console.log(`  unit: ${kleur.gray(info.unitPath)}`)

    const newPid = await waitForPidClaim(8_000)
    if (newPid !== null) {
        const health = await waitForDaemonHealth(
            daemonPaths.controlSocketPath,
            { timeoutMs: 10_000 }
        )
        if (health?.status === 'running') {
            console.log(
                `${kleur.green('✓')} daemon ready pid=${kleur.cyan(String(newPid))}`
            )
            console.log(`  health: ${describeHealth(health)}`)
        } else {
            console.log(
                `${kleur.green('✓')} daemon running pid=${kleur.cyan(String(newPid))}${
                    health === null
                        ? kleur.dim(' (no health endpoint — older binary?)')
                        : kleur.yellow(' (still starting)')
                }`
            )
        }
    } else {
        console.log(
            kleur.yellow(
                'daemon did not claim PID within 8s — check log for errors'
            )
        )
    }
    console.log(`  log:  ${kleur.gray(daemonPaths.logPath)}`)
    if (scope === 'user' && process.platform === 'linux') {
        console.log(
            kleur.gray(
                '  hint: run `loginctl enable-linger $USER` to start at boot without login'
            )
        )
    }
}

export const registerDaemonStart = (program: Command): void => {
    program
        .command('start')
        .description(
            'Start the Manyfold daemon (installs init unit so it auto-starts on login)'
        )
        .option(
            '--foreground',
            'run inline without touching the init unit (debug / used by the unit itself)'
        )
        .option(
            '--system',
            'install at system scope (boot-time; needs root/sudo; default as root)'
        )
        .option(
            '--user',
            'install at user scope (per-login; default as non-root)'
        )
        .action(
            async (options: {
                foreground?: boolean
                system?: boolean
                user?: boolean
            }) => {
                if (options.foreground) {
                    await runForeground()
                    return
                }
                const scope: Scope = resolveScope(options)
                await installInitUnitAndStart(scope)
            }
        )
}
