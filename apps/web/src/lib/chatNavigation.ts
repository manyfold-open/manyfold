const lastChatLocationStorageKey = 'nca.web.lastChatLocation'

export interface LastChatLocation {
    path: string
    agentId: string | null
    agentName: string | null
}

// The stored value grew from a bare path string to a record so back links can
// name the agent they return to ("← Back to adventurous-mayfly-2095"). Values
// written by older builds are still bare strings, so reads normalize both.
export const storeLastChatLocation = (record: LastChatLocation): void => {
    if (typeof window === 'undefined') return

    if (!record.path.startsWith('/agents/')) return

    try {
        window.localStorage.setItem(
            lastChatLocationStorageKey,
            JSON.stringify(record)
        )
    } catch {
        // Ignore storage failures and fall back to default routing.
    }
}

export const readLastChatLocationRecord = (): LastChatLocation | null => {
    if (typeof window === 'undefined') return null

    try {
        const raw = window.localStorage.getItem(lastChatLocationStorageKey)
        if (!raw) return null
        if (raw.startsWith('/agents/'))
            return { path: raw, agentId: null, agentName: null }
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null) return null
        const { path, agentId, agentName } = parsed as Record<string, unknown>
        if (typeof path !== 'string' || !path.startsWith('/agents/'))
            return null
        return {
            path,
            agentId: typeof agentId === 'string' ? agentId : null,
            agentName: typeof agentName === 'string' ? agentName : null
        }
    } catch {
        return null
    }
}
