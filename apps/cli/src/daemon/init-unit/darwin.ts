import { execFile } from 'node:child_process'
import { mkdir, unlink, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'
import { existsSync } from 'node:fs'
import type { InitUnitInfo, InstallContext, Scope } from './index'

const execFileAsync = promisify(execFile)

// ADR-0014: every profile gets its own suffixed label — no unsuffixed base
// name, no ownership heuristics, `default` has no path privilege.
export const launchdLabelFor = (profile: string): string =>
    `ai.manyfold.daemon.${profile}`

const plistPathFor = (scope: Scope, home: string, label: string): string =>
    scope === 'user'
        ? join(home, 'Library', 'LaunchAgents', `${label}.plist`)
        : join('/Library', 'LaunchDaemons', `${label}.plist`)

const launchctlDomain = (scope: Scope): string => {
    if (scope === 'system') return 'system'
    const uid = process.getuid?.() ?? -1
    if (uid < 0)
        throw new Error('cannot determine user uid for launchctl domain')
    return `gui/${uid}`
}

const xmlEscape = (s: string): string =>
    s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')

export const buildPlist = (ctx: InstallContext): string => {
    const path = [
        `${ctx.home}/.local/bin`,
        '/opt/homebrew/bin',
        '/usr/local/bin',
        '/usr/bin',
        '/bin',
        '/usr/sbin',
        '/sbin'
    ].join(':')
    const userGroup =
        ctx.scope === 'system'
            ? `  <key>UserName</key><string>${xmlEscape(ctx.user)}</string>\n  <key>GroupName</key><string>${xmlEscape(ctx.group)}</string>\n`
            : ''
    const argStrings = ctx.programArgs
        .filter((a) => a.length > 0)
        .map((a) => `    <string>${xmlEscape(a)}</string>`)
        .join('\n')
    return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${launchdLabelFor(ctx.profile)}</string>
  <key>ProgramArguments</key>
  <array>
${argStrings}
  </array>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key>
  <dict><key>SuccessfulExit</key><false/></dict>
  <key>StandardOutPath</key><string>${xmlEscape(ctx.errLogPath)}</string>
  <key>StandardErrorPath</key><string>${xmlEscape(ctx.errLogPath)}</string>
${userGroup}  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key><string>${xmlEscape(ctx.home)}</string>
    <key>PATH</key><string>${xmlEscape(path)}</string>
    <key>MF_PROFILE</key><string>${xmlEscape(ctx.profile)}</string>
  </dict>
</dict>
</plist>
`
}

const runLaunchctl = async (args: string[]): Promise<void> => {
    try {
        await execFileAsync('launchctl', args, { timeout: 10_000 })
    } catch (err) {
        const e = err as NodeJS.ErrnoException & {
            stderr?: string
            stdout?: string
        }
        const detail = e.stderr?.trim() || e.stdout?.trim() || e.message
        throw new Error(`launchctl ${args.join(' ')} failed: ${detail}`)
    }
}

const safeRunLaunchctl = async (args: string[]): Promise<void> => {
    try {
        await execFileAsync('launchctl', args, { timeout: 10_000 })
    } catch {}
}

export const install = async (ctx: InstallContext): Promise<InitUnitInfo> => {
    const label = launchdLabelFor(ctx.profile)
    const target = plistPathFor(ctx.scope, ctx.home, label)
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, buildPlist(ctx), { mode: 0o644 })
    const domain = launchctlDomain(ctx.scope)
    await safeRunLaunchctl(['bootout', `${domain}/${label}`])
    await runLaunchctl(['bootstrap', domain, target])
    await safeRunLaunchctl(['enable', `${domain}/${label}`])
    return status(ctx.scope, ctx.profile)
}

export const uninstall = async (opts: {
    scope: Scope
    profile: string
}): Promise<void> => {
    const home = process.env.HOME ?? ''
    const label = launchdLabelFor(opts.profile)
    const target = plistPathFor(opts.scope, home, label)
    const domain = launchctlDomain(opts.scope)
    await safeRunLaunchctl(['bootout', `${domain}/${label}`])
    try {
        await unlink(target)
    } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
    }
}

export const status = async (
    scope: Scope,
    profile: string
): Promise<InitUnitInfo> => {
    const label = launchdLabelFor(profile)
    const target = plistPathFor(scope, process.env.HOME ?? '', label)
    const installed = existsSync(target)
    if (!installed)
        return {
            scope,
            installed: false,
            enabled: false,
            active: false,
            unitPath: target
        }
    const domain = launchctlDomain(scope)
    let enabled = false
    let active = false
    try {
        const { stdout } = await execFileAsync(
            'launchctl',
            ['print', `${domain}/${label}`],
            { timeout: 5_000 }
        )
        enabled = true
        active = /\bstate\s*=\s*running\b/i.test(stdout)
    } catch {}
    return { scope, installed, enabled, active, unitPath: target }
}
