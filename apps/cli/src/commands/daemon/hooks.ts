import type { Command } from 'commander'
import kleur from 'kleur'
import type { TerminalHookFramework } from '@manyfold/shared'
import { TERMINAL_HOOK_FRAMEWORKS } from '@manyfold/shared'
import { DEFAULT_API_URL } from '@/channel'
import { loadConfig } from '@/config'
import { detectFrameworks } from '@/daemon/detect'
import {
    hookReportFromInput,
    installSessionHooks,
    sendSessionHookReport,
    sessionHooksStatus,
    sessionHooksSupported,
    uninstallSessionHooks,
    writeSessionHooksConsent,
    type SessionHookChange,
    type SessionHooksStatus
} from '@/daemon/session-hooks'
import { emit, jsonOption } from '@/output'
import { resolveSecretInput } from '@/secret-input'

const rootOptions = (command: Command): { apiUrl?: string; token?: string } => {
    let current = command
    while (current.parent) current = current.parent
    return current.opts()
}

const readStdin = async (): Promise<string> => {
    if (process.stdin.isTTY) return ''
    const chunks: Buffer[] = []
    for await (const chunk of process.stdin)
        chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk)
    return Buffer.concat(chunks).toString('utf8')
}

const printChanges = (changes: SessionHookChange[]): void => {
    if (changes.length === 0) {
        console.log(
            kleur.yellow(
                'nothing to do: no supported framework (claude / codex) detected on PATH'
            )
        )
        return
    }
    for (const change of changes) {
        const label = kleur.cyan(change.framework.padEnd(12))
        if (change.error) console.log(`${label} ${kleur.red(change.error)}`)
        else console.log(`${label} ${change.action}`)
    }
}

export const printSessionHooksStatus = (status: SessionHooksStatus): void => {
    if (!status.supported) {
        console.log(
            `${kleur.cyan('hooks'.padEnd(12))} ${kleur.gray('not supported on this platform')}`
        )
        return
    }
    for (const framework of status.frameworks) {
        const state = !framework.installed
            ? kleur.gray('not installed')
            : framework.current
              ? kleur.green('installed')
              : kleur.yellow(
                    `installed (v${framework.scriptVersion ?? '?'}, update with mf daemon hooks install)`
                )
        console.log(
            `${kleur.cyan(`hooks/${framework.framework}`.padEnd(12))} ${state}   ${kleur.gray(framework.settingsPath)}`
        )
        if (framework.note && framework.installed)
            console.log(`${''.padEnd(12)} ${kleur.gray(framework.note)}`)
    }
    if (status.consent)
        console.log(
            `${kleur.cyan('hooks/daemon'.padEnd(12))} ${status.consent === 'enabled' ? 'kept current on every daemon start' : 'disabled for this registration'}`
        )
}

// The CLI session hooks (ADR-0029 §3): what `claude` and `codex` run on
// SessionStart / SessionEnd so a terminal Manyfold opened can tell the API
// which conversation it is on. Installed only with the owner's yes on a
// self-owned machine; `report` is the hooks' own callback.
export const registerDaemonHooks = (program: Command): void => {
    const hooks = program
        .command('hooks')
        .description(
            'Session hooks Manyfold installs into claude / codex settings (act only inside Manyfold terminals)'
        )

    jsonOption(
        hooks
            .command('install')
            .description(
                'Install the session hooks for the frameworks on this machine and keep them current on daemon start'
            )
    ).action(async (opts: { json?: boolean }) => {
        if (!sessionHooksSupported()) {
            emit(opts, { supported: false, changes: [] }, () =>
                console.log(
                    kleur.yellow('session hooks are not supported on Windows')
                )
            )
            return
        }
        const detected = await detectFrameworks()
        const changes = await installSessionHooks({ detected })
        const remembered = await writeSessionHooksConsent('enabled')
        const status = await sessionHooksStatus()
        emit(opts, { supported: true, changes, remembered, status }, () => {
            printChanges(changes)
            if (!remembered)
                console.log(
                    kleur.gray(
                        'not remembered: register this machine (mf daemon register) so daemon start keeps the hooks current'
                    )
                )
            printSessionHooksStatus(status)
        })
    })

    jsonOption(
        hooks
            .command('uninstall')
            .description('Remove the session hooks Manyfold installed')
    ).action(async (opts: { json?: boolean }) => {
        const changes = await uninstallSessionHooks()
        const remembered = await writeSessionHooksConsent('disabled')
        emit(opts, { changes, remembered }, () => printChanges(changes))
    })

    jsonOption(
        hooks
            .command('status')
            .description(
                'Show which frameworks have the session hooks installed'
            )
    ).action(async (opts: { json?: boolean }) => {
        const status = await sessionHooksStatus()
        emit(opts, status, () => printSessionHooksStatus(status))
    })

    jsonOption(
        hooks
            .command('report <framework>')
            .description(
                'Used by the installed hooks: forward the hook JSON on stdin to Manyfold (no-op outside a Manyfold terminal)'
            )
    ).action(
        async (
            frameworkArg: string,
            opts: { json?: boolean },
            command: Command
        ) => {
            const result = await reportFromStdin(
                frameworkArg,
                rootOptions(command)
            )
            emit(opts, result, () => {})
        }
    )
}

const reportFromStdin = async (
    frameworkArg: string,
    root: { apiUrl?: string; token?: string }
): Promise<Record<string, unknown>> => {
    if (!(TERMINAL_HOOK_FRAMEWORKS as readonly string[]).includes(frameworkArg))
        return { sent: false, reason: 'unknown-framework' }
    const framework = frameworkArg as TerminalHookFramework
    // Not a Manyfold terminal: the user's own shell, or a hook that survived
    // an uninstall. Nothing leaves the machine.
    if (!process.env.MF_TERMINAL_ID?.trim())
        return { sent: false, reason: 'not-a-manyfold-terminal' }
    let input: unknown
    try {
        input = JSON.parse(await readStdin())
    } catch {
        return { sent: false, reason: 'invalid-input' }
    }
    const body = hookReportFromInput(framework, input)
    if (!body) return { sent: false, reason: 'not-a-session-event' }
    const stored = await loadConfig().catch(
        () => ({}) as { apiUrl?: string; token?: string }
    )
    const apiUrl = root.apiUrl ?? stored.apiUrl ?? DEFAULT_API_URL
    // The terminal's own token, injected as MF_API_TOKEN: it is the one the
    // API resolves the terminal from, so nothing else is tried first.
    const token =
        process.env.MF_API_TOKEN?.trim() ||
        resolveSecretInput(root.token) ||
        stored.token
    if (!token) return { sent: false, reason: 'no-token' }
    return { ...(await sendSessionHookReport({ apiUrl, token, body })), body }
}
