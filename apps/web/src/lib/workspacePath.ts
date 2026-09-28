import type { SdkAgent } from '@manyfold/sdk'

export const workspacePathOf = (agent: SdkAgent): string => {
    const path = (agent.workspacePath || agent.mountPath || '/workspace').trim()
    return path || '/workspace'
}

// The directory's own name, for the chat header's second line: the basename is
// the part that says which folder the agent acts on, so the header shows it and
// leaves the full path to the hover. Returns null when there is no meaningful
// name, so the caller can render nothing instead of an empty label.
export const workspaceDirNameOf = (agent: SdkAgent): string | null => {
    const trimmed = workspacePathOf(agent).replace(/[/\\]+$/, '')
    const name = trimmed.split(/[/\\]/).pop()?.trim()
    return name ? name : null
}
