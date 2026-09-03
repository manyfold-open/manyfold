import type { AgentFramework } from '@manyfold/shared'

/* Whether a framework's interactive TUI can be pointed at an existing chat
   session, and what it needs to authenticate once it is there.

   The commands are the CLIs' own documented interactive-resume forms:
     claude --resume <id>   resumes a conversation by session id
     codex resume <id>      "Resume a previous interactive session"
   gemini is absent on purpose: its --resume takes a session INDEX or the
   literal "latest", not the UUID we store in framework_session_ref, so
   there is nothing to point it at.

   Each carries its framework's full-access flag: the user is dropping into
   the TUI to continue a conversation on a runtime that is already the trust
   boundary (their own daemon machine, or an externally-sandboxed sprite), so
   per-action approval prompts only get in the way. These are the same flags
   the chat adapters already use for the bypass permission mode
   (codex.adapter.ts applyCodexPermissionMode).

   `needsModelCredentials` is the asymmetry between the two supported ones.
   Codex logs in on the sprite at bootstrap (`codex login --with-api-key`,
   bootstrap/codex.ts) and its auth lives in the real ~/.codex, which a plain
   login shell reads — so its TUI is already authenticated. Claude's platform
   credentials are injected per exec and never touch the sandbox disk, so its
   TUI has nothing to authenticate with unless the sandbox opted in. */
interface FrameworkResume {
    command: (sessionRef: string) => string[]
    needsModelCredentials: boolean
}

const RESUME_BY_FRAMEWORK: Partial<Record<AgentFramework, FrameworkResume>> = {
    'claude-code': {
        command: (ref) => [
            'claude',
            '--resume',
            ref,
            '--dangerously-skip-permissions'
        ],
        needsModelCredentials: true
    },
    codex: {
        command: (ref) => [
            'codex',
            'resume',
            ref,
            '--dangerously-bypass-approvals-and-sandbox'
        ],
        needsModelCredentials: false
    }
}

export const frameworkSupportsTerminalResume = (
    framework: AgentFramework
): boolean => Boolean(RESUME_BY_FRAMEWORK[framework])

export const terminalResumeNeedsModelCredentials = (
    framework: AgentFramework
): boolean => RESUME_BY_FRAMEWORK[framework]?.needsModelCredentials === true

export const terminalResumeCommand = (
    framework: AgentFramework,
    sessionRef: string
): string[] | null => {
    const ref = sessionRef.trim()
    if (!ref) return null
    return RESUME_BY_FRAMEWORK[framework]?.command(ref) ?? null
}
