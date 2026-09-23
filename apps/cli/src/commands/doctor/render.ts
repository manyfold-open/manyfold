import kleur from 'kleur'
import type { CheckStatus, DoctorCheck, DoctorReport } from './types'

const MARK: Record<CheckStatus, string> = {
    pass: kleur.green('✓'),
    warn: kleur.yellow('!'),
    fail: kleur.red('✗'),
    skip: kleur.gray('-')
}

const SOURCE_LABEL = {
    flag: '--profile',
    env: 'MF_PROFILE',
    'channel-default': 'channel default'
} as const

const renderSection = (
    heading: string,
    checks: DoctorCheck[],
    width: number
): string[] => {
    const lines = ['', kleur.bold(heading)]
    const passed = checks.filter((check) => check.status === 'pass')
    const problems = checks.filter(
        (check) => check.status === 'warn' || check.status === 'fail'
    )
    if (passed.length > 0)
        lines.push(
            `  ${MARK.pass} ${passed.length} passed ${kleur.gray(
                `(${passed.map((check) => check.title).join(', ')})`
            )}`
        )
    for (const check of problems) {
        lines.push(
            `  ${MARK[check.status]} ${check.title.padEnd(width)}  ${check.detail}`
        )
        if (check.fix)
            lines.push(
                `    ${' '.repeat(width)}  ${kleur.cyan('→')} ${check.fix}`
            )
    }
    if (passed.length === 0 && problems.length === 0)
        lines.push(kleur.gray('  nothing to check'))
    return lines
}

export const renderReport = (report: DoctorReport): string => {
    const { cli, currentProfile, summary } = report
    const width = Math.max(...report.checks.map((check) => check.title.length))
    const lines = [
        // A source build's execPath is node itself, which says nothing.
        `${kleur.bold('mf doctor')}  ${cli.version} (${cli.effectiveChannel}, ${
            cli.installMethod
        })${cli.installMethod === 'standalone' ? `  ${kleur.gray(cli.execPath)}` : ''}`,
        kleur.gray(
            `config ${cli.configDir} · current profile ${currentProfile.name} (${
                SOURCE_LABEL[currentProfile.source]
            })`
        ),
        ...renderSection(
            'Machine',
            report.checks.filter((check) => check.scope === 'machine'),
            width
        )
    ]
    for (const profile of report.profiles)
        lines.push(
            ...renderSection(
                `Profile ${profile.name}${profile.current ? ' (current)' : ''}`,
                report.checks.filter((check) => check.profile === profile.name),
                width
            )
        )
    const totals = [
        summary.fail > 0 ? kleur.red(`${summary.fail} failed`) : '0 failed',
        summary.warn > 0
            ? kleur.yellow(
                  `${summary.warn} warning${summary.warn === 1 ? '' : 's'}`
              )
            : '0 warnings',
        `${summary.pass} passed`
    ]
    lines.push(
        '',
        totals.join(' · '),
        kleur.gray('Deeper local facts: mf daemon doctor')
    )
    return lines.join('\n')
}
