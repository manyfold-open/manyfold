import { isModelConfigFramework } from '@manyfold/shared'
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
    if (!isModelConfigFramework(view.framework)) return false
    if (view.source !== 'runtime-local') return false
    return view.runtimeLocal?.ready !== true
}

export const runtimeSignInHintKey = (framework: AgentFramework): string =>
    framework === 'claude-code'
        ? 'web.chat.runtimeSignIn.claudeHint'
        : framework === 'codex'
          ? 'web.chat.runtimeSignIn.codexHint'
          : framework === 'pi'
            ? 'web.chat.runtimeSignIn.piHint'
            : framework === 'antigravity-cli'
              ? 'web.chat.runtimeSignIn.antigravityHint'
              : 'web.chat.runtimeSignIn.geminiHint'
