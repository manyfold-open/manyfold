import { useCallback, useEffect } from 'react'
import {
    chatStreamStore,
    type CancelAttempt,
    useStreamSnapshot,
    type ReplayCheckpoint,
    type StreamSnapshot,
    type StartStreamParams
} from '@/lib/chatStreamStore'

export type { StreamStatus, StreamSnapshot } from '@/lib/chatStreamStore'

interface UseChatStreamParams {
    agentId: string | null
    sessionId: string | null
    enabled: boolean
    baseUrl: string
    getToken: () => Promise<string>
    onFallback?: StartStreamParams['onFallback']
    replayMessageId?: string | null
    replayCheckpoint?: ReplayCheckpoint | null
    initialLastEventId?: string | null
}

export interface UseChatStreamResult extends StreamSnapshot {
    stop: () => CancelAttempt | null
    beginAssistantTurn: (messageId: string) => void
    reconnect: () => void
}

export const useChatStream = ({
    agentId,
    sessionId,
    enabled,
    baseUrl,
    getToken,
    onFallback,
    replayMessageId,
    replayCheckpoint,
    initialLastEventId
}: UseChatStreamParams): UseChatStreamResult => {
    const key =
        agentId && sessionId ? chatStreamStore.keyOf(agentId, sessionId) : null
    const snapshot = useStreamSnapshot(key)

    useEffect(() => {
        if (!enabled || !agentId || !sessionId) return
        chatStreamStore.getOrStart({
            agentId,
            sessionId,
            baseUrl,
            getToken,
            onFallback,
            replayMessageId,
            replayCheckpoint,
            initialLastEventId
        })
        return () =>
            chatStreamStore.detachFallback(
                chatStreamStore.keyOf(agentId, sessionId),
                onFallback
            )
    }, [
        enabled,
        agentId,
        sessionId,
        baseUrl,
        getToken,
        onFallback,
        replayMessageId,
        replayCheckpoint,
        initialLastEventId
    ])

    const stop = useCallback((): CancelAttempt | null => {
        if (key) return chatStreamStore.cancel(key)
        return null
    }, [key])

    const beginAssistantTurn = useCallback(
        (messageId: string): void => {
            if (!agentId || !sessionId || !key) return
            chatStreamStore.beginAssistantTurn(
                key,
                { agentId, sessionId, baseUrl, getToken, onFallback },
                messageId
            )
        },
        [agentId, sessionId, key, baseUrl, getToken, onFallback]
    )

    return {
        ...snapshot,
        stop,
        beginAssistantTurn,
        reconnect: () => {
            if (key) chatStreamStore.reconnect(key)
        }
    }
}
