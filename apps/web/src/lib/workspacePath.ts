import type { SdkAgent } from '@manyfold/sdk'

export const workspacePathOf = (agent: SdkAgent): string => {
    const path = (agent.workspacePath || agent.mountPath || '/workspace').trim()
    return path || '/workspace'
}

// The directory's own name, for the chat header's daemon chip. A sandbox path is
// plumbing (every agent's differs only by an opaque id), but a daemon agent's
// directory says which of your projects it acts on — and the basename is the
// part that carries that, so the header shows it rather than the full path.
// Returns null when there is no meaningful name, so the caller can render
// nothing instead of an empty chip.
export const workspaceDirNameOf = (agent: SdkAgent): string | null => {
    const trimmed = workspacePathOf(agent).replace(/[/\\]+$/, '')
    const name = trimmed.split(/[/\\]/).pop()?.trim()
    return name ? name : null
}
