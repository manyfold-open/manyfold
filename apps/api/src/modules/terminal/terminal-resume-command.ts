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

   `needsModelCredentials` is the asymmetry between the two supported ones.
   Codex logs in on the sprite at bootstrap (`codex login --with-api-key`,
   bootstrap/codex.ts) and its auth lives in the real ~/.codex, which a plain
   login shell reads — so its TUI is already authenticated. Claude's platform
   credentials are injected per exec and never touch the sandbox disk, so its
   TUI has nothing to authenticate with unless the sandbox opted in. */
interface FrameworkResumePolicy {
    fullAccessFlag: string
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
        needsModelCredentials: false
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
    return [...argv, policy.fullAccessFlag]
}
