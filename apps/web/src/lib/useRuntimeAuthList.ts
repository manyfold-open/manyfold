import { useCallback, useEffect, useState } from 'react'
import type { RuntimeAuthListView } from '@manyfold/shared'
import { useApiClient } from '@/lib/apiClient'
import { apiErrorMessage } from '@/lib/errorMessage'

// The runtime's auth profiles for one surface. Loads when a runtime id
// arrives, reloads on demand, and forgets everything when the id goes away
// (the wizard switching runtimes must not show the previous list).
export const useRuntimeAuthList = (
    runtimeId: string | null
): {
    list: RuntimeAuthListView | null
    loading: boolean
    error: string | null
    reload: () => Promise<RuntimeAuthListView | null>
} => {
    const client = useApiClient()
    const [list, setList] = useState<RuntimeAuthListView | null>(null)
    const [loading, setLoading] = useState(false)
    const [error, setError] = useState<string | null>(null)

    const reload =
        useCallback(async (): Promise<RuntimeAuthListView | null> => {
            if (!runtimeId) return null
            setLoading(true)
            setError(null)
            try {
                const next = await client.runtimeAuth.list(runtimeId)
                setList(next)
                return next
            } catch (e) {
                setError(apiErrorMessage(e))
                return null
            } finally {
                setLoading(false)
            }
        }, [client, runtimeId])

    useEffect(() => {
        setList(null)
        setError(null)
        if (!runtimeId) return
        let cancelled = false
        setLoading(true)
        client.runtimeAuth
            .list(runtimeId)
            .then((next) => {
                if (!cancelled) setList(next)
            })
            .catch((e) => {
                if (!cancelled) setError(apiErrorMessage(e))
            })
            .finally(() => {
                if (!cancelled) setLoading(false)
            })
        return (): void => {
            cancelled = true
        }
    }, [client, runtimeId])

    return { list, loading, error, reload }
}
