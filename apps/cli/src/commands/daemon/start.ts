import os from 'node:os'
import type { Command } from 'commander'
import kleur from 'kleur'
import type { HeartbeatRequest } from '@manyfold/shared'
import {
    apiPaths,
    DAEMON_CLIENT_FEATURES,
    DAEMON_FEATURE_MANUAL_UPDATE,
    DAEMON_FRAMEWORK_DETECT_INTERVAL_MS,
    POD_RUNNER_PROFILE
} from '@manyfold/shared'
import { spawn } from 'node:child_process'
import { openSync } from 'node:fs'
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
    loadDaemonConfigForStart,
    type DaemonConfig
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
    setDeclaredWorkspaceRoot,
    setFileExecsAdoptable,
    setManualUpdateHandoff
} from '@/daemon/rpc'
import { detachAllFileExecs, takeLastRecovery } from '@/daemon/exec-files'
import { listOwnedTerminals } from '@/daemon/owned-terminals'
import { handOffToSuccessor, takeUpdateRollback } from '@/daemon/manual-update'
import { isBunStandalone } from '@/standalone'
import {
    claimDaemonPid,
    clearDaemonPid,
    DaemonAlreadyRunningError,
    isProcessRunning,
    runningDaemonPid
} from '@/daemon/pid'
import {
    execsSurviveRestart,
    getInitUnitStatus,
    installInitUnit,
    isLikelyDevBinary,
    resolveScope,
    type Scope
} from '@/daemon/init-unit'
import { detectStartupMethod } from '@/daemon/startup-method'
import { boundErrSink, createDaemonLog } from '@/daemon/log-file'
import { MF_CLI_COMMIT, MF_CLI_VERSION } from '@/version'
import { augmentPathFromUserShell } from '@/daemon/shell-path'
import { reconcileSessionHooksOnStart } from '@/daemon/session-hooks'
import { EXEC_FILES_ENV, fileExecEnabled } from '@/daemon/exec-files'

const HEARTBEAT_INTERVAL_MS = 15_000
const DETECT_REFRESH_MS = DAEMON_FRAMEWORK_DETECT_INTERVAL_MS

const runForeground = async (): Promise<void> => {
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

    let ownership
    try {
        ownership = await claimDaemonPid(process.pid)
    } catch (err) {
        if (err instanceof DaemonAlreadyRunningError) {
            console.error(kleur.yellow(err.message))
            process.exit(1)
            return
        }
        throw err
    }

    try {
        await runClaimedForeground(
            config,
            channelWarning,
            ownership.instanceId,
            () => ownership.release()
        )
    } finally {
        await ownership.release()
    }
    process.exit(0)
}

const runClaimedForeground = async (
    config: DaemonConfig,
    channelWarning: string | null,
    clientInstanceId: string,
    releaseOwnership: () => Promise<void>
): Promise<void> => {
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
    let stopControlServer: (() => Promise<void>) | null = null
    let ws: DaemonWsClient | null = null
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null
    let autoUpdater: DaemonAutoUpdater | null = null
    let stopping = false
    const abort = new AbortController()
    let resolveStop: (signal: string) => void = () => {}
    const stopped = new Promise<string>((resolve) => {
        resolveStop = resolve
    })
    const requestStop = (signal: string) => {
        if (stopping) return
        stopping = true
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        autoUpdater?.stop()
        ws?.stop()
        abort.abort()
        resolveStop(signal)
    }
    const onInterrupt = () => requestStop('SIGINT')
    const onTerminate = () => requestStop('SIGTERM')
    process.once('SIGINT', onInterrupt)
    process.once('SIGTERM', onTerminate)
    try {
        await log(
            `daemon starting version=${MF_CLI_VERSION} startup=${startupMethod} pid=${process.pid}`
        )
        await augmentPathFromUserShell(log, abort.signal)
        if (stopping) return
        if (channelWarning) await log(channelWarning)

        // Declared here, FILLED after the WS dial: the five `--version` probes
        // took ~120s on a freshly-thawed sprite under CPU contention, and nothing
        // before the first heartbeat needs the result.
        let detectedFrameworks: Awaited<ReturnType<typeof detectFrameworks>> =
            []
        let lastDetectAt = 0
        await log(`startup method: ${startupMethod}`)
        // Whether this installation keeps a detached exec alive across a
        // restart decides what an update has to wait for (ADR-0029 §4).
        const survival = await execsSurviveRestart(startupMethod)
        setFileExecsAdoptable(survival.survive)
        await log(
            `exec survival: ${survival.survive ? 'yes' : 'no'} (${survival.reason})`
        )
        // A daemon without a supervisor updates itself by handing off to a
        // successor it starts (ADR-0029 §5): only a standalone POSIX binary
        // can, and never the pod runner, whose binary the image pins.
        const manualUpdateCapable =
            startupMethod === 'manual' &&
            isBunStandalone() &&
            process.platform !== 'win32' &&
            resolveProfile() !== POD_RUNNER_PROFILE
        const clientFeatures = manualUpdateCapable
            ? [...DAEMON_CLIENT_FEATURES, DAEMON_FEATURE_MANUAL_UPDATE]
            : [...DAEMON_CLIENT_FEATURES]
        // What the last update on this install did, reported once.
        let pendingRollback = await takeUpdateRollback(
            daemonPaths.updateRollbackPath
        )
        if (pendingRollback)
            await log(
                `previous update to ${pendingRollback.toVersion} was rolled back: ${pendingRollback.reason}`
            )
        const terminalSupport = await checkPtySupport()
        const terminalPty = !('problem' in terminalSupport)
        if ('problem' in terminalSupport)
            await log(`terminal limited: ${terminalSupport.problem}`)

        const startedAt = Date.now()
        const localState: { status: DaemonLocalHealth['status']; ws: boolean } =
            {
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
        // ADR-0029 §4 gray release: plain execs run detached with their IO in
        // files the daemon tails, so they survive a daemon restart.
        await log(
            `exec files: ${
                fileExecEnabled()
                    ? `on (${EXEC_FILES_ENV})`
                    : process.platform === 'win32'
                      ? 'off (Windows keeps the pipe supervisor)'
                      : `off (enable with ${EXEC_FILES_ENV}=1)`
            }`
        )
        stopControlServer = await startControlServer({
            socketPath: daemonPaths.controlSocketPath,
            getHealth: () => ({
                status: localState.status,
                pid: process.pid,
                clientInstanceId,
                version: MF_CLI_VERSION,
                channel: CLI_CHANNEL,
                profile: resolveProfile(),
                daemonId: config.daemonId,
                apiUrl: config.apiUrl,
                startedAt: new Date(startedAt).toISOString(),
                uptimeMs: Date.now() - startedAt,
                wsConnected: localState.ws,
                ...daemonActivitySnapshot(),
                execsSurviveRestart: survival.survive,
                autoUpdate: autoUpdate.enabled,
                startupMethod,
                logPath: daemonPaths.logPath
            })
        })

        const cliFetch = createCliFetch()
        const heartbeat = async (): Promise<void> => {
            if (stopping) return
            if (Date.now() - lastDetectAt > DETECT_REFRESH_MS) {
                detectedFrameworks = await detectFrameworks()
                lastDetectAt = Date.now()
            }
            if (stopping) return
            const body: HeartbeatRequest = {
                detectedFrameworks,
                cliVersion: MF_CLI_VERSION,
                startupMethod,
                terminalPty,
                clientFeatures,
                // The terminals this daemon owns, as proof of life for their
                // rows (ADR-0029 §6); left out when the list cannot be built.
                ...(() => {
                    try {
                        return {
                            terminals: listOwnedTerminals().map(
                                ({ terminalId, attached, startedAt }) => ({
                                    terminalId,
                                    attached,
                                    startedAt
                                })
                            )
                        }
                    } catch {
                        return {}
                    }
                })()
            }
            try {
                await cliFetch(`${config.apiUrl}${apiPaths.DAEMON_HEARTBEAT}`, {
                    method: 'POST',
                    signal: abort.signal,
                    headers: {
                        'content-type': 'application/json',
                        authorization: `Bearer ${config.token}`
                    },
                    body: JSON.stringify(body)
                })
            } catch (err) {
                if (!stopping)
                    await log(`heartbeat failed: ${(err as Error).message}`)
            }
        }

        ws = new DaemonWsClient({
            apiUrl: config.apiUrl,
            token: config.token,
            daemonUuid: config.daemonUuid,
            cliVersion: MF_CLI_VERSION,
            clientInstanceId,
            log: (m) => void log(m),
            clientFeatures,
            helloExtras: () => {
                const recovery = takeLastRecovery()
                const rollback = pendingRollback
                pendingRollback = null
                return {
                    ...(recovery ? { recovery } : {}),
                    ...(rollback ? { rollback } : {})
                }
            },
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

        if (manualUpdateCapable) {
            const wsClient = ws
            setManualUpdateHandoff(async (result) => {
                await log(
                    `manual update: ${result.from} -> ${result.to} installed; handing off`
                )
                const outcome = await handOffToSuccessor({
                    execPath: result.execPath,
                    fromVersion: result.from,
                    toVersion: result.to,
                    stopServing: async () => {
                        // Everything this process owns, in order: no new
                        // work, tailers off (the execs keep running), the
                        // API socket closed, the control socket and the pid
                        // released for the successor to claim.
                        stopping = true
                        if (heartbeatTimer) clearInterval(heartbeatTimer)
                        autoUpdater?.stop()
                        const detached = detachAllFileExecs()
                        if (detached > 0)
                            await log(
                                `manual update: ${detached} exec(s) left running for the successor`
                            )
                        wsClient.stop()
                        const stopControl = stopControlServer
                        stopControlServer = null
                        await stopControl?.()
                        await releaseOwnership()
                    },
                    spawnDaemon: (binary) => spawnDetachedDaemon(binary),
                    health: () =>
                        queryDaemonHealth(daemonPaths.controlSocketPath),
                    kill: (pid, signal) => process.kill(pid, signal),
                    latchPath: daemonPaths.updateLatchPath,
                    rollbackPath: daemonPaths.updateRollbackPath,
                    log: (message) => void log(message)
                })
                await log(
                    outcome.kind === 'handed-off'
                        ? `manual update: handed off to pid=${outcome.successorPid}; exiting`
                        : `manual update: rolled back (${outcome.reason}); exiting`
                )
                await daemonLog.close()
                process.exit(0)
            })
        }

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
        // With the owner's yes recorded (or on a sprite runner), keep the CLI
        // session hooks current for the frameworks this start detected.
        await reconcileSessionHooksOnStart(config, detectedFrameworks, log)
        heartbeatTimer = setInterval(() => {
            void heartbeat()
        }, HEARTBEAT_INTERVAL_MS)

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

        await log(
            `daemon running pid=${process.pid} clientInstanceId=${clientInstanceId} apiUrl=${config.apiUrl} hostname=${os.hostname()}`
        )

        await log(`received ${await stopped}; shutting down`)
    } finally {
        stopping = true
        abort.abort()
        process.removeListener('SIGINT', onInterrupt)
        process.removeListener('SIGTERM', onTerminate)
        if (heartbeatTimer) clearInterval(heartbeatTimer)
        autoUpdater?.stop()
        ws?.stop()
        try {
            await stopControlServer?.()
        } finally {
            await daemonLog.close()
        }
    }
}

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => setTimeout(resolve, ms))

// The successor of a manual-install update: the same foreground start, in
// its own session so it outlives this process, logging where the init units
// would have sent it.
const spawnDetachedDaemon = (binary: string): number => {
    const sink = openSync(daemonPaths.errLogPath, 'a')
    const child = spawn(binary, ['daemon', 'start', '--foreground'], {
        detached: true,
        stdio: ['ignore', sink, sink],
        env: process.env
    })
    child.on('error', () => {})
    child.unref()
    if (!child.pid) throw new Error('successor daemon did not start')
    return child.pid
}

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
