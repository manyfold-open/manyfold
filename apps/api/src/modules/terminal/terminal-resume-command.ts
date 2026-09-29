import { frameworkResumeArgv } from '@manyfold/shared'
import type { AgentFramework } from '@manyfold/shared'

/* Whether a framework's interactive TUI can be pointed at an existing chat
   session, and what it needs to authenticate once it is there.

   The command itself is `frameworkResumeArgv` in @manyfold/shared, because the
   web session list offers the same command to copy. What lives here is the
   part that is only true of US running it: each framework's full-access flag.
   The user is dropping into the TUI to continue a conversation on a runtime
   that is already the trust boundary (their own daemon machine, or an
   externally-sandboxed sprite), so per-action approval prompts only get in the
   way. These are the same flags the chat adapters already use for the bypass
   permission mode (codex.adapter.ts applyCodexPermissionMode). A COPIED
   command deliberately omits them — it runs wherever it is pasted, where no
   such trust boundary is established.

   pi has no per-action approval prompts, so it carries no such flag (it only
   asks whether to trust a workspace's own files, which the resume service
   answers the way the turns do); like claude its key rides each exec and
   never touches the sandbox disk. So does agy's, on the platform view its
   turns run on (antigravity-app-dir.ts).

   `needsModelCredentials`: every one of these CLIs gets its platform
   credentials per exec and none is logged in on the machine, so a TUI has
   nothing to authenticate with unless the sandbox opted in to handing them
   to the terminal. */
interface FrameworkResumePolicy {
    fullAccessFlag?: string
    needsModelCredentials: boolean
}

const RESUME_POLICY_BY_FRAMEWORK: Partial<
    Record<AgentFramework, FrameworkResumePolicy>
> = {
    'claude-code': {
        fullAccessFlag: '--dangerously-skip-permissions',
        needsModelCredentials: true
    },
    codex: {
        fullAccessFlag: '--dangerously-bypass-approvals-and-sandbox',
        needsModelCredentials: true
    },
    pi: { needsModelCredentials: true },
    'antigravity-cli': {
        fullAccessFlag: '--dangerously-skip-permissions',
        needsModelCredentials: true
    }
}

export const frameworkSupportsTerminalResume = (
    framework: AgentFramework
): boolean => Boolean(RESUME_POLICY_BY_FRAMEWORK[framework])

export const terminalResumeNeedsModelCredentials = (
    framework: AgentFramework
): boolean =>
    RESUME_POLICY_BY_FRAMEWORK[framework]?.needsModelCredentials === true

export const terminalResumeCommand = (
    framework: AgentFramework,
    sessionRef: string
): string[] | null => {
    const policy = RESUME_POLICY_BY_FRAMEWORK[framework]
    if (!policy) return null
    const argv = frameworkResumeArgv(framework, sessionRef)
    if (!argv) return null
    return policy.fullAccessFlag ? [...argv, policy.fullAccessFlag] : argv
}
