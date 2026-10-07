import type { ApiTokenSummary } from '@manyfold/shared'
import { useCallback, useMemo, useState } from 'react'
import { useShellPolling } from '@/hooks/useShellPolling'
import {
    summarizeAgentConnection,
    type AgentConnectionSummary
} from '@/lib/agentConnection'
import { useApiClient } from '@/lib/apiClient'

const IDLE_POLL_MS = 30_000
// While the setup dialog waits for the sign-in, a 30s poll would leave the
// user staring at a spinner long after they approved it.
const WAITING_POLL_MS = 3_000

export interface AgentConnection {
    // Null until the first list arrives: the chip stays hidden rather than
    // guessing "not connected".
    summary: AgentConnectionSummary | null
    refresh: () => Promise<void>
    disconnect: () => Promise<void>
}

export const useAgentConnection = (waiting: boolean): AgentConnection => {
    const client = useApiClient()
    const [tokens, setTokens] = useState<ApiTokenSummary[] | null>(null)
    const [checkedAt, setCheckedAt] = useState(0)

    const refresh = useCallback(async (): Promise<void> => {
        try {
            setTokens(await client.apiTokens.list())
        } catch {
            // Keep the last good list through a blip; a list that never loads
            // leaves the chip hidden.
        }
        setCheckedAt(Date.now())
    }, [client])

    useShellPolling(refresh, waiting ? WAITING_POLL_MS : IDLE_POLL_MS)

    const summary = useMemo(
        () =>
            tokens ? summarizeAgentConnection(tokens, new Date(checkedAt)) : null,
        [tokens, checkedAt]
    )

    const disconnect = useCallback(async (): Promise<void> => {
        if (!summary) return
        try {
            await Promise.all(
                summary.signIns.map((token) => client.apiTokens.revoke(token.id))
            )
        } finally {
            await refresh()
        }
    }, [client, refresh, summary])

    return { summary, refresh, disconnect }
}
