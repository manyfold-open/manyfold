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
   header when the agent's own computer runs herdr: the daemon advertises it
   (DaemonHostSummary.canOpenInHerdr) and the handoff resumes the session
   there instead of in an embedded terminal. Machines without herdr keep the
   browser terminal and its old name, so the control is offered — with its
   herdr label — only where it can work, and the reasons it is disabled are
   the resume's own plus the two the handoff adds: no session on screen yet,
   and an agent that is not running. */

export type HerdrHandoffBlocked =
    | 'no-herdr'
    | 'agent-not-running'
    | 'no-session'
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
    sessionId: string | null
    frameworkSessionRef: string | null
    modelSource: AgentModelConfigSource | null
    runtimeLocalReady: boolean
}): HerdrHandoffAvailability => {
    if (args.runtime !== 'daemon' || !args.daemonCanOpenInHerdr)
        return { offered: false, available: false, blocked: 'no-herdr' }
    if (!args.running)
        return { offered: true, available: false, blocked: 'agent-not-running' }
    if (!args.sessionId)
        return { offered: true, available: false, blocked: 'no-session' }
    const resume = terminalResumeAvailability({
        framework: args.framework,
        runtime: args.runtime,
        daemonCanResume: args.daemonCanResume,
        frameworkSessionRef: args.frameworkSessionRef,
        modelSource: args.modelSource,
        runtimeLocalReady: args.runtimeLocalReady,
        // A daemon never needs the sandbox credential opt-in.
        sandboxModelCredentials: false
    })
    return resume.available
        ? { offered: true, available: true, blocked: null }
        : { offered: true, available: false, blocked: resume.blocked }
}

// The tooltip on the disabled control. `no-herdr` never shows (the control
// is not offered) and the sandbox-only reasons cannot occur on a daemon.
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
        default:
            return null
    }
}
