const storageKey = 'nca.web.envPendingRestart'

export interface EnvPendingRestart {
    // Server time of the save, so a restart afterwards clears it.
    savedAt: number
    // Which variables changed, so the section can mark the exact rows.
    keys: string[]
}

type Store = Record<string, EnvPendingRestart>

// Environment edits on a service framework only reach the process after a
// restart. That used to be a one-shot dialog offered right after saving: choose
// "Later" and the fact was gone, leaving an agent running values that no longer
// matched what the page displayed. The obligation is now durable state, held
// per agent until a restart actually happens.
//
// The fact lives client-side because the API does not yet report when env was
// last applied (see the spec's open questions). That has one honest limit — the
// mark does not follow you to another browser — but it self-corrects rather
// than lying: any restart, from this page or elsewhere, stamps the agent's
// `startedAt` past the mark and clears it. Both timestamps are the server's for
// exactly that reason.
const read = (): Store => {
    if (typeof window === 'undefined') return {}
    try {
        const raw = window.localStorage.getItem(storageKey)
        if (!raw) return {}
        const parsed: unknown = JSON.parse(raw)
        if (typeof parsed !== 'object' || parsed === null) return {}
        return parsed as Store
    } catch {
        return {}
    }
}

const write = (store: Store): void => {
    if (typeof window === 'undefined') return
    try {
        window.localStorage.setItem(storageKey, JSON.stringify(store))
    } catch {
        // A full or blocked storage only costs the reminder, not the edit.
    }
}

// `savedAt` must be the server's own timestamp for the save, because the only
// thing it is ever compared against is a server timestamp (`startedAt`). A
// client clock is free to disagree with both, which would either clear the mark
// on sight or never clear it.
export const markEnvPendingRestart = (
    agentId: string,
    keys: string[],
    savedAt: number
): void => {
    const store = read()
    const existing = store[agentId]
    // Successive edits accumulate: two saves before one restart leave both
    // sets of keys pending.
    const merged = existing
        ? [...new Set([...existing.keys, ...keys])]
        : [...new Set(keys)]
    store[agentId] = { savedAt, keys: merged }
    write(store)
}

export const clearEnvPendingRestart = (agentId: string): void => {
    const store = read()
    if (!(agentId in store)) return
    delete store[agentId]
    write(store)
}

// `startedAt` is the agent's own account of when it last came up, stamped by the
// restart itself. If that is at or after the mark the values are already live,
// whatever restarted it — this page, the CLI, another browser.
export const readEnvPendingRestart = (
    agentId: string,
    startedAt: string | null
): EnvPendingRestart | null => {
    const entry = read()[agentId]
    if (!entry) return null
    if (startedAt) {
        const started = Date.parse(startedAt)
        if (Number.isFinite(started) && started >= entry.savedAt) {
            clearEnvPendingRestart(agentId)
            return null
        }
    }
    return entry
}
