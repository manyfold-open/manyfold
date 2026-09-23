import type {
    AgentFramework,
    AgentModelConfigSource,
    AgentRuntime
} from '@manyfold/shared'
import type { TFn } from '@/lib/i18n'
import {
    terminalResumeAvailability,
    type TerminalResumeBlocked
} from '@/lib/terminalResume'

/* "Switch to herdr" (ADR-0031) takes the browser TUI's place in the chat
   header when the agent's runtime has herdr: a self-owned computer whose
   daemon advertises it (DaemonHostSummary.canOpenInHerdr), or a sandbox
   with herdr installed (SandboxSummary.herdrVersion). Runtimes without
   herdr keep the browser terminal and its old name, so the control is
   offered — with its herdr label — only where it can work, and the reasons
   it is disabled are the resume's own plus what the handoff adds: no
   session on screen yet, an agent that is not running, and a sandbox
   runner whose Manyfold CLI predates the handoff. */

export type HerdrHandoffBlocked =
    | 'no-herdr'
    | 'agent-not-running'
    | 'no-session'
    | 'sandbox-runner-needs-upgrade'
    | 'sandbox-runner-needs-release'
    | TerminalResumeBlocked

export interface HerdrHandoffAvailability {
    // Whether the header shows "Switch to herdr" at all (else the browser
    // TUI control stays).
    offered: boolean
    available: boolean
    blocked: HerdrHandoffBlocked | null
}

export const herdrHandoffAvailability = (args: {
    runtime: AgentRuntime
    running: boolean
    framework: AgentFramework
    daemonCanOpenInHerdr: boolean
    daemonCanResume: boolean
    // The agent's sandbox: herdr installed there, its runner able to drive
    // it, and the terminal credential opt-in the sandbox resume needs.
    sandboxHasHerdr: boolean
    sandboxCanOpenInHerdr: boolean
    // Whether the Update Center has a newer Manyfold CLI for the sandbox:
    // the difference between "update it there" and "nothing to update yet".
    sandboxCliUpdateAvailable: boolean
    sandboxModelCredentials: boolean
    sessionId: string | null
    frameworkSessionRef: string | null
    modelSource: AgentModelConfigSource | null
    runtimeLocalReady: boolean
}): HerdrHandoffAvailability => {
    const onDaemon = args.runtime === 'daemon' && args.daemonCanOpenInHerdr
    const onSandbox = args.runtime === 'sprites' && args.sandboxHasHerdr
    if (!onDaemon && !onSandbox)
        return { offered: false, available: false, blocked: 'no-herdr' }
    if (!args.running)
        return { offered: true, available: false, blocked: 'agent-not-running' }
    if (!args.sessionId)
        return { offered: true, available: false, blocked: 'no-session' }
    // The sandbox's runner predates the handoff. When a newer CLI is on
    // offer the Update Center is the way out; when the runner already runs
    // the newest release, the handoff waits for the next one, and saying
    // "update" would send the user to an empty page.
    if (onSandbox && !args.sandboxCanOpenInHerdr)
        return {
            offered: true,
            available: false,
            blocked: args.sandboxCliUpdateAvailable
                ? 'sandbox-runner-needs-upgrade'
                : 'sandbox-runner-needs-release'
        }
    const resume = terminalResumeAvailability({
        framework: args.framework,
        runtime: args.runtime,
        daemonCanResume: args.daemonCanResume,
        frameworkSessionRef: args.frameworkSessionRef,
        modelSource: args.modelSource,
        runtimeLocalReady: args.runtimeLocalReady,
        // A daemon never needs the sandbox credential opt-in.
        sandboxModelCredentials: onSandbox && args.sandboxModelCredentials
    })
    return resume.available
        ? { offered: true, available: true, blocked: null }
        : { offered: true, available: false, blocked: resume.blocked }
}

// The tooltip on the disabled control. `no-herdr` never shows (the control
// is not offered).
export const herdrHandoffBlockedLabel = (
    blocked: HerdrHandoffBlocked,
    t: TFn
): string | null => {
    switch (blocked) {
        case 'agent-not-running':
            return t('web.terminal.unavailableStopped')
        case 'no-session':
            return t('web.sessionView.herdrNeedsSession')
        case 'no-session-ref':
            return t('web.sessionView.herdrNeedsSessionRef')
        case 'framework-unsupported':
            return t('web.sessionView.herdrUnsupportedFramework')
        case 'daemon-needs-upgrade':
            return t('web.sessionView.herdrNeedsDaemonUpgrade')
        case 'needs-runtime-signin':
            return t('web.sessionView.herdrNeedsSignIn')
        case 'sandbox-runner-needs-upgrade':
            return t('web.sessionView.herdrNeedsSandboxCliUpgrade')
        case 'sandbox-runner-needs-release':
            return t('web.sessionView.herdrNeedsSandboxCliRelease')
        case 'needs-credential-toggle':
            return t('web.sessionView.herdrNeedsCredentials')
        default:
            return null
    }
}

// How long a herdr hold this tab did not take must stand before the view
// follows it (ADR-0031): a handoff herdr refuses holds the session for well
// under a second, and a list refetch that lands late can still show it. A
// hold that has already stood that long (the session was left in herdr, the
// page was reloaded, another client opened it a while ago) is followed at
// once, so a session comes back in the view it was left in.
export const HERDR_FOLLOW_HOLD_DELAY_MS = 1200

export const herdrFollowDelayMs = (
    acquiredAt: string | null,
    now: number
): number => {
    const at = acquiredAt ? Date.parse(acquiredAt) : Number.NaN
    if (!Number.isFinite(at)) return HERDR_FOLLOW_HOLD_DELAY_MS
    return Math.min(
        HERDR_FOLLOW_HOLD_DELAY_MS,
        Math.max(0, HERDR_FOLLOW_HOLD_DELAY_MS - (now - at))
    )
}

// What the "?" after the header's view switch says (ADR-0031). The switch
// reads Switch to herdr, Switch to TUI or Switch to Chat UI; the hint says
// what that does, or why it cannot act, then what the chat above the
// composer used to announce: who holds the session, an import in flight,
// and what the last hand-back brought.
export type ViewSwitchMode = 'herdr' | 'terminal' | 'chat'

export const viewSwitchHint = (
    args: {
        mode: ViewSwitchMode
        disabledReason: string | null
        heldBy: 'herdr' | 'terminal' | null
        importing: boolean
        notice: string | null
    },
    t: TFn
): string => {
    const base =
        args.mode === 'chat'
            ? t('web.sessionView.hintChat')
            : (args.disabledReason ??
              (args.heldBy === 'herdr'
                  ? t('web.sessionHolder.heldByHerdr')
                  : args.heldBy === 'terminal'
                    ? t('web.sessionHolder.heldBanner')
                    : args.mode === 'herdr'
                      ? t('web.sessionView.hintHerdr')
                      : t('web.sessionView.hintTerminal')))
    return [
        base,
        args.importing ? t('web.sessionHolder.importPending') : null,
        args.notice
    ]
        .filter((part): part is string => Boolean(part))
        .join(' ')
}
