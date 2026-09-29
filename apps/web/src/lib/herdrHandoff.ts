import type {
    AgentFramework,
    AgentModelConfigSource,
    RuntimePlacement,
    DaemonHerdrFramework
} from '@manyfold/shared'
import type { TFn } from '@/lib/i18n'
import {
    supportsTerminalResume,
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
   session on screen yet, an agent whose machine is not reachable, and a
   sandbox whose Manyfold CLI predates the handoff. */

export type HerdrHandoffBlocked =
    | 'no-herdr'
    | 'agent-unavailable'
    | 'no-session'
    | 'sandbox-cli-needs-upgrade'
    | 'sandbox-cli-needs-release'
    | TerminalResumeBlocked

export interface HerdrHandoffAvailability {
    // Whether the header shows "Switch to herdr" at all (else the browser
    // TUI control stays).
    offered: boolean
    available: boolean
    blocked: HerdrHandoffBlocked | null
}

// herdr starts the TUI as one of its own agent kinds, which exist for Claude
// Code, Codex, Pi and Antigravity CLI. A framework only the browser terminal
// can resume keeps that control; one neither can resume shows this one
// disabled, as before.
const HERDR_FRAMEWORKS: ReadonlySet<AgentFramework> = new Set([
    'claude-code',
    'codex',
    'pi',
    'antigravity-cli'
])

export const herdrHandoffAvailability = (args: {
    runtime: RuntimePlacement
    // isRuntimeUsable(agent.availability): the machine can take a turn now
    // (or wakes for one).
    available: boolean
    framework: AgentFramework
    daemonCanOpenInHerdr: boolean
    daemonCanResume: boolean
    // The agent's sandbox: herdr installed there, its daemon able to drive
    // it, and the terminal credential opt-in the sandbox resume needs.
    sandboxHasHerdr: boolean
    sandboxCanOpenInHerdr: boolean
    // Whether the Update Center has a newer Manyfold CLI for the sandbox:
    // the difference between "update it there" and "nothing to update yet".
    sandboxCliUpdateAvailable: boolean
    sandboxModelCredentials: boolean
    // What the machine's Manyfold CLI can start in herdr: one from before pi
    // joined herdr starts claude and codex only.
    hostHerdrFrameworks: readonly DaemonHerdrFramework[]
    sessionId: string | null
    frameworkSessionRef: string | null
    modelSource: AgentModelConfigSource | null
    runtimeLocalReady: boolean
}): HerdrHandoffAvailability => {
    const onDaemon = args.runtime === 'daemon' && args.daemonCanOpenInHerdr
    const onSandbox = args.runtime === 'sprites' && args.sandboxHasHerdr
    if (
        (!onDaemon && !onSandbox) ||
        (supportsTerminalResume(args.framework) &&
            !HERDR_FRAMEWORKS.has(args.framework))
    )
        return { offered: false, available: false, blocked: 'no-herdr' }
    if (!args.available)
        return { offered: true, available: false, blocked: 'agent-unavailable' }
    if (!args.sessionId)
        return { offered: true, available: false, blocked: 'no-session' }
    // The sandbox's Manyfold CLI predates the handoff. When a newer CLI is
    // on offer the Update Center is the way out; when the sandbox already
    // runs the newest release, the handoff waits for the next one, and
    // saying "update" would send the user to an empty page.
    // The same when the machine's CLI drives herdr but predates this
    // framework's kind there.
    const kindMissing =
        HERDR_FRAMEWORKS.has(args.framework) &&
        !args.hostHerdrFrameworks.some((f) => f === args.framework)
    if (onSandbox && (!args.sandboxCanOpenInHerdr || kindMissing))
        return {
            offered: true,
            available: false,
            blocked: args.sandboxCliUpdateAvailable
                ? 'sandbox-cli-needs-upgrade'
                : 'sandbox-cli-needs-release'
        }
    if (onDaemon && kindMissing)
        return {
            offered: true,
            available: false,
            blocked: 'daemon-needs-upgrade'
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
        case 'agent-unavailable':
            return t('web.terminal.unavailableAgent')
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
        case 'sandbox-cli-needs-upgrade':
            return t('web.sessionView.herdrNeedsSandboxCliUpgrade')
        case 'sandbox-cli-needs-release':
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
