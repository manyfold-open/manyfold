import type { Command } from 'commander'
import kleur from 'kleur'
import type { DaemonHostSummary } from '@manyfold/shared'
import { apiPaths } from '@manyfold/shared'
import { channelFlagLabel } from '@/channel'
import {
    daemonChannelWarning,
    daemonPaths,
    loadDaemonConfig
} from '@/daemon/config'
import { queryDaemonHealth } from '@/daemon/control'
import { getInitUnitStatus, type InitUnitInfo } from '@/daemon/init-unit'
import { runningDaemonPid } from '@/daemon/pid'
import { emit, jsonOption } from '@/output'
import { createCliFetch } from '@/transport'

const formatUnit = (info: InitUnitInfo): string => {
    if (!info.installed) return kleur.gray('not installed')
    const flags: string[] = []
    flags.push(info.enabled ? kleur.green('enabled') : kleur.gray('disabled'))
    flags.push(info.active ? kleur.green('active') : kleur.gray('inactive'))
    return `${flags.join(', ')}  ${kleur.gray(info.unitPath)}`
}

export const registerDaemonStatus = (program: Command): void => {
    jsonOption(
        program.command('status').description('Show local daemon status')
    ).action(async (opts: { json?: boolean }) => {
        const config = await loadDaemonConfig()
        if (!config) {
            emit(opts, { configured: false }, () =>
                console.log(kleur.yellow('no daemon configured'))
            )
            return
        }

        const [userUnit, systemUnit, localPid, local] = await Promise.all([
            getInitUnitStatus('user'),
            getInitUnitStatus('system'),
            runningDaemonPid(),
            queryDaemonHealth(daemonPaths.controlSocketPath)
        ])

        let daemon: DaemonHostSummary | null = null
        let apiError: string | undefined
        try {
            const res = await createCliFetch()(
                `${config.apiUrl}${apiPaths.DAEMON_ME}`,
                {
                    headers: { authorization: `Bearer ${config.token}` }
                }
            )
            if (res.ok) {
                const body = (await res.json()) as
                    | { data: DaemonHostSummary }
                    | DaemonHostSummary
                daemon = (
                    'data' in body ? body.data : body
                ) as DaemonHostSummary
            } else {
                apiError = `${res.status} ${await res.text()}`
            }
        } catch (err) {
            apiError = (err as Error).message
        }

        const channelWarning = daemonChannelWarning(config)

        emit(
            opts,
            {
                configured: true,
                daemon,
                apiError,
                localPid,
                local,
                channelWarning,
                autostart: { user: userUnit, system: systemUnit },
                logPath: daemonPaths.logPath
            },
            () => {
                if (daemon) {
                    console.log(`daemonId:    ${kleur.cyan(daemon.id)}`)
                    console.log(`name:        ${daemon.name}`)
                    console.log(
                        `status:      ${daemon.online ? kleur.green('online') : kleur.gray('offline')}`
                    )
                    console.log(`lastSeenAt:  ${daemon.lastSeenAt ?? '-'}`)
                    console.log(`runtimes:    ${daemon.runtimes.length}`)
                    for (const r of daemon.runtimes)
                        console.log(`  · ${r.framework}  (${r.runtimeId})`)
                } else {
                    console.log(
                        kleur.yellow(`api status check failed: ${apiError}`)
                    )
                }
                console.log(
                    `localPid:    ${localPid !== null ? kleur.cyan(String(localPid)) : kleur.gray('-')}`
                )
                if (local) {
                    console.log(
                        `local:       ${
                            local.status === 'running'
                                ? kleur.green('running')
                                : kleur.yellow(local.status)
                        } ${kleur.dim(`v${local.version}`)} ${kleur.dim(
                            `(profile ${local.profile}, ${channelFlagLabel(local.channel)})`
                        )}${local.updatePending ? kleur.yellow('  update pending') : ''}`
                    )
                    console.log(
                        `ws:          ${
                            local.wsConnected
                                ? kleur.green('connected')
                                : kleur.yellow('disconnected')
                        }`
                    )
                    console.log(
                        `sessions:    ${local.activeExecs} exec, ${local.activePtys} pty`
                    )
                    console.log(
                        `auto-update: ${local.autoUpdate ? kleur.green('on') : kleur.gray('off')}`
                    )
                } else if (localPid !== null) {
                    console.log(
                        `local:       ${kleur.gray('no health endpoint (older daemon binary — restart to enable)')}`
                    )
                }
                if (channelWarning)
                    console.log(`warning:     ${kleur.yellow(channelWarning)}`)
                console.log('autostart:')
                console.log(`  user:      ${formatUnit(userUnit)}`)
                console.log(`  system:    ${formatUnit(systemUnit)}`)
                console.log(`log:         ${kleur.gray(daemonPaths.logPath)}`)
            }
        )
    })
}
