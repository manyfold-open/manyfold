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
    if (onSandbox && !args.sandboxCanOpenInHerdr)
        return {
            offered: true,
            available: false,
            blocked: 'sandbox-runner-needs-upgrade'
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
        case 'needs-credential-toggle':
            return t('web.sessionView.herdrNeedsCredentials')
        default:
            return null
    }
}
