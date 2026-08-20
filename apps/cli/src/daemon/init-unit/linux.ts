import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import type { InitUnitInfo, InstallContext, Scope } from './index'

const execFileAsync = promisify(execFile)

// ADR-0014: every profile gets its own suffixed unit name — no unsuffixed
// base name, no ownership heuristics, `default` has no path privilege.
export const systemdUnitNameFor = (profile: string): string =>
    `mf-daemon-${profile}.service`

const unitPathFor = (scope: Scope, home: string, unit: string): string =>
    scope === 'user'
        ? join(home, '.config', 'systemd', 'user', unit)
        : join('/etc', 'systemd', 'system', unit)

const systemctlArgs = (scope: Scope, ...rest: string[]): string[] =>
    scope === 'user' ? ['--user', ...rest] : rest

const systemdQuote = (s: string): string => {
    if (s.length === 0) return '""'
    if (!/[\s"'\\$%]/.test(s)) return s
    return `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`
}

const buildExecStart = (programArgs: string[]): string =>
    programArgs
        .filter((a) => a.length > 0)
        .map(systemdQuote)
        .join(' ')

export const buildUnit = (ctx: InstallContext): string => {
    const path = [
        '%h/.local/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        '/usr/local/sbin',
        '/usr/sbin',
        '/sbin'
    ].join(':')
    const execStart = buildExecStart(ctx.programArgs)
    if (ctx.scope === 'user') {
        return `[Unit]
Description=Manyfold daemon (profile ${ctx.profile})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=0
Environment=PATH=${path}
Environment=${systemdQuote(`MF_PROFILE=${ctx.profile}`)}
StandardOutput=append:${ctx.errLogPath.replace(ctx.home, '%h')}
StandardError=append:${ctx.errLogPath.replace(ctx.home, '%h')}

[Install]
WantedBy=default.target
`
    }
    const systemPath = path.replace(/%h/g, ctx.home)
    return `[Unit]
Description=Manyfold daemon for ${ctx.user} (profile ${ctx.profile})
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${ctx.user}
Group=${ctx.group}
Environment=HOME=${ctx.home}
Environment=PATH=${systemPath}
Environment=${systemdQuote(`MF_PROFILE=${ctx.profile}`)}
ExecStart=${execStart}
Restart=on-failure
RestartSec=5
StartLimitIntervalSec=0
StandardOutput=append:${ctx.errLogPath}
StandardError=append:${ctx.errLogPath}

[Install]
WantedBy=multi-user.target
`
}

const ensureSystemdAvailable = async (scope: Scope): Promise<void> => {
    try {
        await execFileAsync('systemctl', ['--version'], { timeout: 3_000 })
    } catch {
        throw new Error(
            'systemctl not available — autostart requires systemd. Run `mf daemon start --foreground` in a long-lived shell instead.'
        )
    }
    if (scope === 'user') {
        try {
            await execFileAsync('systemctl', ['--user', 'show-environment'], {
                timeout: 3_000
            })
        } catch (err) {
            const detail = (err as Error).message
            throw new Error(
                `user systemd session not available (${detail}). Run \`mf daemon start --foreground\` or use \`--system\` (needs sudo).`
            )
        }
    }
}

const runSystemctl = async (
    scope: Scope,
    ...rest: string[]
): Promise<void> => {
    const args = systemctlArgs(scope, ...rest)
    try {
        await execFileAsync('systemctl', args, { timeout: 15_000 })
    } catch (err) {
        const e = err as NodeJS.ErrnoException & {
            stderr?: string
            stdout?: string
        }
        const detail = e.stderr?.trim() || e.stdout?.trim() || e.message
        throw new Error(`systemctl ${args.join(' ')} failed: ${detail}`)
    }
}

const exitCodeOf = async (
    scope: Scope,
    ...rest: string[]
): Promise<number> => {
    const args = systemctlArgs(scope, ...rest)
    try {
        await execFileAsync('systemctl', args, { timeout: 5_000 })
        return 0
    } catch (err) {
        return (err as NodeJS.ErrnoException & { code?: number }).code ?? 1
    }
}

export const install = async (ctx: InstallContext): Promise<InitUnitInfo> => {
    await ensureSystemdAvailable(ctx.scope)
    const unitName = systemdUnitNameFor(ctx.profile)
    const target = unitPathFor(ctx.scope, ctx.home, unitName)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, buildUnit(ctx), { mode: 0o644 })
    await runSystemctl(ctx.scope, 'daemon-reload')
    await runSystemctl(ctx.scope, 'enable', '--now', unitName)
    return status(ctx.scope, ctx.profile)
}

export const uninstall = async (opts: {
    scope: Scope
    profile: string
}): Promise<void> => {
    const unitName = systemdUnitNameFor(opts.profile)
    try {
        await execFileAsync(
            'systemctl',
            systemctlArgs(opts.scope, 'disable', '--now', unitName),
            { timeout: 15_000 }
        )
    } catch {}
    const target = unitPathFor(opts.scope, homedir(), unitName)
    try {
        await unlink(target)
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
    try {
        await execFileAsync(
            'systemctl',
            systemctlArgs(opts.scope, 'daemon-reload'),
            { timeout: 10_000 }
        )
    } catch {}
}

export const status = async (
    scope: Scope,
    profile: string
): Promise<InitUnitInfo> => {
    const unitName = systemdUnitNameFor(profile)
    const target = unitPathFor(scope, homedir(), unitName)
    const installed = existsSync(target)
    if (!installed)
        return {
            scope,
            installed: false,
            enabled: false,
            active: false,
            unitPath: target
        }
    const enabled = (await exitCodeOf(scope, 'is-enabled', unitName)) === 0
    const active = (await exitCodeOf(scope, 'is-active', unitName)) === 0
    return { scope, installed, enabled, active, unitPath: target }
}
