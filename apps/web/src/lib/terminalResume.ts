import { isConfigurableFramework } from '@manyfold/shared'
import type {
    AgentFramework,
    AgentModelConfigSource,
    AgentRuntime
} from '@manyfold/shared'

/* Which frameworks can be pointed at an existing chat session, and which of
   them needs the sandbox's model-credential opt-in to authenticate once the
   TUI is up. Mirrors apps/api/src/modules/terminal/terminal-resume-command.ts
   — the API builds the actual argv; this only decides what the UI offers and
   what it says when it cannot.

   gemini-cli is absent because its --resume takes a session index or the
   literal "latest", not the id we store, so there is nothing to point it at.
   codex needs no credential opt-in: it logs in on the sandbox at bootstrap
   and its auth lives on disk where a login shell reads it. */
const RESUME_SUPPORT: Partial<
    Record<AgentFramework, { needsModelCredentials: boolean }>
> = {
    'claude-code': { needsModelCredentials: true },
    codex: { needsModelCredentials: false }
}

export type TerminalResumeBlocked =
    | 'runtime-unsupported'
    | 'daemon-needs-upgrade'
    | 'framework-unsupported'
    | 'no-session-ref'
    | 'needs-credential-toggle'
    | 'needs-runtime-signin'

export interface TerminalResumeAvailability {
    available: boolean
    blocked: TerminalResumeBlocked | null
}

export const terminalResumeAvailability = (args: {
    framework: AgentFramework
    runtime: AgentRuntime
    // Daemons older than DAEMON_FEATURE_PTY_COMMAND drop the command and open
    // a plain shell, so the control is withheld rather than shown lying.
    daemonCanResume: boolean
    // chat_sessions.framework_session_ref — null until the first turn has
    // told us what the CLI called its own session.
    frameworkSessionRef: string | null
    modelSource: AgentModelConfigSource | null
    runtimeLocalReady: boolean
    sandboxModelCredentials: boolean
}): TerminalResumeAvailability => {
    if (args.runtime !== 'sprites' && args.runtime !== 'daemon')
        return { available: false, blocked: 'runtime-unsupported' }
    const support = RESUME_SUPPORT[args.framework]
    if (!support) return { available: false, blocked: 'framework-unsupported' }
    if (args.runtime === 'daemon' && !args.daemonCanResume)
        return { available: false, blocked: 'daemon-needs-upgrade' }
    if (!args.frameworkSessionRef?.trim())
        return { available: false, blocked: 'no-session-ref' }

    if (!support.needsModelCredentials)
        return { available: true, blocked: null }

    // Runtime-local agents authenticate from the CLI's own on-disk sign-in,
    // which is the same credential the TUI will find — so they need no opt-in,
    // but they do need that sign-in to exist.
    if (
        isConfigurableFramework(args.framework) &&
        args.modelSource === 'runtime-local'
    )
        return args.runtimeLocalReady
            ? { available: true, blocked: null }
            : { available: false, blocked: 'needs-runtime-signin' }

    // Platform-mode daemon: the sign-in on the user's own machine is what the
    // TUI will use, and there is no probe for it — but nothing has to be handed
    // over either, so there is no consent to ask for. Worst case the CLI asks
    // them to log in, on their own computer.
    if (args.runtime === 'daemon') return { available: true, blocked: null }

    return args.sandboxModelCredentials
        ? { available: true, blocked: null }
        : { available: false, blocked: 'needs-credential-toggle' }
}
