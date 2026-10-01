import type { SdkAgent } from '@manyfold/sdk'

// The frameworks whose CLI keeps a transcript a terminal TUI writes to, which
// the chat pulls in after a terminal session.
const SYNCABLE_FRAMEWORKS: ReadonlySet<string> = new Set([
    'claude-code',
    'codex',
    'pi',
    'antigravity-cli'
])

export const canSyncRuntimeSession = (
    agent: Pick<SdkAgent, 'framework' | 'runtime'> | null | undefined
): boolean =>
    !!agent &&
    SYNCABLE_FRAMEWORKS.has(agent.framework) &&
    agent.runtime !== 'external'

// What the session-open sync is keyed on: one sync per session opened, once
// its first page has loaded. Never the agent object itself, which every
// power update rebuilds.
// Seen on staging [2026-09-30]: keyed on the object, the sync woke the
// sandbox, the wake's power update re-ran it once the sandbox slept again,
// and an open page held the sandbox in that loop (42 wakes in 25 minutes).
export const runtimeSyncOpenKey = (
    agent: Pick<SdkAgent, 'id' | 'framework' | 'runtime'> | null | undefined,
    sessionId: string | null,
    loadedSessionId: string | null
): string | null =>
    agent &&
    canSyncRuntimeSession(agent) &&
    sessionId &&
    loadedSessionId === sessionId
        ? `${agent.id}:${sessionId}`
        : null
