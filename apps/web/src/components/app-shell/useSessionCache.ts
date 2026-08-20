import type { ChatSessionSummary } from '@manyfold/shared'
import { useCallback, useState } from 'react'
import type { NcaClient } from '@manyfold/sdk'
import { sortSessionsByActivity } from '@/lib/chatAgents'

export type SessionsByAgent = Record<string, ChatSessionSummary[]>
export type SessionLoadingByAgent = Record<string, boolean>
export type SessionErrorByAgent = Record<string, string | null>

const hasOwn = (value: object, key: string): boolean =>
    Object.prototype.hasOwnProperty.call(value, key)

const filterRecordToIds = <T>(
    value: Record<string, T>,
    validIds: Set<string>
): Record<string, T> =>
    Object.fromEntries(
        Object.entries(value).filter(([agentId]) => validIds.has(agentId))
    )

export interface SessionCache {
    ensureSessionsForAgent: (agentId: string) => void
    pruneSessionCacheToAgentIds: (agentIds: readonly string[]) => void
    refreshSessionsForAgent: (agentId: string) => Promise<ChatSessionSummary[]>
    sessionErrorByAgent: SessionErrorByAgent
    sessionLoadingByAgent: SessionLoadingByAgent
    sessionsByAgent: SessionsByAgent
}

export const useSessionCache = (client: NcaClient): SessionCache => {
    const [sessionsByAgent, setSessionsByAgent] = useState<SessionsByAgent>({})
    const [sessionLoadingByAgent, setSessionLoadingByAgent] =
        useState<SessionLoadingByAgent>({})
    const [sessionErrorByAgent, setSessionErrorByAgent] =
        useState<SessionErrorByAgent>({})

    const refreshSessionsForAgent = useCallback(
        async (agentId: string): Promise<ChatSessionSummary[]> => {
            setSessionLoadingByAgent((prev) => ({
                ...prev,
                [agentId]: true
            }))
            setSessionErrorByAgent((prev) => ({
                ...prev,
                [agentId]: null
            }))
            try {
                const rows = sortSessionsByActivity(
                    await client.chat.listSessions(agentId)
                )
                setSessionsByAgent((prev) => ({
                    ...prev,
                    [agentId]: rows
                }))
                return rows
            } catch (err) {
                setSessionErrorByAgent((prev) => ({
                    ...prev,
                    [agentId]: (err as Error).message
                }))
                setSessionsByAgent((prev) => ({
                    ...prev,
                    [agentId]: []
                }))
                return []
            } finally {
                setSessionLoadingByAgent((prev) => ({
                    ...prev,
                    [agentId]: false
                }))
            }
        },
        [client]
    )

    const sessionsFetchedForAgent = useCallback(
        (agentId: string): boolean =>
            hasOwn(sessionsByAgent, agentId) ||
            hasOwn(sessionErrorByAgent, agentId),
        [sessionErrorByAgent, sessionsByAgent]
    )

    const ensureSessionsForAgent = useCallback(
        (agentId: string): void => {
            if (sessionLoadingByAgent[agentId]) return
            if (sessionsFetchedForAgent(agentId)) return
            void refreshSessionsForAgent(agentId)
        },
        [
            refreshSessionsForAgent,
            sessionLoadingByAgent,
            sessionsFetchedForAgent
        ]
    )

    const pruneSessionCacheToAgentIds = useCallback(
        (agentIds: readonly string[]): void => {
            const validIds = new Set(agentIds)
            setSessionsByAgent((prev) => filterRecordToIds(prev, validIds))
            setSessionLoadingByAgent((prev) =>
                filterRecordToIds(prev, validIds)
            )
            setSessionErrorByAgent((prev) => filterRecordToIds(prev, validIds))
        },
        []
    )

    return {
        ensureSessionsForAgent,
        pruneSessionCacheToAgentIds,
        refreshSessionsForAgent,
        sessionErrorByAgent,
        sessionLoadingByAgent,
        sessionsByAgent
    }
}
