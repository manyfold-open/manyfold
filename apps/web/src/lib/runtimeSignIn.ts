import { isConfigurableFramework } from '@manyfold/shared'
import type { AgentFramework, AgentModelConfigView } from '@manyfold/shared'

// The chat sign-in card shows while a runtime-local agent has no usable CLI
// sign-in on its runtime. A null runtimeLocal block means no probe has run
// yet — the card still shows, and its mount refresh fills the status in.
export const shouldShowRuntimeSignIn = (
    view: Pick<
        AgentModelConfigView,
        'framework' | 'source' | 'runtimeLocal'
    > | null
): boolean => {
    if (!view) return false
    if (!isConfigurableFramework(view.framework)) return false
    if (view.source !== 'runtime-local') return false
    return view.runtimeLocal?.ready !== true
}

// The `cat |` is load-bearing, not a copy-paste artefact. Seen on a macOS
// pty with claude 2.1.259 [2026-09-09]: `claude auth login` does consume
// what you type at its "Paste code here if prompted >" prompt — it answers
// "Invalid code" — but emits zero echo bytes for it, while `sh read` and
// node's own readline echo normally in the same pty. The code therefore had
// to be pasted into a terminal that looked dead. Giving the tty to `cat`
// instead leaves claude reading a pipe it cannot silence, so the kernel
// echoes again and the line still arrives. `cat` then outlives claude until
// one more keystroke breaks the pipe; the panel already asks the user to
// close the terminal once signed in, so that tail is not in the way.
const CLAUDE_SIGN_IN_COMMAND = 'cat | claude auth login --claudeai'

// The CLI's own sign-in, phrased for a terminal without a local browser:
// claude's auth subcommand prints the URL and takes the pasted code (older
// builds without it: run `claude` and type /login); codex needs the
// device-code flow because its standard login listens on localhost:1455;
// gemini's NO_BROWSER flow prints the URL instead of spawning a browser.
// Only claude carries the workaround. codex's device code is approved in a
// browser and never typed back; gemini prompts from inside its own TUI,
// which draws what you type. Neither was reproduced losing an echo, so
// neither is wrapped.
export const runtimeSignInCommandFor = (
    framework: AgentFramework
): string | null => {
    if (framework === 'claude-code') return CLAUDE_SIGN_IN_COMMAND
    if (framework === 'codex') return 'codex login --device-auth'
    if (framework === 'gemini-cli') return 'NO_BROWSER=true gemini'
    return null
}
