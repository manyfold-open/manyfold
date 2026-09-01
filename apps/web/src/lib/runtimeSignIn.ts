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

// The CLI's own sign-in, phrased for a terminal without a local browser:
// claude prints a URL from /login and takes a pasted code; codex needs the
// device-code flow because its standard login listens on localhost:1455;
// gemini's NO_BROWSER flow prints the URL instead of spawning a browser.
export const runtimeSignInCommandFor = (
    framework: AgentFramework
): string | null => {
    if (framework === 'claude-code') return 'claude'
    if (framework === 'codex') return 'codex login --device-auth'
    if (framework === 'gemini-cli') return 'NO_BROWSER=true gemini'
    return null
}
