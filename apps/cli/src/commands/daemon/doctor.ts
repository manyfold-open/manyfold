import type { Command } from 'commander'
import kleur from 'kleur'
import { detectFrameworks } from '@/daemon/detect'
import { checkPtySupport } from '@/daemon/pty-backend'
import { getInitUnitStatus, type InitUnitInfo } from '@/daemon/init-unit'
import { emit, jsonOption } from '@/output'

const summarizeUnit = (info: InitUnitInfo): string => {
    if (!info.installed) return kleur.gray('not installed')
    const flags: string[] = []
    flags.push(info.enabled ? kleur.green('enabled') : kleur.gray('disabled'))
    flags.push(info.active ? kleur.green('active') : kleur.gray('inactive'))
    return `${flags.join(', ')}   ${kleur.gray(info.unitPath)}`
}

export const registerDaemonDoctor = (program: Command): void => {
    jsonOption(
        program
            .command('doctor')
            .description('Probe local frameworks and daemon terminal support')
    ).action(async (opts: { json?: boolean }) => {
        const detected = await detectFrameworks()
        const terminalSupport = await checkPtySupport()
        const [userUnit, systemUnit] = await Promise.all([
            getInitUnitStatus('user'),
            getInitUnitStatus('system')
        ])
        emit(
            opts,
            {
                frameworks: detected,
                terminal: terminalSupport,
                autostart: { user: userUnit, system: systemUnit }
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
                    `${kleur.cyan('autostart/u'.padEnd(12))} ${summarizeUnit(userUnit)}`
                )
                console.log(
                    `${kleur.cyan('autostart/s'.padEnd(12))} ${summarizeUnit(systemUnit)}`
                )
            }
        )
    })
}
