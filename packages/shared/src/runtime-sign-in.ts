import type { AgentFramework } from './constants'

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
// neither is wrapped. pi has no login subcommand either: its TUI's /login
// picks the provider and runs that provider's flow. agy signs in the first
// time its TUI starts without one ("Launch the CLI without arguments to sign
// in", as `agy models` puts it) and, with no browser to open, prints the link.
export const runtimeSignInCommandFor = (
    framework: AgentFramework
): string | null => {
    if (framework === 'claude-code') return CLAUDE_SIGN_IN_COMMAND
    if (framework === 'codex') return 'codex login --device-auth'
    if (framework === 'gemini-cli') return 'NO_BROWSER=true gemini'
    if (framework === 'pi') return 'pi'
    if (framework === 'antigravity-cli') return 'agy'
    return null
}
