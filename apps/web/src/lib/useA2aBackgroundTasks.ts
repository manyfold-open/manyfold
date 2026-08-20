import type { A2aTaskTraceItem } from '@manyfold/shared'
import { useEffect, useMemo, useState } from 'react'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'
import { isTerminalA2aState } from '@/lib/a2aTaskState'

const POLL_MS = 4000

export interface UseA2aBackgroundTasksResult {
    running: A2aTaskTraceItem[]
    finished: A2aTaskTraceItem[]
    loading: boolean
    error: string | null
}

// Polls the current agent's A2A task trace while the panel is open and the
// tab is visible. A separate 1s ticker re-renders the consumer so running
// rows show live elapsed time. usageJson (tokens/cost) only lands on the
// terminal update, so running rows have no token count yet — by design.
export const useA2aBackgroundTasks = (
    agentId: string | null,
    options: { enabled: boolean }
): UseA2aBackgroundTasksResult => {
    const { enabled } = options
    const client = useApiClient()
    const [tasks, setTasks] = useState<A2aTaskTraceItem[]>([])
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)
    const [, setTick] = useState(0)

    const active = enabled && Boolean(agentId)

    useEffect(() => {
        if (!active || !agentId) {
            setTasks([])
            setError(null)
            return
        }
        let cancelled = false
        const load = async (): Promise<void> => {
            try {
                const page = await client.a2a.listTasks(agentId)
                if (cancelled) return
                setTasks(page.tasks)
                setError(null)
            } catch (err) {
                if (cancelled) return
                setError(apiErrorMessage(err))
            } finally {
                if (!cancelled) setLoading(false)
            }
        }
        setLoading(true)
        void load()
        const poll = window.setInterval(() => {
            if (!document.hidden) void load()
        }, POLL_MS)
        return (): void => {
            cancelled = true
            window.clearInterval(poll)
        }
    }, [active, agentId, client])

    const running = useMemo(
        () => tasks.filter((task) => !isTerminalA2aState(task.state)),
        [tasks]
    )
    const finished = useMemo(
        () => tasks.filter((task) => isTerminalA2aState(task.state)),
        [tasks]
    )

    useEffect(() => {
        if (!active || running.length === 0) return
        const ticker = window.setInterval(
            () => setTick((value) => value + 1),
            1000
        )
        return (): void => window.clearInterval(ticker)
    }, [active, running.length])

    return { running, finished, loading, error }
}