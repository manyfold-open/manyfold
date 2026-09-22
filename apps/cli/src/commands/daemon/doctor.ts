import type { Command } from 'commander'
import kleur from 'kleur'
import { detectFrameworks } from '@/daemon/detect'
import { detectHerdr } from '@/daemon/herdr'
import { checkPtySupport } from '@/daemon/pty-backend'
import {
    getInitUnitStatus,
    survivalForKillMode,
    type InitUnitInfo
} from '@/daemon/init-unit'
import { killModeOf } from '@/daemon/init-unit/linux'
import { resolveProfile } from '@/config'
import { emit, jsonOption } from '@/output'
import { sessionHooksStatus } from '@/daemon/session-hooks'
import { printSessionHooksStatus } from './hooks'

const summarizeUnit = (info: InitUnitInfo): string => {
    if (!info.installed) return kleur.gray('not installed')
    const flags: string[] = []
    flags.push(info.enabled ? kleur.green('enabled') : kleur.gray('disabled'))
    flags.push(info.active ? kleur.green('active') : kleur.gray('inactive'))
    return `${flags.join(', ')}   ${kleur.gray(info.unitPath)}`
}

const unitSurvival = async (scope: 'user' | 'system') =>
    process.platform === 'linux'
        ? survivalForKillMode(
              scope === 'user' ? 'systemd-user' : 'systemd-system',
              await killModeOf(scope, resolveProfile())
          )
        : survivalForKillMode(
              scope === 'user' ? 'launchd-user' : 'launchd-system',
              null
          )

export const registerDaemonDoctor = (program: Command): void => {
    jsonOption(
        program
            .command('doctor')
            .description('Probe local frameworks and daemon terminal support')
    ).action(async (opts: { json?: boolean }) => {
        const detected = await detectFrameworks()
        const terminalSupport = await checkPtySupport()
        const herdr = await detectHerdr()
        const [userUnit, systemUnit, hooks] = await Promise.all([
            getInitUnitStatus('user'),
            getInitUnitStatus('system'),
            sessionHooksStatus()
        ])
        // Whether a detached exec would outlive a restart under each
        // installed unit (ADR-0029 §4): launchd always keeps it; a systemd
        // unit only with KillMode=process, which an operator-written system
        // unit may lack.
        const survival = {
            user: userUnit.installed ? await unitSurvival('user') : null,
            system: systemUnit.installed ? await unitSurvival('system') : null
        }
        emit(
            opts,
            {
                frameworks: detected,
                terminal: terminalSupport,
                herdr,
                autostart: { user: userUnit, system: systemUnit },
                sessionHooks: hooks,
                execSurvival: survival
            },
            () => {
                if (detected.length === 0) {
                    console.log(
                        kleur.yellow(
                            'no frameworks detected on PATH (looked for claude, codex, gemini)'
                        )
                    )
                } else {
                    for (const f of detected)
                        console.log(
                            `${kleur.cyan(f.framework.padEnd(12))} ${
                                f.version ?? kleur.gray('(no --version output)')
                            }   ${kleur.gray(f.path)}`
                        )
                }

                if ('problem' in terminalSupport) {
                    console.log(
                        `${kleur.yellow('terminal'.padEnd(12))} limited       ${kleur.gray(terminalSupport.problem)}`
                    )
                } else {
                    const label =
                        terminalSupport.backend === 'bun'
                            ? 'bun pty'
                            : 'node-pty'
                    console.log(
                        `${kleur.cyan('terminal'.padEnd(12))} available     ${kleur.gray(`(${label})`)}`
                    )
                }

                console.log(
                    herdr
                        ? `${kleur.cyan('herdr'.padEnd(12))} ${(herdr.version ?? kleur.gray('(no --version output)')).padEnd(13)} ${kleur.gray(herdr.path)}`
                        : `${kleur.gray('herdr'.padEnd(12))} not found     ${kleur.gray('install herdr to hand chat sessions to it')}`
                )

                console.log(
                    `${kleur.cyan('autostart/u'.padEnd(12))} ${summarizeUnit(userUnit)}`
                )
                console.log(
                    `${kleur.cyan('autostart/s'.padEnd(12))} ${summarizeUnit(systemUnit)}`
                )
                for (const [scope, verdict] of [
                    ['u', survival.user],
                    ['s', survival.system]
                ] as const) {
                    if (!verdict) continue
                    console.log(
                        `${kleur.cyan(`survival/${scope}`.padEnd(12))} ${
                            verdict.survive
                                ? kleur.green('execs survive a restart')
                                : kleur.yellow('execs die with the daemon')
                        }   ${kleur.gray(verdict.reason)}`
                    )
                }
                printSessionHooksStatus(hooks)
            }
        )
    })
}
